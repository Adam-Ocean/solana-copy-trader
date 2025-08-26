import EventEmitter from 'events';
import WebSocket from 'ws';
import { Connection, PublicKey, ParsedTransactionWithMeta, PartiallyDecodedInstruction } from '@solana/web3.js';
import { WalletSignal } from '../types/enhanced';

export class QuickNodeWalletMonitor extends EventEmitter {
  private ws: WebSocket | null = null;
  private connection: Connection;
  private targetWallets: Set<string>;
  private isRunning = false;
  private subscriptionIds: Map<string, number> = new Map();
  private processedSignatures: Set<string> = new Set();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private pingInterval: NodeJS.Timeout | null = null;
  private lastActivityTime = Date.now();
  private startupTimeSec = Math.floor(Date.now() / 1000);
  
  // Cached SOL price for USD conversions
  private cachedSolPriceUSD: number = 180;
  private lastSolPriceFetch = 0;
  private readonly SOL_PRICE_TTL_MS = 60_000; // 1 minute
  
  // Track trader positions for sell percentage calculation
  private traderPositions: Map<string, Map<string, number>> = new Map();

  constructor(
    private rpcUrl: string,
    targetWallets: string[]
  ) {
    super();
    this.targetWallets = new Set(targetWallets);
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    
    // Convert HTTP to WebSocket URL
    this.rpcUrl = this.rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
  }

  async connect(): Promise<void> {
    console.log('🔌 Connecting to QuickNode WebSocket...');
    console.log(`   URL: ${this.rpcUrl.substring(0, 50)}...`);
    this.isRunning = true;
    this.startupTimeSec = Math.floor(Date.now() / 1000);
    
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.rpcUrl);
        
        this.ws.on('open', () => {
          console.log('✅ Connected to QuickNode WebSocket');
          this.reconnectAttempts = 0;
          this.subscribeToWallets();
          this.startPingInterval();
          resolve();
        });
        
