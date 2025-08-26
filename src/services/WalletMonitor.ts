import axios from 'axios';
import EventEmitter from 'events';
import { WalletSignal } from '../types';

export class WalletMonitor extends EventEmitter {
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly apiKey: string;
  private readonly targetWallet: string;
  private isRunning = false;
  private lastSeenTx = new Set<string>();
  private pollIntervalMs = 2000; // Poll every 2 seconds
  private isFirstPoll = true;

  constructor(wsUrl: string, apiKey: string, targetWallet: string) {
    super();
    this.apiKey = apiKey;
    this.targetWallet = targetWallet;
    // Note: wsUrl not used in polling mode
  }

  async connect(): Promise<void> {
    console.log(`📡 Starting wallet monitor for ${this.targetWallet.substring(0, 8)}...`);
    console.log(`   Mode: Polling (${this.pollIntervalMs}ms interval)`);
    
    this.isRunning = true;
    
    // Start polling
    this.startPolling();
    
    console.log('✅ Wallet monitor started');
    return Promise.resolve();
  }

  private startPolling(): void {
    this.poll(); // Initial poll
    
    this.pollTimer = setInterval(() => {
      if (this.isRunning) {
        this.poll();
      }
    }, this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    try {
      const response = await axios.get(
        `https://data.solanatracker.io/wallet/${this.targetWallet}/trades`,
        {
          headers: { 'x-api-key': this.apiKey },
          params: { limit: 10 },
          timeout: 5000
        }
      );

      const trades = response.data.trades || response.data || [];
      
      // On first poll, just mark all as seen without processing
      if (this.isFirstPoll) {
        console.log(`   Initializing with ${trades.length} recent trades...`);
        for (const trade of trades) {
          const txId = trade.tx || trade.signature;
          if (txId) {
            this.lastSeenTx.add(txId);
          }
        }
        this.isFirstPoll = false;
        return;
      }
      
      // Process only NEW trades (not in lastSeenTx)
      for (const trade of trades) {
        const txId = trade.tx || trade.signature;
        if (txId && !this.lastSeenTx.has(txId)) {
          this.lastSeenTx.add(txId);
          this.processTrade(trade);
          
          // Keep set size manageable
          if (this.lastSeenTx.size > 1000) {
            const arr = Array.from(this.lastSeenTx);
            this.lastSeenTx = new Set(arr.slice(-500));
          }
        }
      }
    } catch (error: any) {
      if (error.response?.status !== 429) { // Ignore rate limit errors
        console.error('Polling error:', error.message);
      }
    }
  }

  private processTrade(trade: any): void {
    try {
      // Parse trade based on Solana Tracker format
      const SOL = 'So11111111111111111111111111111111111111112';
      
      let signal: WalletSignal | null = null;
      
      // Determine if buy or sell
      if (trade.from?.address === SOL || trade.from?.token?.symbol === 'SOL') {
        // Buy signal
        signal = {
          wallet: this.targetWallet,
          action: 'buy',
          token: trade.to?.address || trade.to?.token?.address,
          tokenSymbol: trade.to?.token?.symbol,
          amount: trade.to?.amount || 0,
          solAmount: trade.from?.amount || 0,
          price: trade.to?.priceUsd || 0,
          timestamp: trade.timestamp || Date.now() / 1000,
          signature: trade.signature || trade.tx
        };
      } else if (trade.to?.address === SOL || trade.to?.token?.symbol === 'SOL') {
        // Sell signal
        signal = {
          wallet: this.targetWallet,
          action: 'sell',
          token: trade.from?.address || trade.from?.token?.address,
          tokenSymbol: trade.from?.token?.symbol,
          amount: trade.from?.amount || 0,
          solAmount: trade.to?.amount || 0,
          price: trade.from?.priceUsd || 0,
          timestamp: trade.timestamp || Date.now() / 1000,
          signature: trade.signature || trade.tx
        };
      }

      if (signal && signal.token) {
        console.log(`\n🎯 ${signal.action.toUpperCase()} Signal: ${signal.tokenSymbol || signal.token.substring(0, 8)}`);
        console.log(`   Amount: ${signal.solAmount.toFixed(4)} SOL`);
        console.log(`   Price: $${signal.price}`);
        
        this.emit('signal', signal);
      }
    } catch (error) {
      console.error('Error processing trade:', error);
    }
  }

  disconnect(): void {
    this.isRunning = false;
    
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    
    console.log('Wallet monitor stopped');
  }
}