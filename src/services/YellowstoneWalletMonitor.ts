import { EventEmitter } from 'events';
import { Connection, PublicKey } from '@solana/web3.js';
import { YellowstoneClient } from './YellowstoneClient';
import { WalletSignal } from '../types/enhanced';

export class YellowstoneWalletMonitor extends EventEmitter {
  private client: YellowstoneClient;
  private connection: Connection;
  private targetWallet: string;
  private processedSignatures = new Set<string>();
  private signalCount = 0;
  private startTime = Date.now();
  private traderPositions = new Map<string, number>(); // Track trader's token holdings

  constructor(grpcUrl: string, targetWallet: string, connection: Connection) {
    super();
    this.targetWallet = targetWallet;
    this.connection = connection;
    
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
        console.log(`   DEBUG: Signal type: ${signal.type}, has signature: ${!!signal.signature}`);
        
        if (signal.type === 'transaction' && signal.signature) {
          // Check if we've already processed this
          if (this.processedSignatures.has(signal.signature)) {
            console.log('   DEBUG: Already processed signature, skipping');
            return;
          }
          
          this.processedSignatures.add(signal.signature);
          
          // Parse transaction for trade details
          console.log('   DEBUG: Calling parseTransaction...');
          await this.parseTransaction(signal);
        }
        
        // For account updates, check recent transactions
        if (signal.type === 'account') {
          await this.checkRecentTransactions();
        }
        
      } catch (error) {
        console.error('Error handling Yellowstone signal:', error);
      }
    });
    
    this.client.on('connected', () => {
      console.log('✅ Yellowstone connected - Ultra-low latency mode active');
      this.emit('connected');
    });
    
    this.client.on('error', (error) => {
      console.error('❌ Yellowstone error:', error.message);
      this.emit('error', error);
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
    
    // Initialize trader's current token positions
    await this.initializeTraderPositions();
  }
  
  private async initializeTraderPositions(): Promise<void> {
    try {
      console.log('🔄 Loading trader\'s current token positions...');
      
      // Get all token accounts for the trader
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        new PublicKey(this.targetWallet),
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
      );
      
      let positionCount = 0;
      for (const account of tokenAccounts.value) {
        const tokenData = account.account.data.parsed.info;
        const mint = tokenData.mint;
        const amount = parseFloat(tokenData.tokenAmount.uiAmount || '0');
        
        if (amount > 0) {
          this.traderPositions.set(mint, amount);
          positionCount++;
          console.log(`   Found position: ${amount.toFixed(2)} tokens of ${mint.substring(0, 8)}...`);
        }
      }
      
      console.log(`✅ Loaded ${positionCount} existing token positions for trader`);
    } catch (error) {
      console.error('Failed to load trader positions:', error);
      console.log('⚠️ Starting with empty position tracking (will build up as trades happen)');
    }
  }

  private async parseTransaction(signal: any): Promise<void> {
    try {
      // Handle signature as Buffer or string
      let signatureStr: string;
      if (Buffer.isBuffer(signal.signature)) {
        signatureStr = Buffer.from(signal.signature).toString('base64');
        console.log(`   Parsing transaction: ${Buffer.from(signal.signature).toString('hex').substring(0, 20)}...`);
      } else if (typeof signal.signature === 'string') {
        signatureStr = signal.signature;
        console.log(`   Parsing transaction: ${signatureStr.substring(0, 20)}...`);
      } else {
        console.log('   Invalid signature format');
        return;
      }
      
      // Extract data directly from Yellowstone signal if available
      if (signal.data && signal.data.transaction) {
        const txData = signal.data.transaction;
        console.log(`   Yellowstone transaction data available at slot ${signal.slot}`);
        
        // Parse directly from Yellowstone data to avoid RPC calls
        const swapInfo = await this.parseYellowstoneTransaction(txData);
        
        if (swapInfo) {
          // Debug logging for price calculation
          console.log(`   DEBUG swapInfo:`, {
            side: swapInfo.side,
            tokenAmount: swapInfo.tokenAmount,
            solAmount: swapInfo.amount,
            price: swapInfo.price,
            priceCalculation: swapInfo.tokenAmount ? `${swapInfo.amount}/${swapInfo.tokenAmount} = ${swapInfo.amount/swapInfo.tokenAmount}` : 'N/A'
          });
          
          // Update trader's position tracking
          let traderTotalBefore = this.traderPositions.get(swapInfo.token) || 0;
          let traderSoldTokens = 0;
          
          if (swapInfo.side === 'buy') {
            // Trader is buying - update their position
            this.traderPositions.set(swapInfo.token, traderTotalBefore + (swapInfo.tokenAmount || 0));
          } else if (swapInfo.side === 'sell' && swapInfo.tokenAmount) {
            // Trader is selling - calculate how much they sold
            traderSoldTokens = swapInfo.tokenAmount;
            const remaining = Math.max(0, traderTotalBefore - traderSoldTokens);
            
            if (remaining === 0) {
              this.traderPositions.delete(swapInfo.token);
              console.log(`   Trader fully exited position (sold all ${traderTotalBefore.toFixed(2)} tokens)`);
            } else {
              this.traderPositions.set(swapInfo.token, remaining);
              const sellPercent = (traderSoldTokens / traderTotalBefore) * 100;
              console.log(`   Trader partial exit: sold ${traderSoldTokens.toFixed(2)}/${traderTotalBefore.toFixed(2)} (${sellPercent.toFixed(1)}%)`);
            }
          }
          
          const walletSignal: WalletSignal = {
            action: swapInfo.side,
            wallet: this.targetWallet,
            token: swapInfo.token,
            amount: swapInfo.tokenAmount || swapInfo.amount, // Token count (prioritize tokenAmount if available)
            solAmount: swapInfo.amount, // SOL amount spent/received
            price: swapInfo.price || 0,
            timestamp: Math.floor(Date.now() / 1000),
            signature: signatureStr,
            // Add trader position info for proportional exits
            traderTotalTokens: swapInfo.side === 'sell' ? traderTotalBefore : undefined,
            traderSoldTokens: swapInfo.side === 'sell' ? traderSoldTokens : undefined
          };
          
          console.log(`🟡 [Yellowstone] ${swapInfo.side.toUpperCase()} Signal:`, {
            dex: swapInfo.dex,
            token: swapInfo.token.substring(0, 10) + '...',
            tokenAmount: swapInfo.tokenAmount ? swapInfo.tokenAmount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 6 }) : 'N/A',
            solAmount: `${swapInfo.amount.toFixed(6)} SOL`,
            price: `${(swapInfo.price || 0).toFixed(10)} SOL/token`,
            slot: signal.slot,
            latency: this.client.getLatency()
          });
          
          this.emit('signal', walletSignal);
          return; // Success, exit early
        }
      }
      
      // Skip RPC fallback - Yellowstone provides all necessary data
      // RPC calls were causing "Invalid param: Invalid" errors that break the stream
      console.log('   Yellowstone data parsing failed, skipping RPC fallback to prevent stream breakage');
      
    } catch (error) {
      console.error('Error parsing transaction:', error);
    }
  }

  private async parseYellowstoneTransaction(txData: any): Promise<any> {
    try {
      // Check if transaction has the expected structure
      if (!txData || !txData.meta) {
        return null;
      }
      
      // Look for DEX program interactions
      const knownDexPrograms = [
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter V6
        'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter V4
        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium V4
        'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
        'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
        'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
        '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', // Pump AMM
        'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', // Phoenix
        'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora
        'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC', // Meteora DLMM V2
        'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PAMM (you mentioned this one)
        'srmqPiDuMd3qXGxYjJJqQE3GX4zrA7B5xQhyqJp1NxB', // Serum DEX
        '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca V1
        '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium V3
        'EhYXisHc2sGhHGKqU4dkKMxW4EYGLk7KCqZYWu8Vw4Y', // Lifinity
        'Dooar9JkhdZ7J3LHMBje8AiNEgLRm2AYFt7P7Fks7J3v', // Dooar
        '27hAf7nN3oqJKX6VFpuGjYoEEiL6L8cEz5oQ5gj5Lhs1'  // Solend
      ];
      
      let isDexTransaction = false;
      let dexName = '';
      
      // Check account keys for DEX programs - handle triple-nested structure
      let accountKeys: any[] = [];
      
      // Try multiple paths for account keys (Yellowstone has deeply nested structure)
      if (txData.transaction?.transaction?.message?.account_keys) {
        accountKeys = txData.transaction.transaction.message.account_keys;
      } else if (txData.transaction?.message?.account_keys) {
        accountKeys = txData.transaction.message.account_keys;
      } else if (txData.message?.account_keys) {
        accountKeys = txData.message.account_keys;
      }
      
      console.log(`   Found ${accountKeys.length} account keys in transaction`);
      if (accountKeys.length > 0) {
        for (const key of accountKeys) {
          const keyStr = Buffer.isBuffer(key) ? 
            require('bs58').default ? require('bs58').default.encode(key) : require('bs58').encode(key) : 
            key.toString();
          
          if (knownDexPrograms.includes(keyStr)) {
            isDexTransaction = true;
            // Determine DEX name based on program ID
            if (keyStr.startsWith('JUP')) dexName = 'Jupiter';
            else if (keyStr === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') dexName = 'Raydium V4';
            else if (keyStr === 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK') dexName = 'Raydium CLMM';
            else if (keyStr === 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C') dexName = 'Raydium CPMM';
            else if (keyStr === 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc') dexName = 'Orca';
            else if (keyStr === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P') dexName = 'Pump.fun';
            else if (keyStr === 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY') dexName = 'Phoenix';
            else if (keyStr.startsWith('LBU')) dexName = 'Meteora';
            else dexName = 'DEX';
            console.log(`   DEX interaction detected: ${dexName}`);
            break;
          }
        }
      }
      
      if (!isDexTransaction) {
        // Log all account keys to find DEX programs
        if (accountKeys.length > 0) {
          console.log(`   Checking all ${accountKeys.length} account keys for DEX programs:`);
          for (let i = 0; i < accountKeys.length; i++) {
            const key = accountKeys[i];
            const keyStr = Buffer.isBuffer(key) ? 
              require('bs58').default ? require('bs58').default.encode(key) : require('bs58').encode(key) : 
              key.toString();
            
            // Check if this is a known DEX
            if (knownDexPrograms.includes(keyStr)) {
              console.log(`     [${i}]: ${keyStr} ← DEX FOUND!`);
              isDexTransaction = true;
              dexName = keyStr.startsWith('JUP') ? 'Jupiter' : 
                       keyStr === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' ? 'Raydium V4' :
                       'Unknown DEX';
              break;
            }
          }
          
          if (!isDexTransaction) {
            console.log(`   No known DEX program found, checking for SOL balance changes to detect potential swap...`);
            // Continue processing - we'll check for significant SOL changes below
            // Even if we don't recognize the DEX, large SOL changes indicate trading activity
          }
        } else {
          return null;
        }
      }
      
      // Parse token balance changes from meta
      const meta = txData.meta;
      
      // Find the largest SOL change in the transaction (CopyBot-Basic method)
      // Instead of just looking at target wallet, find the biggest SOL movement
      let maxSolChange = 0;
      let targetAccountIndex = -1;
      let targetWalletChange = 0;
      
      if (meta.pre_balances && meta.post_balances) {
        // First, find target wallet index
        if (accountKeys.length > 0) {
          for (let i = 0; i < accountKeys.length; i++) {
            const key = accountKeys[i];
            const keyStr = Buffer.isBuffer(key) ? 
              require('bs58').default ? require('bs58').default.encode(key) : require('bs58').encode(key) : 
              key.toString();
            
            if (keyStr === this.targetWallet) {
              targetAccountIndex = i;
              break;
            }
          }
        }
        
        // Find the largest SOL change (excluding small fees) - CopyBot-Basic method
        for (let i = 0; i < Math.min(meta.pre_balances.length, meta.post_balances.length); i++) {
          const change = (meta.post_balances[i] - meta.pre_balances[i]) / 1e9;
          const absChange = Math.abs(change);
          
          // Track largest absolute change for amount
          if (absChange > 0.0001 && absChange > Math.abs(maxSolChange)) {
            maxSolChange = change;
          }
          
          // Track target wallet's specific change for direction
          if (i === targetAccountIndex) {
            targetWalletChange = change;
          }
        }
      }
      
      // Determine trade direction based on TARGET WALLET's net change (not largest change)
      let side: 'buy' | 'sell' = 'buy';
      let amount = Math.abs(maxSolChange); // Still use largest change for amount
      
      // Use TARGET WALLET change to determine direction
      // For SELLs: target wallet gains SOL (positive change)
      // For BUYs: target wallet loses SOL (negative change > fees)
      
      if (targetWalletChange < -0.005) {
        // Target wallet lost significant SOL = BUY (spent SOL to buy tokens)
        side = 'buy';
        console.log(`   BUY detected: ${amount} SOL (target wallet spent: ${Math.abs(targetWalletChange).toFixed(6)} SOL)`);
      } else if (targetWalletChange > 0.0001) {
        // Target wallet gained SOL = SELL (sold tokens for SOL) 
        // Even small positive changes can be SELLs - lowered threshold
        side = 'sell';
        console.log(`   SELL detected: ${amount} SOL (target wallet received: +${targetWalletChange.toFixed(6)} SOL)`);
      } else if (Math.abs(maxSolChange) > 0.1) {
        // Large transaction but small target wallet change - check if it's a SELL with fees
        // Look at token balance changes to determine if this is actually a SELL
        if (meta.pre_token_balances && meta.post_token_balances) {
          let hasTokenDecrease = false;
          for (const postBalance of meta.post_token_balances) {
            const preBalance = meta.pre_token_balances.find((pre: any) => 
              pre.account_index === postBalance.account_index
            );
            if (preBalance && parseFloat(postBalance.ui_token_amount?.ui_amount || '0') < parseFloat(preBalance.ui_token_amount?.ui_amount || '0')) {
              hasTokenDecrease = true;
              break;
            }
          }
          
          if (hasTokenDecrease) {
            side = 'sell';
            console.log(`   SELL detected (via token decrease): ${amount} SOL (target wallet change: ${targetWalletChange.toFixed(6)} SOL after fees)`);
          } else {
            console.log(`   Small target wallet change (${targetWalletChange.toFixed(6)} SOL) - likely just fees, skipping`);
            return null;
          }
        } else {
          console.log(`   Small target wallet change (${targetWalletChange.toFixed(6)} SOL) - likely just fees, skipping`);
          return null;
        }
      } else {
        console.log(`   Small target wallet change (${targetWalletChange.toFixed(6)} SOL) - likely just fees, skipping`);
        return null;
      }
      
      // If we have significant SOL change but no DEX detected, still treat as potential swap
      if (!isDexTransaction && Math.abs(maxSolChange) > 0.001) {
        dexName = 'Unknown DEX';
        console.log(`   No known DEX found but significant SOL change (${Math.abs(maxSolChange)} SOL) - treating as swap`);
      }
      
      // Extract token address from token balance changes in meta
      let tokenAddress = 'Unknown';
      
      // Check for token balance changes
      if (meta.pre_token_balances && meta.post_token_balances) {
        for (const postBalance of meta.post_token_balances) {
          const preBalance = meta.pre_token_balances.find((pre: any) => 
            pre.account_index === postBalance.account_index
          );
          
          if (preBalance && postBalance.mint) {
            // Found a token that changed
            const mintStr = Buffer.isBuffer(postBalance.mint) ? 
              require('bs58').default ? require('bs58').default.encode(postBalance.mint) : require('bs58').encode(postBalance.mint) : 
              postBalance.mint.toString();
            
            // Skip WSOL
            if (mintStr !== 'So11111111111111111111111111111111111111112') {
              tokenAddress = mintStr;
              console.log(`   Token found: ${mintStr.substring(0, 10)}...`);
              break;
            }
          }
        }
      }
      
      // If still unknown, try to find token accounts in the transaction
      if (tokenAddress === 'Unknown' && accountKeys.length > 0) {
        // Look for common token program or associated token accounts
        for (const key of accountKeys) {
          const keyStr = Buffer.isBuffer(key) ? 
            require('bs58').default ? require('bs58').default.encode(key) : require('bs58').encode(key) : 
            key.toString();
          
          // Skip system programs and known DEX programs
          if (!knownDexPrograms.includes(keyStr) && 
              keyStr !== '11111111111111111111111111111111' &&
              keyStr !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' &&
              keyStr !== this.targetWallet &&
              keyStr.length === 44) {
            // This could be a token mint
            console.log(`   Potential token: ${keyStr.substring(0, 10)}...`);
          }
        }
      }
      
      // Calculate accurate price using token balance changes
      let price = 0;
      let tokenAmount = 0;
      
      // Get actual token amount from token balance changes
      if (meta.pre_token_balances && meta.post_token_balances) {
        for (const postBalance of meta.post_token_balances) {
          const preBalance = meta.pre_token_balances.find((pre: any) => 
            pre.account_index === postBalance.account_index
          );
          
          if (preBalance && postBalance.mint) {
            const mintStr = Buffer.isBuffer(postBalance.mint) ? 
              require('bs58').default ? require('bs58').default.encode(postBalance.mint) : require('bs58').encode(postBalance.mint) : 
              postBalance.mint.toString();
            
            // Skip WSOL - we want the actual token being traded
            if (mintStr !== 'So11111111111111111111111111111111111111112') {
              const preAmount = parseFloat(preBalance.ui_token_amount?.ui_amount || '0');
              const postAmount = parseFloat(postBalance.ui_token_amount?.ui_amount || '0');
              const tokenChange = Math.abs(postAmount - preAmount);
              
              if (tokenChange > 0) {
                tokenAmount = tokenChange;
                tokenAddress = mintStr; // Update token address with the one that changed
                console.log(`   Token amount changed: ${tokenChange} ${mintStr.substring(0, 8)}...`);
                break;
              }
            }
          }
        }
      }
      
      // Calculate price: SOL amount / token amount
      // IMPORTANT: Use 'amount' (actual SOL traded), not targetWalletChange (which includes fees)
      if (tokenAmount > 0 && amount > 0) {
        // Price = SOL traded / tokens traded
        price = amount / tokenAmount;
        console.log(`   Calculated price: ${price.toFixed(10)} SOL per token (${tokenAmount} tokens)`);
      } else if (tokenAmount > 0 && Math.abs(targetWalletChange) > 0.0001) {
        // Fallback to target wallet change if amount is not available
        console.log(`   WARNING: Using targetWalletChange for price calculation (less accurate)`);
        if (side === 'buy') {
          // BUY: price = SOL spent / tokens received
          price = Math.abs(targetWalletChange) / tokenAmount;
        } else if (side === 'sell') {
          // SELL: price = SOL received / tokens sold
          const solReceived = targetWalletChange > 0 ? targetWalletChange : Math.abs(maxSolChange);
          price = solReceived / tokenAmount;
        }
        console.log(`   Calculated price (fallback): ${price.toFixed(10)} SOL per token`);
      } else {
        // Fallback: use the original amount-based calculation
        if (side === 'buy' && targetWalletChange < 0) {
          price = Math.abs(targetWalletChange) / amount;
        } else if (side === 'sell' && targetWalletChange > 0) {
          price = targetWalletChange / amount;
        } else {
          price = amount > 0 ? Math.abs(maxSolChange) / amount : 0;
        }
      }

      return {
        side,
        token: tokenAddress,
        amount: amount, // Use the max SOL change (actual trade volume), not target wallet change
        tokenAmount, // Separate field for token count
        price: price > 0 ? price : 0, // SOL per token
        dex: dexName || 'Unknown DEX',
        slot: txData.slot
      };
      
    } catch (error) {
      console.error('Error parsing Yellowstone transaction:', error);
      return null;
    }
  }

  private async extractSwapDetails(tx: any, programId: string): Promise<any> {
    try {
      const preBalances = tx.meta.preTokenBalances || [];
      const postBalances = tx.meta.postTokenBalances || [];
      
      // Find token changes
      const tokenChanges = new Map<string, number>();
      
      // Calculate balance changes
      for (const post of postBalances) {
        const pre = preBalances.find((p: any) => 
          p.accountIndex === post.accountIndex && 
          p.mint === post.mint
        );
        
        if (pre && post.owner === this.targetWallet) {
          const change = (post.uiTokenAmount.uiAmount || 0) - (pre.uiTokenAmount.uiAmount || 0);
          if (Math.abs(change) > 0.000001) {
            tokenChanges.set(post.mint, change);
          }
        }
      }
      
      // SOL changes
      const accountIndex = tx.transaction.message.accountKeys.findIndex(
        (key: any) => key.pubkey.toString() === this.targetWallet
      );
      
      if (accountIndex >= 0) {
        const solChange = (tx.meta.postBalances[accountIndex] - tx.meta.preBalances[accountIndex]) / 1e9;
        if (Math.abs(solChange) > 0.000001) {
          tokenChanges.set('So11111111111111111111111111111111111111112', solChange);
        }
      }
      
      // Determine trade direction and token
      let side: 'buy' | 'sell' = 'buy';
      let token = '';
      let amount = 0;
      
      for (const [mint, change] of tokenChanges.entries()) {
        if (mint === 'So11111111111111111111111111111111111111112') {
          // SOL change
          if (change < 0) {
            // Spending SOL = buying token
            side = 'buy';
            amount = Math.abs(change);
          } else {
            // Receiving SOL = selling token
            side = 'sell';
          }
        } else {
          // Token change
          if (change > 0 && side === 'buy') {
            // Receiving token after spending SOL
            token = mint;
          } else if (change < 0 && side === 'sell') {
            // Selling token for SOL
            token = mint;
            amount = Math.abs(change);
          }
        }
      }
      
      if (token) {
        return {
          side,
          token,
          amount,
          slot: tx.slot,
          timestamp: tx.blockTime
        };
      }
      
      return null;
      
    } catch (error) {
      console.error('Error extracting swap details:', error);
      return null;
    }
  }

  private async checkRecentTransactions(): Promise<void> {
    // Skip RPC calls for recent transactions - Yellowstone real-time monitoring is sufficient
    // This prevents "Invalid param: Invalid" RPC errors from breaking the stream
    console.log('   Account update detected, relying on Yellowstone real-time monitoring');
  }

  async close(): Promise<void> {
    await this.client.disconnect();
    console.log('🟡 Yellowstone wallet monitor closed');
  }

  // Compatibility methods for interface
  async stop(): Promise<void> {
    await this.close();
  }

  leaveRoom(): void {
    // No rooms in Yellowstone, this is for compatibility
  }

  getStats(): any {
    const runtime = (Date.now() - this.startTime) / 1000 / 60; // minutes
    return {
      signalsDetected: this.signalCount,
      signalRate: (this.signalCount / runtime).toFixed(1),
      runtime: runtime.toFixed(1),
      latency: '<5ms'
    };
  }

  // Compatibility method for price subscription (placeholder for Yellowstone monitor)
  subscribeToPriceUpdates(tokenAddress: string): void {
    // Yellowstone monitor doesn't need separate price subscription
    // Prices come through Birdeye WebSocket connections
    console.log(`📊 Price updates for ${tokenAddress.slice(0, 8)} will be handled by Birdeye`);
  }
}