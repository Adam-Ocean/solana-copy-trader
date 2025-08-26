import { EventEmitter } from 'events';
import { YellowstoneClient } from './YellowstoneClient';
const bs58 = require('bs58').default || require('bs58');
// DEX Programs inline to avoid import issues
const DEX_PROGRAMS: Record<string, string> = {
  // Jupiter
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter v6',
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB': 'Jupiter v4',
  // Raydium
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium CPMM',
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj': 'Raydium Launchpad',
  // Orca
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
  // Pump.fun
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun',
  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg': 'Pump AMM',
  'H78HrdQ2E7N5eHrE4FEnPNxxdNofyYcrZFzkVdoyGWg9': 'Pump.fun H78',
  '9Fox6i7oT8p4qHn76Qj3dks8RRMGsXQyfMSBScA5yVyX': 'Pump.fun 9F',
  // Meteora
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora',
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN': 'Meteora DBC',
  'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC': 'Meteora DLMM v2',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'Meteora Pools',
  // Others
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY': 'Phoenix',
  'AxiomfHaWDemCFBLBayqnEnNwE6b7B2Qz3UmzMpgbMG6': 'Axiom',
  'AxiomxSitiyXyPjKgJ9XSrdhsydtZsskZTEDam3PxKcC': 'Axiom V2',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'pAMM AMM'
};

interface WalletSignal {
  action: 'buy' | 'sell';
  wallet: string;
  token: string;
  amount: number;
  solAmount: number;
  price: number;
  timestamp: number;
  signature: string;
}

export class YellowstoneWalletMonitor extends EventEmitter {
  private client: YellowstoneClient;
  private targetWallet: string;
  private processedSignatures: Set<string> = new Set();
  private signalCount: number = 0;
  private startTime: number = Date.now();
  private latestSlot: number = 0;
  private nodeSlot: number = 0;

  constructor(grpcUrl: string, targetWallet: string) {
    super();
    this.targetWallet = targetWallet;
    
    // Initialize Yellowstone client
    this.client = new YellowstoneClient({
      endpoint: grpcUrl,
      targetWallet: targetWallet
    });
    
    this.setupEventHandlers();
    console.log(`🟡 Yellowstone wallet monitor initialized for ${targetWallet}`);
  }

  private setupEventHandlers(): void {
    // Handle Yellowstone signals
    this.client.on('signal', async (signal: any) => {
      try {
        const signalTime = Date.now();
        this.signalCount++;
        
        // Calculate signal rate
        const runtime = (signalTime - this.startTime) / 1000 / 60; // minutes
        const signalRate = this.signalCount / runtime;
        
        console.log(`🟡 [Yellowstone] Signal #${this.signalCount} (Rate: ${signalRate.toFixed(1)}/min)`);
        
        if (signal.type === 'transaction' && signal.signature) {
          // Check if we've already processed this
          if (this.processedSignatures.has(signal.signature)) {
            return;
          }
          
          this.processedSignatures.add(signal.signature);
          
          // Parse transaction directly from Yellowstone data
          this.parseTransactionFromStream(signal);
        }
        
      } catch (error) {
        console.error('Error handling Yellowstone signal:', error);
      }
    });
    
    this.client.on('connected', () => {
      console.log('✅ Yellowstone connected - Ultra-low latency mode active (<5ms)');
      this.emit('connected');
    });
    
    this.client.on('error', (error) => {
      console.error('❌ Yellowstone error:', error.message);
      this.emit('error', error);
    });
  }

  private extractAccountKeys(tx: any): string[] {
    try {
      const message = tx.transaction?.message;
      if (!message) return [];
      
      const accountKeys = message.account_keys || message.accountKeys || [];
      
      // Convert each key to base58 string
      return accountKeys.map((key: any) => {
        if (typeof key === 'string') return key;
        if (Buffer.isBuffer(key)) {
          return bs58.encode(key);
        }
        if (key.data) {
          return bs58.encode(Buffer.from(key.data));
        }
        return '';
      }).filter((key: string) => key.length > 0);
    } catch (error) {
      console.error('Error extracting account keys:', error);
      return [];
    }
  }

