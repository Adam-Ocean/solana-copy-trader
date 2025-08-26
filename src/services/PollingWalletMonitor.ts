import { EventEmitter } from 'events';
import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { WalletSignal } from '../types/enhanced';

export class PollingWalletMonitor extends EventEmitter {
  private connection: Connection;
  private targetWallet: string;
  private processedSignatures = new Set<string>();
  private isRunning = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastSignature: string | null = null;

  constructor(rpcUrl: string, targetWallet: string) {
    super();
    this.targetWallet = targetWallet;
    this.connection = new Connection(rpcUrl, 'confirmed');
    console.log(`🔄 Polling wallet monitor initialized for ${targetWallet}`);
  }

  async connect(): Promise<void> {
    console.log('🔄 Starting polling monitor...');
    this.isRunning = true;
    this.startPolling();
    this.emit('connected');
  }

  private startPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }

    // Poll every 2 seconds to avoid rate limits
    this.pollInterval = setInterval(async () => {
      if (!this.isRunning) return;
      await this.checkForNewTransactions();
    }, 2000);

    // Initial check
    this.checkForNewTransactions();
  }

  private async checkForNewTransactions(): Promise<void> {
    try {
      const signatures = await this.connection.getSignaturesForAddress(
        new PublicKey(this.targetWallet),
        {
          limit: 10,
          before: this.lastSignature || undefined
        }
      );

      if (signatures.length === 0) return;

      // Process new signatures
      for (const sigInfo of signatures.reverse()) {
        if (this.processedSignatures.has(sigInfo.signature)) continue;
        
        this.processedSignatures.add(sigInfo.signature);
        this.lastSignature = sigInfo.signature;

        console.log(`🔄 New transaction detected: ${sigInfo.signature.substring(0, 20)}...`);
        
        // Parse transaction
        await this.parseTransaction(sigInfo.signature);
      }

      // Clean up old signatures to prevent memory leak
      if (this.processedSignatures.size > 1000) {
        const toKeep = Array.from(this.processedSignatures).slice(-500);
        this.processedSignatures = new Set(toKeep);
      }
    } catch (error) {
      console.error('Error checking transactions:', error);
    }
  }

  private async parseTransaction(signature: string): Promise<void> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0
      });

      if (!tx || !tx.meta) return;

      // Extract swap details
      const swapInfo = await this.extractSwapDetails(tx);
      
      if (swapInfo) {
        const signal: WalletSignal = {
          action: swapInfo.side,
          wallet: this.targetWallet,
          token: swapInfo.token,
          amount: swapInfo.amount,
          solAmount: swapInfo.solAmount,
          price: swapInfo.price || 0,
          timestamp: tx.blockTime || Math.floor(Date.now() / 1000),
          signature: signature
        };

        console.log(`🔄 ${swapInfo.side.toUpperCase()} Signal detected:`, {
          token: swapInfo.token.substring(0, 10) + '...',
          amount: swapInfo.amount,
          latency: 'Polling mode'
        });

        this.emit('signal', signal);
      }
    } catch (error) {
      console.error('Error parsing transaction:', error);
    }
  }

  private async extractSwapDetails(tx: ParsedTransactionWithMeta): Promise<any> {
    try {
      const preBalances = tx.meta?.preTokenBalances || [];
      const postBalances = tx.meta?.postTokenBalances || [];
      
      // Known DEX program IDs
      const dexPrograms: Record<string, string> = {
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter V6',
        'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB': 'Jupiter V4',
        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium V4',
        'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
        'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CPMM',
        'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium CPMM V2'
      };

      // Check if this is a DEX transaction
      let isDexTx = false;
      for (const instruction of tx.transaction.message.instructions) {
        if ('programId' in instruction) {
          const programId = instruction.programId.toString();
          if (dexPrograms[programId]) {
            isDexTx = true;
            break;
          }
        }
      }

      if (!isDexTx) return null;

      // Calculate token changes
      const tokenChanges = new Map<string, number>();
      
      // Token balance changes
      for (const post of postBalances) {
        const pre = preBalances.find((p: any) => 
          p.accountIndex === post.accountIndex && 
          p.mint === post.mint
        );
        
        if (post.owner === this.targetWallet) {
          const postAmount = post.uiTokenAmount.uiAmount || 0;
          const preAmount = pre?.uiTokenAmount.uiAmount || 0;
          const change = postAmount - preAmount;
          
          if (Math.abs(change) > 0.000001) {
            tokenChanges.set(post.mint, change);
          }
        }
      }
      
      // SOL balance changes
      const accountIndex = tx.transaction.message.accountKeys.findIndex(
        (key: any) => key.pubkey.toString() === this.targetWallet
      );
      
      if (accountIndex >= 0 && tx.meta) {
        const solChange = (tx.meta.postBalances[accountIndex] - tx.meta.preBalances[accountIndex]) / 1e9;
        if (Math.abs(solChange) > 0.000001) {
          tokenChanges.set('So11111111111111111111111111111111111111112', solChange);
        }
      }
      
      // Determine trade direction
      let side: 'buy' | 'sell' = 'buy';
      let token = '';
      let amount = 0;
      let solAmount = 0;
      
      const solMint = 'So11111111111111111111111111111111111111112';
      const solChange = tokenChanges.get(solMint) || 0;
      
      for (const [mint, change] of tokenChanges.entries()) {
        if (mint !== solMint) {
          if (change > 0) {
            // Received tokens = BUY
            side = 'buy';
            token = mint;
            amount = change;
            solAmount = Math.abs(solChange);
          } else if (change < 0) {
            // Sent tokens = SELL
            side = 'sell';
            token = mint;
            amount = Math.abs(change);
            solAmount = Math.abs(solChange);
          }
        }
      }
      
      if (!token) return null;
      
      return {
        side,
        token,
        amount,
        solAmount,
        price: solAmount / amount
      };
    } catch (error) {
      console.error('Error extracting swap details:', error);
      return null;
    }
  }

  async disconnect(): Promise<void> {
    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log('🔄 Polling monitor disconnected');
  }

  async stop(): Promise<void> {
    await this.disconnect();
  }

  leaveRoom(wallet: string): void {
    // Not applicable for polling monitor
    console.log(`🔄 Polling monitor doesn't use rooms (request to leave ${wallet})`);
  }

  isReady(): boolean {
    return this.isRunning;
  }
}