        this.ws.on('message', this.handleMessage.bind(this));
        this.ws.on('error', this.handleError.bind(this));
        this.ws.on('close', this.handleClose.bind(this));
        this.ws.on('pong', () => {
          this.lastActivityTime = Date.now();
        });
        
      } catch (error) {
        console.error('❌ Failed to create WebSocket:', error);
        reject(error);
      }
    });
  }

  private subscribeToWallets(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    
    // Subscribe to each wallet using multiple methods for better coverage
    for (const wallet of this.targetWallets) {
      console.log(`   Subscribing to wallet: ${wallet}`);
      
      // Method 1: logsSubscribe (for transactions mentioning the wallet)
      const logsRequest = {
        jsonrpc: '2.0',
        id: `logs_${Date.now()}`,
        method: 'logsSubscribe',
        params: [
          { mentions: [wallet] },
          { commitment: 'confirmed' }
        ]
      };
      
      this.ws.send(JSON.stringify(logsRequest));
      console.log(`   Sent logsSubscribe request`);
      
      // Method 2: accountSubscribe (for account changes)
      const accountRequest = {
        jsonrpc: '2.0',
        id: `account_${Date.now()}`,
        method: 'accountSubscribe',
        params: [
          wallet,
          { commitment: 'confirmed', encoding: 'base64' }
        ]
      };
      
      this.ws.send(JSON.stringify(accountRequest));
      console.log(`   Sent accountSubscribe request`);
    }
    
    // Polling disabled - using WebSocket only for real-time monitoring
    // this.startPollingBackup();
  }

  // Polling backup disabled - using WebSocket only for real-time monitoring
  // This was causing duplicate transactions and unnecessary RPC calls
  private startPollingBackup(): void {
    // Disabled - WebSocket provides real-time updates
    return;
  }

  private async handleMessage(data: WebSocket.Data): Promise<void> {
    try {
      const message = JSON.parse(data.toString());
      
      // Handle subscription confirmations
      if (message.result !== undefined) {
        console.log(`✅ Subscription confirmed (ID: ${message.result})`);
        this.subscriptionIds.set(message.id?.toString() || 'unknown', message.result);
        return;
      }
      
      // Handle errors
      if (message.error) {
        console.error(`❌ Subscription error:`, message.error);
        return;
      }
      
      // Handle log notifications
      if (message.method === 'logsNotification') {
        const signature = message.params?.result?.value?.signature;
        console.log(`📝 [QuickNode] Log notification received: ${signature?.substring(0, 20)}...`);
        
        if (signature && !this.processedSignatures.has(signature)) {
          // Find which wallet this relates to
          const logs = message.params?.result?.value?.logs || [];
          let relatedWallet: string | null = null;
          
          for (const wallet of this.targetWallets) {
            // Check logs for wallet mention
            const walletFound = logs.some((log: string) => log.includes(wallet));
            if (walletFound) {
              relatedWallet = wallet;
              console.log(`   Found wallet ${wallet.substring(0, 10)}... in logs`);
              break;
            }
          }
          
          if (relatedWallet) {
            console.log(`   Processing transaction for wallet...`);
            await this.processTransaction(signature, relatedWallet);
          } else {
            console.log(`   No target wallet found in logs`);
          }
        }
      }
      
      // Handle account notifications (balance changes)
      if (message.method === 'accountNotification') {
        console.log(`💰 [QuickNode] Account change detected`);
        // When account changes, check recent transactions
        for (const wallet of this.targetWallets) {
          const signatures = await this.connection.getSignaturesForAddress(
            new PublicKey(wallet),
            { limit: 3 }
          );
          
          for (const sig of signatures) {
            if (!this.processedSignatures.has(sig.signature)) {
              console.log(`   New transaction from account change: ${sig.signature.substring(0, 20)}...`);
              await this.processTransaction(sig.signature, wallet);
            }
          }
        }
      }
      
      this.lastActivityTime = Date.now();
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  private async processTransaction(signature: string, walletAddress: string): Promise<void> {
    if (this.processedSignatures.has(signature)) return;
    this.processedSignatures.add(signature);
    
    // Keep set size manageable
    if (this.processedSignatures.size > 1000) {
      const toDelete = Array.from(this.processedSignatures).slice(0, 500);
      toDelete.forEach(sig => this.processedSignatures.delete(sig));
    }
    
    try {
      console.log(`   Fetching transaction details...`);
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0
      });
      
      if (!tx || !tx.meta) {
        console.log(`   No transaction data found`);
        return;
      }
      // Ignore historical transactions prior to startup to avoid backfills triggering signals
      const blockTime = (tx as any).blockTime;
      if (typeof blockTime === 'number' && blockTime < this.startupTimeSec) {
        // Skip old tx; mark as processed so we don't revisit
        console.log(`   Skipping historical tx (${signature.substring(0, 12)}...) at ${blockTime}`);
        return;
      }
      
      // Check if this is a swap transaction
      const signal = await this.parseSwapTransaction(tx, walletAddress, signature);
      if (signal) {
        console.log(`\n🎯 [QuickNode] ${signal.action.toUpperCase()} Signal Detected:`);
        console.log(`   Token: ${signal.tokenSymbol || signal.token.substring(0, 8)}`);
        console.log(`   Token Amount: ${signal.amount.toFixed(4)} ${signal.tokenSymbol || 'tokens'}`);
        console.log(`   SOL Amount: ${signal.solAmount.toFixed(4)} SOL`);
        console.log(`   Price: $${signal.price.toFixed(6)}`);
        console.log(`   Signature: ${signature.substring(0, 20)}...`);
        
        this.emit('signal', signal);
      } else {
        console.log(`   Not a swap transaction or parsing failed`);
      }
    } catch (error) {
      console.log(`   Error processing: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async parseSwapTransaction(
    tx: ParsedTransactionWithMeta,
    walletAddress: string,
    signature: string
  ): Promise<WalletSignal | null> {
    try {
      const instructions = tx.transaction.message.instructions;
      
      // Common DEX program IDs
      const DEX_PROGRAMS = [
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
        'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter v4
        'JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph', // Jupiter v3
        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
        'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Whirlpool
        'EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S', // Lifinity
        'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', // Phoenix
        'HyaB3W9q6XdA5xwpU4XnSZV94htfmbmqJXZcEbRaJutt', // Orca Whirlpool
      ];
      
      // Check if this is a swap transaction
      let isSwap = false;
      let swapProgram = '';
      
      for (const ix of instructions) {
        const programId = ix.programId.toString();
        
        // Check against known DEX programs
        if (DEX_PROGRAMS.some(dex => programId === dex)) {
          isSwap = true;
          swapProgram = programId.substring(0, 8);
          console.log(`   Swap detected on program: ${swapProgram}...`);
          break;
        }
        
        // Also check for partial matches for newer versions
        if (programId.includes('JUP') || programId.includes('675kPX9') || programId.includes('whirL')) {
          isSwap = true;
          swapProgram = programId.substring(0, 8);
          console.log(`   Swap detected (partial match): ${swapProgram}...`);
          break;
        }
      }
      
      if (!isSwap) {
        // Also check if there are token balance changes (might be a new DEX)
        const hasTokenChanges = tx.meta?.postTokenBalances && tx.meta.postTokenBalances.length > 0;
        if (hasTokenChanges) {
          console.log(`   Has token balance changes, checking for swap...`);
        } else {
          return null;
        }
      }
      
      // Parse pre and post token balances
      const preBalances = tx.meta?.preTokenBalances || [];
      const postBalances = tx.meta?.postTokenBalances || [];
      
      // Find token changes for the wallet
      let tokenMint: string | null = null;
      let tokenChange = 0;
      let solChange = 0;
      
      // Calculate SOL change - look for WSOL changes first
      const WSOL_MINT = 'So11111111111111111111111111111111111111112';
      let wsolChange = 0;
      
      // Find token changes including WSOL
      const tokenChanges = [];
      for (const postBalance of postBalances) {
        if (postBalance.owner === walletAddress) {
          const preBalance = preBalances.find(
            pb => pb.accountIndex === postBalance.accountIndex
          );
          
          const preAmount = preBalance?.uiTokenAmount?.uiAmount || 0;
          const postAmount = postBalance.uiTokenAmount?.uiAmount || 0;
          const change = postAmount - preAmount;
          
          if (Math.abs(change) > 0.0001) {
            if (postBalance.mint === WSOL_MINT) {
              wsolChange = change;
              console.log(`   WSOL change: ${change.toFixed(4)} SOL`);
            } else {
              tokenMint = postBalance.mint;
              tokenChange = change;
              console.log(`   Token change: ${change.toFixed(4)} tokens`);
              console.log(`   Token mint: ${tokenMint}`);
            }
            tokenChanges.push({ mint: postBalance.mint, change });
          }
        }
      }
      
      // Calculate actual SOL amount used in swap
      if (wsolChange !== 0) {
        // If WSOL changed, use that as the SOL amount (more accurate for swaps)
        solChange = -wsolChange; // Negative wsolChange means SOL was spent (buy)
        console.log(`   Actual SOL in swap: ${Math.abs(solChange).toFixed(4)} SOL`);
      } else {
        // Fallback to balance change if no WSOL movement
        const walletIndex = tx.transaction.message.accountKeys.findIndex(
          key => key.pubkey.toString() === walletAddress
        );
        
        if (walletIndex >= 0 && tx.meta) {
          const preSol = tx.meta.preBalances[walletIndex] / 1e9;
          const postSol = tx.meta.postBalances[walletIndex] / 1e9;
          solChange = postSol - preSol;
        }
        console.log(`   SOL balance change: ${solChange.toFixed(4)} SOL`);
      }
      
      if (!tokenMint) return null;
      
      // Determine if buy or sell based on token change
      const isBuy = tokenChange > 0;
      const action = isBuy ? 'buy' : 'sell';
      
      // Make sure solChange is positive (absolute value for the amount)
      solChange = Math.abs(solChange);
      
      // Get token metadata
      let tokenSymbol = 'Unknown';
      let tokenName = 'Unknown Token';
      
      // Try to get token info from Birdeye
      try {
        console.log(`   Fetching token metadata from Birdeye...`);
        const response = await fetch(
          `https://public-api.birdeye.so/defi/token_overview?address=${tokenMint}`,
          {
            headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY || '637c43ce566444169ee539319322ac35' }
          }
        );
        
        if (response.ok) {
          const data = await response.json() as any;
          if (data?.data) {
            tokenSymbol = data.data.symbol || tokenMint.substring(0, 6);
            tokenName = data.data.name || tokenMint;
            console.log(`   Token: ${tokenSymbol} (${tokenName})`);
          }
        } else {
          console.log(`   Birdeye metadata failed, using mint address`);
          tokenSymbol = tokenMint.substring(0, 6);
          tokenName = tokenMint;
        }
      } catch (error) {
        console.log(`   Error fetching metadata: ${error instanceof Error ? error.message : error}`);
        tokenSymbol = tokenMint.substring(0, 6);
        tokenName = tokenMint;
      }
      
      // Update trader positions
      if (!this.traderPositions.has(walletAddress)) {
        this.traderPositions.set(walletAddress, new Map());
      }
      const positions = this.traderPositions.get(walletAddress)!;
      
      if (isBuy) {
        const currentAmount = positions.get(tokenMint) || 0;
        positions.set(tokenMint, currentAmount + Math.abs(tokenChange));
      } else {
        const currentAmount = positions.get(tokenMint) || 0;
        const newAmount = Math.max(0, currentAmount - Math.abs(tokenChange));
        if (newAmount === 0) {
          positions.delete(tokenMint);
        } else {
          positions.set(tokenMint, newAmount);
        }
      }
      
      // Calculate price properly (solChange is already absolute)
      const solAmount = solChange;
      const tokenAmount = Math.abs(tokenChange);
      
      // Get current SOL price from environment or use default
      const solPriceUSD = await this.getSolPriceUSD();
      
      // Calculate token price in USD
      const tokenPriceUSD = tokenAmount > 0 ? (solAmount * solPriceUSD) / tokenAmount : 0;
      
      console.log(`   Trade: ${action} ${tokenAmount.toFixed(4)} tokens for ${solAmount.toFixed(4)} SOL`);
      console.log(`   Token price: $${tokenPriceUSD.toFixed(6)} per token`);
      
      const signal: WalletSignal = {
        wallet: walletAddress,
        action: action as 'buy' | 'sell',
        token: tokenMint,
        tokenSymbol,
        tokenName,
        amount: tokenAmount,
        solAmount,
        price: tokenPriceUSD,
        timestamp: Date.now(),
        signature,
        traderTotalTokens: positions.get(tokenMint) || 0,
        traderSoldTokens: !isBuy ? Math.abs(tokenChange) : undefined
      };
      
      return signal;
    } catch (error) {
      return null;
    }
  }

  private async getSolPriceUSD(): Promise<number> {
    const now = Date.now();
    if (now - this.lastSolPriceFetch < this.SOL_PRICE_TTL_MS) {
      return this.cachedSolPriceUSD;
    }
    try {
      const birdeyeKey = process.env.BIRDEYE_API_KEY;
      const url = `https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112`;
      const resp = await fetch(url, {
        headers: birdeyeKey ? { 'X-API-KEY': birdeyeKey } : undefined
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        const price = Number(data?.data?.value || data?.value || 0);
        if (isFinite(price) && price > 0) {
          this.cachedSolPriceUSD = price;
          this.lastSolPriceFetch = now;
          return price;
        }
      }
    } catch {}
    // Fallback
    this.lastSolPriceFetch = now;
    return this.cachedSolPriceUSD;
  }

  private startPingInterval(): void {
    // Ping every 30 seconds to keep connection alive
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        
        // Check for stale connection
        if (Date.now() - this.lastActivityTime > 60000) {
          console.log('⚠️ Connection appears stale, reconnecting...');
          this.reconnect();
        }
      }
    }, 30000);
  }

  private handleError(error: Error): void {
    console.error('❌ WebSocket error:', error.message);
  }

  private handleClose(): void {
    console.log('🔌 WebSocket connection closed');
    this.cleanup();
    
    if (this.isRunning && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnect();
    }
  }

  private reconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 30000);
    
    console.log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    setTimeout(() => {
      if (this.isRunning) {
        this.connect().catch(console.error);
      }
    }, delay);
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }
    
    this.subscriptionIds.clear();
  }

  async disconnect(): Promise<void> {
    console.log('Disconnecting QuickNode WebSocket monitor...');
    this.isRunning = false;
    this.cleanup();
  }

  addWallet(wallet: string): void {
    if (!this.targetWallets.has(wallet)) {
      this.targetWallets.add(wallet);
      console.log(`Added wallet to monitoring: ${wallet}`);
      
      // Subscribe to the new wallet if connected
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const request = {
          jsonrpc: '2.0',
          id: Date.now() + Math.random(),
          method: 'logsSubscribe',
          params: [
            { mentions: [wallet] },
            { commitment: 'confirmed' }
          ]
        };
        
        this.ws.send(JSON.stringify(request));
      }
    }
  }

  removeWallet(wallet: string): void {
    this.targetWallets.delete(wallet);
    console.log(`Removed wallet from monitoring: ${wallet}`);
  }
  
  // Compatibility methods for SolanaTracker interface
  subscribeToPriceUpdates(tokens: string[]): void {
    // Price updates will come through transaction monitoring
    console.log(`Price updates for ${tokens.length} tokens will be tracked via transactions`);
  }
  
  leaveRoom(type: string): void {
    // No-op for compatibility
    console.log(`Room leave request: ${type} (not applicable for QuickNode)`);
  }
  
  async stop(): Promise<void> {
    await this.disconnect();
  }
}