  private parseTransactionFromStream(signal: any): void {
    try {
      const signature = signal.signature;
      const txData = signal.data;
      
      if (!txData || !txData.transaction) {
        console.log('   No transaction data in signal');
        return;
      }

      const tx = txData.transaction;
      console.log(`   Parsing transaction: ${signature.substring(0, 20)}...`);
      
      // Update slot information if available
      if (tx.slot) {
        this.latestSlot = tx.slot;
        // For now, use the same slot as node slot (can be updated with actual node slot later)
        if (this.nodeSlot === 0) {
          this.nodeSlot = tx.slot;
        }
      }

      // Extract account keys (convert from Buffer if needed)
      const accountKeys = this.extractAccountKeys(tx);
      console.log(`   Extracted ${accountKeys.length} account keys`);
      
      // Check if target wallet is in this transaction
      if (!accountKeys.includes(this.targetWallet)) {
        console.log('   Target wallet not in transaction');
        return;
      }
      
      // Check if this is a DEX transaction
      let dexUsed: string | null = null;
      let dexName: string | null = null;
      
      // Log first few account keys for debugging
      if (accountKeys.length > 0) {
        console.log(`   First account: ${accountKeys[0]}`);
        // Check for pAMM specifically
        const hasPamm = accountKeys.some(k => k.includes('pAMM'));
        console.log(`   Has pAMM in keys: ${hasPamm}`);
      }
      
      for (const account of accountKeys) {
        if (DEX_PROGRAMS[account]) {
          dexUsed = account;
          dexName = DEX_PROGRAMS[account];
          console.log(`   DEX interaction: ${dexName}`);
          break;
        }
      }

      if (!dexUsed) {
        console.log('   Not a DEX transaction');
        // Log all account keys for debugging
        console.log('   Account keys:', accountKeys.slice(0, 5).map(k => k.substring(0, 10) + '...'));
        return;
      }

      // Extract metadata
      const meta = tx.meta;
      if (!meta) {
        console.log('   No metadata in transaction');
        return;
      }

      // Parse balance changes with IMPROVED logic
      const tradeSignal = this.parseBalanceChangesImproved(
        accountKeys,
        meta,
        signature,
        dexName || 'Unknown DEX'
      );

      if (tradeSignal) {
        console.log(`🔔 ${tradeSignal.action.toUpperCase()} Signal: ${tradeSignal.token.substring(0, 8)}...`);
        console.log(`   Amount: ${tradeSignal.solAmount} SOL`);
        console.log(`   DEX: ${dexName}`);
        
        // Emit the trading signal
        this.emit('signal', tradeSignal);
      }
      
    } catch (error) {
      console.error('Error parsing transaction from stream:', error);
    }
  }

