import EventEmitter from 'events';
import { Datastream } from '@solana-tracker/data-api';
import { WalletSignal } from '../types/enhanced';

export class EnhancedWalletMonitor extends EventEmitter {
  private dataStream: Datastream;
  private targetWallets: Set<string>;
  private isRunning = false;
  private subscriptions: Map<string, any> = new Map();
  private transactions: Set<string> = new Set();
  private traderPositions: Map<string, Map<string, number>> = new Map(); // wallet -> token -> amount

  constructor(
    private wsUrl: string,
    private apiKey: string,
    targetWallets: string[]
  ) {
    super();
    this.targetWallets = new Set(targetWallets);
    
    // Initialize Datastream with Solana Tracker SDK
    this.dataStream = new Datastream({
      wsUrl: this.wsUrl,
      autoReconnect: true,
      reconnectDelay: 2500,
      reconnectDelayMax: 10000,
      randomizationFactor: 0.5,
      useWorker: false // Don't use worker in Node.js
    });

    // Set up connection event handlers
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.dataStream.on('connected', () => {
      console.log('✅ Connected to Solana Tracker Datastream');
      // Add delay to ensure connection is stable before subscribing
      setTimeout(() => {
        this.subscribeToWallets();
      }, 1000);
    });

    this.dataStream.on('disconnected', (type: string) => {
      console.log(`🔌 Disconnected from Datastream (${type})`);
    });

    this.dataStream.on('reconnecting', (attempts: number) => {
      console.log(`🔄 Reconnecting to Datastream (attempt ${attempts})`);
    });

    this.dataStream.on('error', (error: any) => {
      console.error('❌ Datastream error:', error);
    });
  }

  private subscribeToWallets(): void {
    // Subscribe to each wallet's transactions
    for (const wallet of this.targetWallets) {
      if (!this.subscriptions.has(wallet)) {
        console.log(`   Subscribing to wallet: ${wallet}`);
        
        const subscription = this.dataStream.subscribe.tx.wallet(wallet)
          .transactions()
          .on((data: any) => {
            this.processWalletTransaction(data);
          });
        
        this.subscriptions.set(wallet, subscription);
      }
    }
  }

  async connect(): Promise<void> {
    console.log('🔌 Connecting to Solana Tracker Datastream...');
    console.log(`   URL: ${this.wsUrl.substring(0, 50)}...`);
    this.isRunning = true;
    
    try {
      await this.dataStream.connect();
      // Wait a moment for the connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Only show success message once
      if (this.dataStream.isConnected()) {
        console.log('✅ Bot is running. Waiting for signals...\n');
        console.log('📱 Dashboard available at: http://localhost:3000');
      }
    } catch (error: any) {
      console.error('❌ Error connecting to Datastream:', error.message);
      throw error;
    }
  }

  private processWalletTransaction(data: any): void {
    try {
      // Log ALL transactions to debug - show full structure
      console.log(`\n📝 Raw transaction received:`);
      console.log(JSON.stringify(data, null, 2));

      // Deduplicate transactions
      if (data.tx && this.transactions.has(data.tx)) {
        console.log('   ⏭️  Duplicate transaction, skipping');
        return;
      }
      if (data.tx) {
        this.transactions.add(data.tx);
        
        // Clean up old transactions
        if (this.transactions.size > 1000) {
          const arr = Array.from(this.transactions);
          this.transactions = new Set(arr.slice(-500));
        }
      }

      // Process the transaction based on type
      if (data.type === 'buy' || data.type === 'sell') {
        const isBuy = data.type === 'buy';
        
        // For the new format: buy = SOL -> Token (to is token), sell = Token -> SOL (from is token)
        const tokenInfo = isBuy ? data.to?.token : data.from?.token;
        const tokenAddress = isBuy ? data.to?.address : data.from?.address;
        
        if (!tokenInfo || !tokenAddress) {
          console.log('   ⚠️  No token info, skipping');
          return;
        }
        
        // Don't emit signals for stablecoins or SOL
        const IGNORED_TOKENS = [
          'So11111111111111111111111111111111111111112', // SOL
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
          'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
        ];
        
        if (IGNORED_TOKENS.includes(tokenAddress)) {
          console.log('   ⏭️  Ignored token (SOL/USDC/USDT), skipping');
          return;
        }
        
        // Track trader's position
        if (!this.traderPositions.has(data.wallet)) {
          this.traderPositions.set(data.wallet, new Map());
        }
        const walletPositions = this.traderPositions.get(data.wallet)!;
        
        const tokenAmount = tokenInfo.amount || 0;
        let traderTotalBefore = walletPositions.get(tokenAddress) || 0;
        
        if (isBuy) {
          // Add to trader's position
          walletPositions.set(tokenAddress, traderTotalBefore + tokenAmount);
          console.log(`   Trader position: ${(traderTotalBefore + tokenAmount).toFixed(2)} tokens (added ${tokenAmount.toFixed(2)})`);
        } else {
          // For sells, if we don't have accurate tracking, assume full exit if selling most
          // This is more conservative and safer
          const sellPercent = traderTotalBefore > 0 ? (tokenAmount / traderTotalBefore) * 100 : 100;
          
          // If trader is selling more than we think they have, they must have bought more elsewhere
          if (tokenAmount > traderTotalBefore && traderTotalBefore > 0) {
            console.log(`   ⚠️ Trader selling ${tokenAmount.toFixed(2)} but we only tracked ${traderTotalBefore.toFixed(2)}`);
            console.log(`   ⚠️ Treating as 100% exit of our mirrored position`);
            walletPositions.set(tokenAddress, 0);
            // Override to 100% for safety
            traderTotalBefore = tokenAmount;
          } else {
            const newAmount = Math.max(0, traderTotalBefore - tokenAmount);
            walletPositions.set(tokenAddress, newAmount);
            console.log(`   Trader sold ${tokenAmount.toFixed(2)}/${traderTotalBefore.toFixed(2)} tokens (${sellPercent.toFixed(1)}%)`);
            console.log(`   Trader remaining: ${newAmount.toFixed(2)} tokens`);
          }
        }
        
        const signal: WalletSignal = {
          wallet: data.wallet,
          action: data.type as 'buy' | 'sell',
          token: tokenAddress,
          tokenSymbol: tokenInfo.symbol,
          tokenName: tokenInfo.name,
          amount: tokenAmount,
          solAmount: data.volume?.sol || 0,
          price: tokenInfo.price?.usd || data.price?.usd || 0,
          priceUsd: tokenInfo.price?.usd || data.price?.usd,
          timestamp: data.time ? data.time / 1000 : Date.now() / 1000,
          signature: data.tx,
          // Use the second pool address if available (first is often the common SOL pool)
          poolId: data.pools?.[1] || data.pools?.[0],
          liquidity: data.liquidity,
          marketCap: data.marketCap,
          priceImpact: data.priceImpactPercent,
          // Add trader position info for proportional exits
          traderTotalTokens: traderTotalBefore, // Total BEFORE this trade
          traderSoldTokens: isBuy ? 0 : tokenAmount
        };
        
        console.log(`\n🎯 ${signal.action.toUpperCase()} Signal Detected:`);
        console.log(`   Token: ${signal.tokenSymbol} (${signal.token.substring(0, 8)}...)`);
        console.log(`   Amount: ${signal.amount.toFixed(4)} tokens`);
        console.log(`   Volume: ${signal.solAmount.toFixed(4)} SOL`);
        console.log(`   Price: $${signal.priceUsd || signal.price}`);
        console.log(`   Pool ID: ${signal.poolId || 'not found'}`);
        console.log(`   Program: ${data.program || 'unknown'}`);
        
        this.emit('signal', signal);
      }
      
      // Always emit raw transaction for monitoring
      this.emit('transaction', data);
      
    } catch (error) {
      console.error('Error processing wallet transaction:', error);
    }
  }

