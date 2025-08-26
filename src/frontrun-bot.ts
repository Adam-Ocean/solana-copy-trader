#!/usr/bin/env node
/**
 * Frontrun Dump Bot
 * 
 * Strategy: When dump wallets receive free tokens, buy small amount
 * and exit before they dump (usually 2-6 hours)
 */

import dotenv from 'dotenv';
import axios from 'axios';
import { FrontrunDumpStrategy, RiskManager } from './strategies/FrontrunDumpStrategy';

dotenv.config();

// Known dump wallets (add more as you find them)
const DUMP_WALLETS = [
  '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t', // Your monitored wallet
  // Add more dump wallets here as you identify them
];

class FrontrunBot {
  private strategy: FrontrunDumpStrategy;
  private riskManager: RiskManager;
  private positions: Map<string, any> = new Map();
  private pollInterval = 10000; // Check every 10 seconds
  private isRunning = false;
  private lastChecked: Map<string, Set<string>> = new Map();

  constructor() {
    this.strategy = new FrontrunDumpStrategy(
      process.env.SOLANATRACKER_API_KEY || '',
      DUMP_WALLETS
    );
    this.riskManager = new RiskManager();
    
    // Listen for pump signals
    this.strategy.on('pumpSignal', (signal) => this.handleSignal(signal));
  }

  private async handleSignal(signal: any): Promise<void> {
    console.log('\n' + '='.repeat(50));
    console.log('🚨 PUMP SIGNAL DETECTED');
    console.log('='.repeat(50));
    console.log(`Token: ${signal.symbol} (${signal.token.substring(0, 12)}...)`);
    console.log(`Confidence: ${signal.confidence.toUpperCase()}`);
    console.log(`Risk Level: ${signal.riskLevel}/10`);
    console.log(`Reason: ${signal.reason}`);
    console.log(`Suggested: ${signal.suggestedAction.toUpperCase()}`);
    console.log(`Exit within: ${signal.timeToExit} hours`);
    console.log('='.repeat(50));

    // Check if we should take the trade
    if (this.riskManager.shouldTakeTrade(signal, this.positions.size)) {
      const size = this.riskManager.getPositionSize(signal);
      const exitStrategy = this.riskManager.getExitStrategy(signal);
      
      console.log(`\n✅ TAKING POSITION`);
      console.log(`Size: ${size} SOL`);
      console.log(`Stop Loss: ${exitStrategy.stopLoss}%`);
      console.log(`Take Profit: ${exitStrategy.takeProfit}%`);
      console.log(`Auto-exit in: ${signal.timeToExit} hours`);
      
      // In production, execute the trade here
      this.positions.set(signal.token, {
        ...signal,
        entryTime: Date.now(),
        size,
        exitStrategy,
        autoExitTime: Date.now() + exitStrategy.timeLimit
      });
      
      // Set auto-exit timer
      setTimeout(() => {
        console.log(`\n⏰ Auto-exiting ${signal.symbol} (time limit reached)`);
        this.exitPosition(signal.token);
      }, exitStrategy.timeLimit);
      
    } else {
      console.log(`\n❌ SKIPPING - Risk management criteria not met`);
    }
  }

  private exitPosition(token: string): void {
    const position = this.positions.get(token);
    if (position) {
      console.log(`Closing position: ${position.symbol}`);
      this.positions.delete(token);
    }
  }

  async checkForFreeTokens(): Promise<void> {
    for (const wallet of DUMP_WALLETS) {
      try {
        // Get recent trades
        const response = await axios.get(
          `https://data.solanatracker.io/wallet/${wallet}/trades?limit=20`,
          {
            headers: { 'x-api-key': process.env.SOLANATRACKER_API_KEY },
            timeout: 5000
          }
        );

        const trades = response.data.trades || response.data || [];
        
        // Initialize seen set for this wallet
        if (!this.lastChecked.has(wallet)) {
          this.lastChecked.set(wallet, new Set());
          // Mark all current as seen on first run
          trades.forEach((t: any) => {
            const id = t.tx || t.signature;
            if (id) this.lastChecked.get(wallet)?.add(id);
          });
          return;
        }

        const seenTxs = this.lastChecked.get(wallet)!;
        
        // Check for new SELL trades (indicates token was received for free)
        for (const trade of trades) {
          const txId = trade.tx || trade.signature;
          if (txId && !seenTxs.has(txId)) {
            seenTxs.add(txId);
            
            // Check if it's a sell without previous buy
            const SOL = 'So11111111111111111111111111111111111111112';
            if (trade.to?.address === SOL) {
              // This is a SELL - check if we've seen a buy for this token
              const token = trade.from?.address;
              const symbol = trade.from?.token?.symbol || 'Unknown';
              
              // Look for previous buys of this token in recent history
              const hasPreviousBuy = trades.some((t: any) => 
                t.from?.address === SOL && t.to?.address === token
              );
              
              if (!hasPreviousBuy && token) {
                console.log(`\n🎯 FREE TOKEN DETECTED: ${symbol}`);
                console.log(`   Wallet ${wallet.substring(0, 8)}... received and is selling`);
                
                // Analyze as pump signal
                await this.strategy.analyzeFreeTokenReceipt({
                  token,
                  symbol,
                  amount: trade.from?.amount || 0,
                  from: 'unknown',
                  timestamp: Date.now() / 1000,
                  type: 'transfer'
                });
              }
            }
          }
        }
      } catch (error: any) {
        if (error.response?.status !== 429) {
          console.error(`Error checking wallet ${wallet.substring(0, 8)}:`, error.message);
        }
      }
    }
  }

  async start(): Promise<void> {
    console.log('🚀 Frontrun Dump Bot Starting...');
    console.log('================================');
    console.log(`Monitoring ${DUMP_WALLETS.length} dump wallets`);
    console.log(`Check interval: ${this.pollInterval / 1000}s`);
    console.log(`Max positions: 3`);
    console.log(`Risk per trade: 0.03-0.1 SOL`);
    console.log('================================\n');
    
    this.isRunning = true;
    
    // Initial check
    await this.checkForFreeTokens();
    
    // Start polling
    const pollTimer = setInterval(async () => {
      if (this.isRunning) {
        await this.checkForFreeTokens();
        
        // Check position exits
        this.positions.forEach((pos, token) => {
          const holdTime = (Date.now() - pos.entryTime) / 1000 / 60; // minutes
          if (holdTime > 5) {
            // Check price and exit conditions
            // In production, check actual P&L here
          }
        });
      }
    }, this.pollInterval);
    
    // Handle shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down...');
      this.isRunning = false;
      clearInterval(pollTimer);
      
      if (this.positions.size > 0) {
        console.log(`⚠️ Open positions: ${this.positions.size}`);
        this.positions.forEach(p => {
          console.log(`  - ${p.symbol}: ${p.size} SOL`);
        });
      }
      
      process.exit(0);
    });
    
    console.log('Bot is running. Press Ctrl+C to stop.\n');
  }
}

// Start the bot
const bot = new FrontrunBot();
bot.start().catch(console.error);