  private parseBalanceChangesImproved(
    accountKeys: string[],
    meta: any,
    signature: string,
    dexName: string
  ): WalletSignal | null {
    try {
      // Parse SOL balance changes
      const preBalancesSol = meta.pre_balances || [];
      const postBalancesSol = meta.post_balances || [];
      
      // CRITICAL FIX: Find the LARGEST SOL change among ALL accounts
      // This captures the actual trade amount even with intermediate accounts
      let largestSolChange = 0n;
      let walletWithLargestChange: string | null = null;
      let targetWalletIndex = -1;
      let targetWalletSolChange = 0n;
      let directionFromSOL: 'buy' | 'sell' | null = null;
      let actualSolAmount = 0;

      for (let i = 0; i < accountKeys.length; i++) {
        const account = accountKeys[i];
        
        if (i < preBalancesSol.length && i < postBalancesSol.length) {
          // Handle both string and number formats, use BigInt for precision
          const preSol = typeof preBalancesSol[i] === 'string' 
            ? BigInt(preBalancesSol[i])
            : BigInt(preBalancesSol[i] || 0);
          const postSol = typeof postBalancesSol[i] === 'string'
            ? BigInt(postBalancesSol[i])
            : BigInt(postBalancesSol[i] || 0);
          const solChange = postSol - preSol;
          const absSolChange = solChange < 0n ? -solChange : solChange;
          
          // Track if this is our target wallet
          if (account === this.targetWallet) {
            targetWalletIndex = i;
            targetWalletSolChange = solChange;
            console.log(`   Target wallet SOL change: ${Number(solChange) / 1e9} SOL`);
            
            // Determine direction based on target wallet's balance change
            if (solChange < -1000000n) { // Lost > 0.001 SOL
              directionFromSOL = 'buy';
            } else if (solChange > 1000000n) { // Gained > 0.001 SOL
              directionFromSOL = 'sell';
            }
          }
          
          // Track the LARGEST change (this is likely the actual trade amount)
          if (absSolChange > largestSolChange) {
            largestSolChange = absSolChange;
            walletWithLargestChange = account;
            actualSolAmount = Number(absSolChange) / 1e9;
          }
        }
      }

      if (targetWalletIndex === -1) {
        console.log('   Target wallet not found in accounts');
        return null;
      }

      console.log(`   Largest SOL change: ${actualSolAmount} SOL (account: ${walletWithLargestChange?.substring(0, 8)}...)`);
      console.log(`   Using actual trade amount: ${actualSolAmount} SOL`);

      // Parse token balance changes
      const preTokenBalances = meta.pre_token_balances || [];
      const postTokenBalances = meta.post_token_balances || [];
      
      let directionFromTokens: 'buy' | 'sell' | null = null;
      let tokenMint: string | null = null;
      let tokenAmount = 0;

      // Check post token balances for our wallet
      for (const postBalance of postTokenBalances) {
        // Check if this token belongs to our target wallet
        const owner = postBalance.owner;
        if (owner === this.targetWallet) {
          const mint = postBalance.mint;
          
          // Skip WSOL
          if (mint === 'So11111111111111111111111111111111111111112') {
            continue;
          }

          // Find corresponding pre-balance
          const preBalance = preTokenBalances.find((pre: any) =>
            pre.account_index === postBalance.account_index &&
            pre.mint === mint
          );

          const preAmount = parseFloat(preBalance?.ui_token_amount?.ui_amount || '0');
          const postAmount = parseFloat(postBalance.ui_token_amount?.ui_amount || '0');
          const tokenChange = postAmount - preAmount;

          if (tokenChange > 0 || !preBalance) { // Gained tokens or new account
            directionFromTokens = 'buy';
            tokenMint = mint;
            tokenAmount = postAmount;
          } else if (tokenChange < 0) { // Lost tokens
            directionFromTokens = 'sell';
            tokenMint = mint;
            tokenAmount = Math.abs(tokenChange);
          }
          
          if (tokenMint) {
            break; // Found the traded token
          }
        }
      }

      // Determine final direction (prioritize token direction)
      const swapDirection = directionFromTokens || directionFromSOL;
      
      if (!swapDirection || !tokenMint) {
        console.log('   Could not determine trade direction or token');
        return null;
      }

      // Return the trading signal with the ACTUAL trade amount
      // For price calculation: we need SOL price in USD (approximately $140-200)
      // But since we're in PAPER mode and need relative prices, we'll use SOL as base
      // The actual USD price will be calculated by the position manager with current SOL price
      return {
        action: swapDirection,
        wallet: this.targetWallet,
        token: tokenMint,
        amount: tokenAmount,
        solAmount: actualSolAmount, // Use the LARGEST SOL change, not just target wallet's change
        price: actualSolAmount / (tokenAmount || 1), // Price in SOL per token (will be converted to USD later)
        timestamp: Math.floor(Date.now() / 1000),
        signature: signature
      };
      
    } catch (error) {
      console.error('Error parsing balance changes:', error);
      return null;
    }
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  async stop(): Promise<void> {
    await this.disconnect();
  }
  
  async leaveRoom(): Promise<void> {
    // Not applicable for Yellowstone - no rooms concept
  }
  
  getSlotDifference(): number | undefined {
    // Return the slot difference if we have both values
    if (this.latestSlot > 0 && this.nodeSlot > 0) {
      return this.latestSlot - this.nodeSlot;
    }
    return undefined;
  }
  
  updateSlots(latestSlot: number, nodeSlot: number): void {
    this.latestSlot = latestSlot;
    this.nodeSlot = nodeSlot;
  }
}