import dotenv from 'dotenv';
import { WalletMonitor } from './services/WalletMonitor';
import { TradeExecutor } from './services/TradeExecutor';
import { PositionManager } from './services/PositionManager';
import { Config, WalletSignal } from './types';

// Load environment variables
dotenv.config();

class CopyTradingBot {
  private config: Config;
  private walletMonitor: WalletMonitor;
  private tradeExecutor: TradeExecutor;
  private positionManager: PositionManager;
  private isRunning = false;

  constructor() {
    // Load configuration
    this.config = {
      targetWallet: process.env.TARGET_WALLET || '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t',
      positionSol: parseFloat(process.env.POSITION_SOL || '0.3'),
      testMode: process.env.TEST_MODE === 'true',
      paperTrading: process.env.PAPER_TRADING !== 'false',
      maxPositions: parseInt(process.env.MAX_POSITIONS || '10'),
      maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS || '-0.7'),
      slippageBps: parseInt(process.env.SLIPPAGE_BPS || '200'),
      minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '5000'),
      executionDelayMs: parseInt(process.env.EXECUTION_DELAY_MS || '500'),
      maxEntryDelaySec: parseInt(process.env.MAX_ENTRY_DELAY_SEC || '10')
    };

    // Initialize services
    this.walletMonitor = new WalletMonitor(
      process.env.WS_URL || '',
      process.env.SOLANATRACKER_API_KEY || '',
      this.config.targetWallet
    );

    this.tradeExecutor = new TradeExecutor(
      process.env.QUICKNODE_RPC || '',
      process.env.METIS_URL || '',
      this.config
    );

    this.positionManager = new PositionManager();

    // Setup signal handlers
    this.setupSignalHandlers();
  }

  private setupSignalHandlers(): void {
    // Handle buy/sell signals from wallet monitor
    this.walletMonitor.on('signal', async (signal: WalletSignal) => {
      await this.handleSignal(signal);
    });

    // Handle process termination
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  private async handleSignal(signal: WalletSignal): Promise<void> {
    try {
      if (signal.action === 'buy') {
        await this.handleBuySignal(signal);
      } else if (signal.action === 'sell') {
        await this.handleSellSignal(signal);
      }
    } catch (error) {
      console.error('Error handling signal:', error);
    }
  }

  private async handleBuySignal(signal: WalletSignal): Promise<void> {
    console.log(`\n🔔 BUY Signal Received: ${signal.tokenSymbol || signal.token.substring(0, 8)}`);
    
    // Check if we already have a position (open or partial)
    if (this.positionManager.isHoldingToken(signal.token)) {
      console.log('   ⚠️ Already holding this token. Will not re-enter until fully exited.');
      return;
    }

    // Check if we can take new position
    if (!this.positionManager.shouldTakeNewPosition(this.config.maxPositions, this.config.maxDailyLoss)) {
      return;
    }

    // Check liquidity
    const liquidity = await this.tradeExecutor.checkTokenLiquidity(signal.token);
    if (liquidity < this.config.minLiquidityUsd) {
      console.log(`   ⚠️ Insufficient liquidity ($${liquidity.toFixed(0)} < $${this.config.minLiquidityUsd})`);
      return;
    }

    // Execute buy
    const txHash = await this.tradeExecutor.executeBuy(signal);
    if (txHash) {
      // Record position
      this.positionManager.openPosition(signal, txHash, this.config.positionSol);
      
      console.log(`   ✅ Position opened with tx: ${txHash}`);
    } else {
      console.log(`   ❌ Failed to execute buy`);
    }
  }

  private async handleSellSignal(signal: WalletSignal): Promise<void> {
    console.log(`\n🔔 SELL Signal Received: ${signal.tokenSymbol || signal.token.substring(0, 8)}`);
    
    // Check if we have a position
    const position = this.positionManager.getPosition(signal.token);
    if (!position) {
      console.log('   ⚠️ No position in this token');
      return;
    }

    // Execute sell
    const txHash = await this.tradeExecutor.executeSell(signal, position.amount);
    if (txHash) {
      // Close position
      this.positionManager.closePosition(signal.token, signal.price, txHash);
      
      console.log(`   ✅ Position closed with tx: ${txHash}`);
      
      // Print updated statistics
      const stats = this.positionManager.getStatistics();
      console.log(`\n📊 Updated Stats: ${stats.totalWins}W/${stats.totalLosses}L, Daily P&L: ${stats.dailyPnL.toFixed(4)} SOL`);
    } else {
      console.log(`   ❌ Failed to execute sell`);
    }
  }

  async start(): Promise<void> {
    console.log('🚀 Copy Trading Bot Starting...');
    console.log('================================');
    console.log(`Target Wallet: ${this.config.targetWallet.substring(0, 20)}...`);
    console.log(`Position Size: ${this.config.positionSol} SOL`);
    console.log(`Mode: ${this.config.paperTrading ? 'PAPER TRADING' : 'LIVE TRADING'}`);
    console.log(`Max Positions: ${this.config.maxPositions}`);
    console.log(`Max Daily Loss: ${(this.config.maxDailyLoss * 100).toFixed(0)}%`);
    console.log('================================\n');

    this.isRunning = true;

    try {
      // Connect to WebSocket
      await this.walletMonitor.connect();
      
      console.log('✅ Bot is running. Waiting for signals...\n');
      
      // Print statistics every 5 minutes
      setInterval(() => {
        if (this.isRunning) {
          this.positionManager.exportResults();
        }
      }, 300000);

    } catch (error) {
      console.error('Failed to start bot:', error);
      this.shutdown();
    }
  }

  private shutdown(): void {
    console.log('\n🛑 Shutting down...');
    this.isRunning = false;
    
    // Disconnect services
    this.walletMonitor.disconnect();
    
    // Export final results
    this.positionManager.exportResults();
    
    console.log('Goodbye! 👋');
    process.exit(0);
  }
}

// Start the bot
const bot = new CopyTradingBot();
bot.start().catch(console.error);