  public subscribeToPriceUpdates(tokenAddress: string): void {
    if (!this.subscriptions.has(`price:${tokenAddress}`)) {
      const subscription = this.dataStream.subscribe.price.token(tokenAddress)
        .on((data: any) => {
          this.emit('price_update', {
            token: tokenAddress,
            price: data.price,
            time: data.time
          });
        });
      
      this.subscriptions.set(`price:${tokenAddress}`, subscription);
      console.log(`   Subscribed to price updates for: ${tokenAddress}`);
    }
  }

  public subscribeToPoolUpdates(poolId: string): void {
    if (!this.subscriptions.has(`pool:${poolId}`)) {
      const subscription = this.dataStream.subscribe.pool(poolId)
        .on((data: any) => {
          this.emit('pool_update', data);
        });
      
      this.subscriptions.set(`pool:${poolId}`, subscription);
      console.log(`   Subscribed to pool updates for: ${poolId}`);
    }
  }

  public addWallet(wallet: string): void {
    this.targetWallets.add(wallet);
    if (this.isRunning && this.dataStream.isConnected()) {
      const subscription = this.dataStream.subscribe.tx.wallet(wallet)
        .transactions()
        .on((data: any) => {
          this.processWalletTransaction(data);
        });
      
      this.subscriptions.set(wallet, subscription);
      console.log(`   Added wallet subscription: ${wallet}`);
    }
  }

  public removeWallet(wallet: string): void {
    this.targetWallets.delete(wallet);
    const subscription = this.subscriptions.get(wallet);
    if (subscription) {
      subscription.unsubscribe();
      this.subscriptions.delete(wallet);
      console.log(`   Removed wallet subscription: ${wallet}`);
    }
  }

  async stop(): Promise<void> {
    console.log('\n🛑 Stopping wallet monitor...');
    this.isRunning = false;
    
    // Unsubscribe from all subscriptions
    for (const [key, subscription] of this.subscriptions) {
      subscription.unsubscribe();
    }
    this.subscriptions.clear();
    
    // Disconnect from datastream
    this.dataStream.disconnect();
    
    console.log('✅ Wallet monitor stopped');
  }

  // Compatibility methods for existing code
  public joinRoom(room: string): void {
    // Parse room type and subscribe accordingly
    if (room.startsWith('wallet:')) {
      const wallet = room.replace('wallet:', '');
      this.addWallet(wallet);
    } else if (room.startsWith('price:') || room.startsWith('price-by-token:')) {
      const token = room.replace('price:', '').replace('price-by-token:', '');
      this.subscribeToPriceUpdates(token);
    } else if (room.startsWith('pool:')) {
      const pool = room.replace('pool:', '');
      this.subscribeToPoolUpdates(pool);
    }
  }

  public leaveRoom(room: string): void {
    // Parse room type and unsubscribe accordingly
    if (room.startsWith('wallet:')) {
      const wallet = room.replace('wallet:', '');
      this.removeWallet(wallet);
    } else {
      const subscription = this.subscriptions.get(room);
      if (subscription) {
        subscription.unsubscribe();
        this.subscriptions.delete(room);
        console.log(`   Left room: ${room}`);
      }
    }
  }
}