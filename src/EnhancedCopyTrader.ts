import dotenv from 'dotenv';
import { Connection, Keypair } from '@solana/web3.js';
import { QuickNodeWalletMonitor } from './services/QuickNodeWalletMonitor';
import { EnhancedWalletMonitor } from './services/EnhancedWalletMonitor';
import { NextBlockExecutor } from './services/NextBlockExecutor';
import { EnhancedPositionManager } from './services/EnhancedPositionManager';
import { DashboardWebSocketServer } from './services/DashboardWebSocketServer';
import { DatabaseService } from './services/DatabaseService';
import { TelegramAlerts } from './services/TelegramAlerts';
import { YellowstoneWalletMonitor } from './services/YellowstoneWalletMonitor';
import { 
  WalletSignal, 
  TradeExecution, 
  DashboardConfig,
  NextBlockConfig,
  Position
} from './types/enhanced';

dotenv.config();

export class EnhancedCopyTrader {
  private walletMonitor: QuickNodeWalletMonitor | EnhancedWalletMonitor | YellowstoneWalletMonitor;
  private executor: NextBlockExecutor;
  private positionManager: EnhancedPositionManager;
  private dashboardServer: DashboardWebSocketServer;
  private databaseService: DatabaseService;
  private connection: Connection;
  private config: DashboardConfig;
  private isRunning = false;
  private isPaused = false;
  private priceUpdateInterval: NodeJS.Timeout | null = null;
  private useQuickNode = true; // Default to QuickNode
  private telegramAlerts: TelegramAlerts;
  private useYellowstone = false;

  constructor() {
    // Initialize connection - use only QuickNode RPC
    const rpcUrl = process.env.QUICKNODE_RPC || '';
    if (!rpcUrl) {
      console.error('❌ No RPC URL configured. Please set QUICKNODE_RPC environment variable.');
      process.exit(1);
    }
    
    console.log(`🔗 Connecting to Solana RPC: ${rpcUrl.substring(0, 50)}...`);
    this.connection = new Connection(rpcUrl, 'confirmed');

    // Initialize config
    this.config = {
      
      partialExitEnabled: process.env.PARTIAL_EXIT_ENABLED === 'true',
      partialExitPercent: [25, 50, 75],
      
      maxPositions: parseInt(process.env.MAX_POSITIONS || '20'),
      positionSize: parseFloat(process.env.POSITION_SOL || '0.5'),
      paperTrading: process.env.PAPER_TRADING !== 'false',
      copyTrading: true,
      globalStop: false
    };

    // Initialize NextBlock config with all endpoints
    const nextBlockConfig: NextBlockConfig = {
      apiKey: process.env.NEXT_BLOCK_API_KEY || '',
      endpoints: process.env.NEXT_BLOCK_ENDPOINTS?.split(',') || [
        'ny.nextblock.io',
        'fra.nextblock.io',
        'slc.nextblock.io',
        'tokyo.nextblock.io',
        'london.nextblock.io'
      ],
      useGRPC: process.env.NEXT_BLOCK_USE_GRPC === 'true',
      antiMEV: process.env.NEXT_BLOCK_USE_ANTI_MEV !== 'false',
      priorityFee: parseFloat(process.env.MIN_PRIORITY_FEE || '0.001'),
      tipWallets: []
    };

    // Initialize wallet monitor - prefer Yellowstone > QuickNode > SolanaTracker
    const targetWallets = [process.env.TARGET_WALLET || ''];
    const yellowstoneGrpc = process.env.YELLOWSTONE_GRPC || process.env.YELLOWSTONE_GRPC_URL;
    
    // Check if Yellowstone is configured and enabled
    if (yellowstoneGrpc && process.env.USE_YELLOWSTONE === 'true') {
      console.log('🟡 Using Yellowstone gRPC for ultra-low latency monitoring (<5ms)');
      this.walletMonitor = new YellowstoneWalletMonitor(yellowstoneGrpc, targetWallets[0], this.connection);
      this.useYellowstone = true;
      this.useQuickNode = false;
    } else if (this.useQuickNode && rpcUrl) {
      console.log('🚀 Using QuickNode WebSocket for real-time monitoring (10-12ms latency)');
      this.walletMonitor = new QuickNodeWalletMonitor(rpcUrl, targetWallets);
    } else if (process.env.WS_URL && process.env.SOLANATRACKER_API_KEY) {
      console.log('📡 Falling back to SolanaTracker WebSocket');
      this.walletMonitor = new EnhancedWalletMonitor(
        process.env.WS_URL,
        process.env.SOLANATRACKER_API_KEY,
        targetWallets
      );
    } else {
      console.error('❌ No wallet monitoring service configured');
      console.error('   Set YELLOWSTONE_GRPC, QUICKNODE_RPC or (WS_URL + SOLANATRACKER_API_KEY)');
      process.exit(1);
    }

    this.executor = new NextBlockExecutor(
      nextBlockConfig,
      this.connection,
      process.env.METIS_URL || '',
      process.env.WALLET_SECRET_KEY
    );

    // Initialize position manager with Birdeye WebSocket config if available
    const birdeyeConfig = process.env.BIRDEYE_API_KEY ? {
      apiKey: process.env.BIRDEYE_API_KEY,
      chain: 'solana' as const
    } : undefined;
    
    this.positionManager = new EnhancedPositionManager(this.config, birdeyeConfig);

    // Use WS_SERVER_PORT (4791) from .env, fallback to 4790
    const wsPort = parseInt(process.env.WS_SERVER_PORT || '4790');
    this.dashboardServer = new DashboardWebSocketServer(wsPort, birdeyeConfig);

    // Initialize database service
    this.databaseService = new DatabaseService();
    
    // Initialize Telegram alerts
    this.telegramAlerts = new TelegramAlerts();

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Wallet monitor events
    this.walletMonitor.on('signal', async (signal: WalletSignal) => {
      if (!this.isPaused && this.config.copyTrading) {
        await this.handleSignal(signal);
      }
      this.dashboardServer.broadcastSignal(signal);
      
      // Also broadcast as trader transaction for dashboard display
      this.dashboardServer.broadcastTraderTransaction({
        type: signal.action === 'buy' ? 'BUY' : 'SELL',
        token: signal.token,
        tokenSymbol: signal.tokenSymbol || signal.token.substring(0, 8),
        amount: signal.solAmount || signal.amount,
        price: signal.price || 0,
        trader: signal.wallet || 'Unknown',
        txHash: signal.signature
      });
    });

    this.walletMonitor.on('price_update', async (data: any) => {
      await this.positionManager.updatePrice(data.token, data.price);
      this.dashboardServer.updateMarketData(data.token, {
        price: data.price,
        priceChange24h: data.priceChange24h,
        volume24h: data.volume24h,
        liquidity: data.liquidity,
        marketCap: data.marketCap
      });
    });

    // Position manager events
    this.positionManager.on('position_opened', (position: Position) => {
      this.dashboardServer.addPosition(position);
      // Handle different monitor types for price updates
      if (this.walletMonitor instanceof QuickNodeWalletMonitor) {
        this.walletMonitor.subscribeToPriceUpdates([position.token]);
      } else if (this.walletMonitor instanceof EnhancedWalletMonitor) {
        (this.walletMonitor as EnhancedWalletMonitor).subscribeToPriceUpdates(position.token);
      } else if (this.walletMonitor instanceof YellowstoneWalletMonitor) {
        // Yellowstone uses Birdeye for prices, handled separately
        this.walletMonitor.subscribeToPriceUpdates(position.token);
      }
      this.updateDashboardStats();
    });

    // Update dashboard stats dynamically based on positions
    setInterval(() => {
      this.updateDashboardStats();
    }, 1000); // Stats update every 1 second is sufficient

    this.positionManager.on('position_update', (position: Position) => {
      this.dashboardServer.updatePosition(position);
    });

    this.positionManager.on('position_closed', (position: Position) => {
      this.dashboardServer.removePosition(position.token);
      this.walletMonitor.leaveRoom(`price:${position.token}`);
      this.updateDashboardStats();
    });

    // Automatic exit handling removed (copy-only strategy)

    this.positionManager.on('stats_update', (stats: any) => {
      // Update bot status
      this.dashboardServer.updateBotStatus({
        activePositions: stats.openPositions,
        totalPositions: stats.totalPositions,
        dailyPnL: stats.dailyPnL,
        dailyPnLPercent: stats.dailyPnLPercent,
        totalPnL: stats.totalPnL,
        winRate: stats.winRate,
        avgWin: stats.avgWinAmount,
        avgLoss: stats.avgLossAmount,
        solPrice: stats.solPrice
      });
      
      // Also broadcast stats_update directly
      this.dashboardServer.broadcast({
        type: 'stats_update',
        data: stats,
        timestamp: Date.now()
      });
    });

    // Dashboard server events
    this.dashboardServer.on('manual_buy', async (payload: any) => {
      await this.executeManualBuy(payload);
    });

    this.dashboardServer.on('manual_sell', async (payload: any) => {
      await this.executeManualSell(payload);
    });

    this.dashboardServer.on('partial_exit', async (payload: any) => {
      await this.executePartialExit(payload);
    });

    this.dashboardServer.on('close_position', async (payload: any) => {
      await this.closePosition(payload.token);
    });

    this.dashboardServer.on('close_all_positions', async () => {
      await this.closeAllPositions();
    });

    this.dashboardServer.on('pause_bot', () => {
      this.isPaused = true;
      console.log('⏸️ Bot paused');
    });

    this.dashboardServer.on('resume_bot', () => {
      this.isPaused = false;
      console.log('▶️ Bot resumed');
    });

    this.dashboardServer.on('update_config', (config: Partial<DashboardConfig>) => {
      this.config = { ...this.config, ...config };
      this.positionManager.updateConfig(config);
      this.dashboardServer.updateConfig(this.config);
      console.log('⚙️ Configuration updated');
    });

    this.dashboardServer.on('emergency_stop', async () => {
      await this.emergencyStop();
    });

    // Process termination
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
    console.log(`\n🔔 BUY Signal: ${signal.tokenSymbol || signal.token.substring(0, 8)}`);
    console.log(`   Token: ${signal.token}`);
    console.log(`   Amount: ${signal.solAmount} SOL`);
    console.log(`   Trader tokens: ${signal.traderTotalTokens || 0}`);

    // RULE 1: Skip if trader already had the token (not a new entry)
    if (signal.traderTotalTokens && signal.traderTotalTokens > signal.amount) {
      console.log('   ⚠️ Trader already had this token. Not a new entry, skipping.');
      return;
    }

    // RULE 2: Skip if trade amount is below 0.5 SOL
    if (signal.solAmount < 0.5) {
      console.log(`   ⚠️ Trade amount too small: ${signal.solAmount.toFixed(3)} SOL < 0.5 SOL minimum`);
      return;
    }

    // Check if we already have a position (open or partial)
    if (this.positionManager.isHoldingToken(signal.token)) {
      console.log('   ⚠️ Already holding this token. Will not re-enter until fully exited.');
      return;
    }

    // Check if we can take new position
    if (!this.positionManager.shouldTakeNewPosition(
      this.config.maxPositions,
      parseFloat(process.env.MAX_DAILY_LOSS || '-0.7')
    )) {
      return;
    }

    // Skip liquidity check for copy trading - we trade what the target trades!

    // Get quote
    const amountInLamports = this.config.positionSize * 1e9;
    const slippageBps = parseInt(process.env.SLIPPAGE_BPS || '200');
    
    console.log(`   📊 Getting quote for ${this.config.positionSize} SOL -> ${signal.tokenSymbol || 'token'}`);
    const quote = await this.executor.getQuote(
      'So11111111111111111111111111111111111111112', // SOL
      signal.token,
      amountInLamports,
      slippageBps
    );

    if (!quote) {
      console.log('   ❌ Failed to get quote from exchange');
      return;
    }
    console.log(`   ✅ Got quote: ${quote.outAmount || quote.otherAmountThreshold || 0} tokens`)

    // Derive expected tokens from quote (preferred over USD math)
    const solValueUSD = this.config.positionSize * this.positionManager.getSolPrice();
    const outAmountRaw = (quote.outAmount ?? quote.otherAmountThreshold ?? '0').toString();
    // Prefer mint decimals via RPC if quote decimals are missing
    let outDecimals = (quote.outDecimals ?? quote.outputDecimals ?? (quote.routePlan?.[0]?.swapInfo?.outToken?.decimals)) as number | undefined;
    if (outDecimals === undefined) {
      try {
        const mintInfo = await this.connection.getParsedAccountInfo(new (require('@solana/web3.js').PublicKey)(signal.token));
        const mintData: any = mintInfo.value?.data;
        const decimalsCandidate = mintData?.parsed?.info?.decimals;
        if (typeof decimalsCandidate === 'number') {
          outDecimals = decimalsCandidate;
        }
      } catch {}
    }
    const parsedOut = Number(outAmountRaw);
    let ourTokenAmount = 0;
    if (outAmountRaw.includes('.')) {
      // Already a UI amount
      ourTokenAmount = isFinite(parsedOut) ? parsedOut : 0;
    } else if (isFinite(parsedOut)) {
      if (outDecimals !== undefined && parsedOut > 1e6) {
        // Likely atomic units
        ourTokenAmount = parsedOut / Math.pow(10, outDecimals);
      } else if (outDecimals !== undefined && outDecimals >= 6 && parsedOut < 1e6) {
        // Small integer with high decimals usually indicates UI amount from some providers
        ourTokenAmount = parsedOut;
      } else {
        // Fallback
        ourTokenAmount = parsedOut;
      }
    }
    
    // Calculate slippage estimate
    let displaySlippage = 0;
    
    // For paper trades, estimate slippage based on:
    // 1. Price impact from quote
    // 2. Add estimated execution delay (0.5-2% typical)
    const priceImpact = quote.priceImpactPct ? parseFloat(quote.priceImpactPct) : 0;
    const executionDelay = 0.5; // Assume 0.5% slippage from execution delay
    
    // Total estimated slippage
    displaySlippage = priceImpact + executionDelay;
    
    // Add more slippage for low liquidity tokens
    if (signal.liquidity && signal.liquidity < 50000) {
      displaySlippage += 1.0; // Add 1% for low liquidity
    }
    
    console.log(`   Our investment: ${this.config.positionSize} SOL ($${solValueUSD.toFixed(2)})`);
    console.log(`   Trader's price: $${signal.price.toFixed(8)}`);
    console.log(`   Expected slippage: ${displaySlippage.toFixed(2)}%`);
    console.log(`   Tokens we'll get: ${ourTokenAmount.toFixed(2)}`);
    console.log(`   Price Impact: ${quote.priceImpactPct}%`);

    // Execute trade
    const execution: TradeExecution = {
      type: 'market',
      side: 'buy',
      token: signal.token,
      amount: this.config.positionSize,
      slippage: slippageBps,
      priorityFee: parseFloat(process.env.MIN_PRIORITY_FEE || '0.001'),
      useNextBlock: true,
      antiMEV: true
    };

    const result = await this.executor.executeTrade(
      execution,
      quote,
      this.config.paperTrading
    );

    if (result.success) {
      // Create our own signal with OUR token amount, not the trader's
      // Use the calculated amount based on our investment
      const ourEntryPriceUSD = ourTokenAmount > 0 ? solValueUSD / ourTokenAmount : signal.price;
      const ourSignal = {
        ...signal,
        amount: ourTokenAmount, // Our calculated token amount
        solAmount: this.config.positionSize,
        price: ourEntryPriceUSD
      };
      
      // Record position with our actual amounts
      const position = this.positionManager.openPosition(
        ourSignal,
        result.txHash!,
        this.config.positionSize,
        false // not manual
      );
      
      // Update position with slippage info
      position.slippage = displaySlippage;
      console.log(`   ✅ Position opened with ${displaySlippage > 0 ? 'negative' : 'positive'} slippage: ${Math.abs(displaySlippage).toFixed(2)}%`);
      
      // Send Telegram alert
      await this.telegramAlerts.sendBuySignal(signal, position);
      await this.telegramAlerts.sendPositionOpened(position);

      // Save trade to database
      await this.databaseService.saveTrade({
        wallet_address: process.env.TARGET_WALLET || '',
        token_address: signal.token,
        token_symbol: signal.tokenSymbol,
        action: 'BUY',
        entry_price: ourEntryPriceUSD,
        amount_sol: this.config.positionSize,
        token_amount: position.tokenAmount,
        status: 'OPEN',
        executed_at: new Date()
      });

      // Save position to database
      await this.databaseService.savePosition({
        wallet_address: process.env.TARGET_WALLET || '',
        token_address: signal.token,
        token_symbol: signal.tokenSymbol,
        entry_price: ourEntryPriceUSD,
        current_price: ourEntryPriceUSD,
        amount_sol: this.config.positionSize,
        remaining_sol: this.config.positionSize,
        token_amount: position.tokenAmount,
        remaining_tokens: position.tokenAmount,
        status: 'OPEN',
        opened_at: new Date(),
        updated_at: new Date()
      });

      this.dashboardServer.broadcastTradeExecution({
        ...execution,
        txHash: result.txHash,
        status: 'success',
        position
      });
    } else {
      console.log(`   ❌ Trade failed: ${result.error}`);
      
      this.dashboardServer.broadcastTradeExecution({
        ...execution,
        status: 'failed',
        error: result.error
      });
    }
  }

  private async handleSellSignal(signal: WalletSignal): Promise<void> {
    console.log(`\n🔔 SELL Signal: ${signal.tokenSymbol || signal.token.substring(0, 8)}`);

    const position = this.positionManager.getPosition(signal.token);
    if (!position || position.status === 'closed') {
      console.log('   ⚠️ No open position for this token');
      return;
    }
    
    // Send initial sell signal alert
    await this.telegramAlerts.sendSellSignal(signal, position);

    // Calculate proportional exit based on trader's sell
    let tokensToSell = position.tokenAmount; // Default to full exit
    let exitPercentage = 100;
    
    if (signal.traderTotalTokens && signal.traderSoldTokens) {
      // Calculate what percentage the trader sold
      exitPercentage = (signal.traderSoldTokens / signal.traderTotalTokens) * 100;
      tokensToSell = position.tokenAmount * (exitPercentage / 100);
      console.log(`   📊 Proportional exit: ${exitPercentage.toFixed(1)}% (${tokensToSell.toFixed(2)} tokens)`);
    }

    // Get quote for selling our proportional amount
    const slippageBps = parseInt(process.env.SLIPPAGE_BPS || '200');
    const quote = await this.executor.getQuote(
      signal.token,
      'So11111111111111111111111111111111111111112', // SOL
      Math.floor(tokensToSell * 1e9),
      slippageBps
    );

    if (!quote) {
      console.log('   ❌ Failed to get quote');
      return;
    }

    console.log(`   Quote: ${(quote.outAmount / 1e9).toFixed(4)} SOL for ${tokensToSell.toFixed(2)} tokens`);

    // Execute trade
    const execution: TradeExecution = {
      type: 'market',
      side: 'sell',
      token: signal.token,
      amount: tokensToSell,
      slippage: slippageBps,
      priorityFee: parseFloat(process.env.MIN_PRIORITY_FEE || '0.001'),
      useNextBlock: true,
      antiMEV: true
    };

    const result = await this.executor.executeTrade(
      execution,
      quote,
      this.config.paperTrading
    );

    if (result.success) {
      // Handle proportional exit or full close
      if (exitPercentage < 100 && signal.traderTotalTokens && signal.traderSoldTokens) {
        // Proportional exit
        this.positionManager.proportionalExit(
          signal.token,
          signal.traderSoldTokens,
          signal.traderTotalTokens,
          signal.price,
          result.txHash!
        );
      } else {
        // Full position close
        this.positionManager.closePosition(
          signal.token,
          signal.price,
          result.txHash!
        );
        
        // Send position closed alert
        const closedPosition = this.positionManager.getPosition(signal.token);
        if (closedPosition) {
          await this.telegramAlerts.sendPositionClosed(closedPosition);
        }
      }

      // Save sell trade to database
      await this.databaseService.saveTrade({
        wallet_address: process.env.TARGET_WALLET || '',
        token_address: signal.token,
        token_symbol: signal.tokenSymbol,
        action: 'SELL',
        entry_price: position.entryPrice,
        exit_price: signal.price,
        amount_sol: position.entryAmount,
        token_amount: position.tokenAmount,
        pnl: position.pnl,
        pnl_percent: position.pnlPercent,
        status: 'CLOSED',
        executed_at: new Date(),
        closed_at: new Date()
      });

      // Update position in database
      await this.databaseService.updatePosition(signal.token, {
        current_price: signal.price,
        remaining_sol: 0,
        remaining_tokens: 0,
        pnl: position.pnl,
        pnl_percent: position.pnlPercent,
        status: 'CLOSED',
        closed_at: new Date()
      });

      this.dashboardServer.broadcastTradeExecution({
        ...execution,
        txHash: result.txHash,
        status: 'success'
      });
    } else {
      console.log(`   ❌ Trade failed: ${result.error}`);
      
      this.dashboardServer.broadcastTradeExecution({
        ...execution,
        status: 'failed',
        error: result.error
      });
    }
  }

  private async handleAutomaticExit(data: any): Promise<void> {
    const { position, reason, percentage } = data;
    
    console.log(`\n🤖 Automatic exit triggered: ${reason}`);
    
    if (percentage < 100) {
      await this.executePartialExit({
        token: position.token,
        percentage
      });
    } else {
      await this.closePosition(position.token);
    }
  }

  private async executeManualBuy(payload: any): Promise<void> {
    console.log('\n🎮 Manual BUY order received');
    
    const signal: WalletSignal = {
      wallet: 'manual',
      action: 'buy',
      token: payload.token,
      tokenSymbol: payload.tokenSymbol,
      amount: 0,
      solAmount: payload.amount || this.config.positionSize,
      price: payload.price || 0,
      timestamp: Date.now() / 1000,
      signature: `manual_buy_${Date.now()}`
    };

    await this.handleBuySignal(signal);
  }

  private async executeManualSell(payload: any): Promise<void> {
    console.log('\n🎮 Manual SELL order received');
    
    const position = this.positionManager.getPosition(payload.token);
    if (!position) {
      console.log('   ❌ No position found');
      return;
    }

    const signal: WalletSignal = {
      wallet: 'manual',
      action: 'sell',
      token: payload.token,
      tokenSymbol: position.tokenSymbol,
      amount: position.tokenAmount,
      solAmount: 0,
      price: position.currentPrice,
      timestamp: Date.now() / 1000,
      signature: `manual_sell_${Date.now()}`
    };

    await this.handleSellSignal(signal);
  }

  private async executePartialExit(payload: any): Promise<void> {
    console.log(`\n🎮 Partial exit (${payload.percentage}%) for ${payload.token}`);
    
    const position = this.positionManager.getPosition(payload.token);
    if (!position) {
      console.log('   ❌ No position found');
      return;
    }

    const tokensToSell = position.tokenAmount * (payload.percentage / 100);
    const slippageBps = parseInt(process.env.SLIPPAGE_BPS || '200');

    const quote = await this.executor.getQuote(
      payload.token,
      'So11111111111111111111111111111111111111112',
      tokensToSell * 1e9,
      slippageBps
    );

    if (!quote) {
      console.log('   ❌ Failed to get quote');
      return;
    }

    const execution: TradeExecution = {
      type: 'market',
      side: 'sell',
      token: payload.token,
      amount: tokensToSell,
      slippage: slippageBps,
      priorityFee: parseFloat(process.env.MIN_PRIORITY_FEE || '0.001'),
      useNextBlock: true,
      antiMEV: true
    };

    const result = await this.executor.executeTrade(
      execution,
      quote,
      this.config.paperTrading
    );

    if (result.success) {
      await this.positionManager.partialExit(
        payload.token,
        payload.percentage,
        position.currentPrice,
        result.txHash!,
        'manual'
      );
    }
  }

  private async closePosition(token: string): Promise<void> {
    const position = this.positionManager.getPosition(token);
    if (!position || position.status === 'closed') return;
    
    console.log(`\n🔴 Closing position: ${position.tokenSymbol || token.substring(0, 8)}`);
    
    // In paper trading, just close at current price
    if (this.config.paperTrading) {
      this.positionManager.closePosition(
        token,
        position.currentPrice,
        `manual_close_${Date.now()}`
      );
      console.log(`   Position closed at ${position.currentPrice.toFixed(6)}`);
    } else {
      // For real trading, execute the sell
      await this.executeManualSell({ token });
    }
  }

  private async closeAllPositions(): Promise<void> {
    console.log('\n🛑 Closing all positions...');
    
    const openPositions = this.positionManager.getOpenPositions();
    const currentPrices = new Map<string, number>();

    for (const position of openPositions) {
      currentPrices.set(position.token, position.currentPrice);
      await this.closePosition(position.token);
    }
  }

  private async emergencyStop(): Promise<void> {
    console.log('\n🚨 EMERGENCY STOP ACTIVATED');
    
    this.isPaused = true;
    this.config.globalStop = true;
    
    await this.closeAllPositions();
    
    this.dashboardServer.updateBotStatus({
      isRunning: false,
      isPaused: true
    });
  }

  private updateDashboardStats(): void {
    const stats = this.positionManager.getStatistics();
    const wallets = [process.env.TARGET_WALLET || ''];
    
    this.dashboardServer.updateBotStatus({
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      mode: this.config.paperTrading ? 'paper' : 'live',
      connectedWallets: wallets,
      activePositions: stats.openPositions,
      totalPositions: stats.totalPositions,
      dailyPnL: stats.dailyPnL,
      dailyPnLPercent: stats.dailyPnLPercent || 0,
      totalPnL: stats.totalPnL,
      winRate: stats.winRate,
      avgWin: stats.avgWinAmount,
      avgLoss: stats.avgLossAmount,
      solPrice: stats.solPrice || 180
    });
    
    // Also broadcast stats_update
    this.dashboardServer.broadcast({
      type: 'stats_update',
      data: stats,
      timestamp: Date.now()
    });
  }

  public async start(): Promise<void> {
    console.log('🚀 Enhanced Copy Trader Starting...');
    console.log('================================');
    console.log(`Target Wallet: ${process.env.TARGET_WALLET}`);
    console.log(`Position Size: ${this.config.positionSize} SOL`);
    console.log(`Mode: ${this.config.paperTrading ? 'PAPER TRADING' : 'LIVE TRADING'}`);
    console.log(`Max Positions: ${this.config.maxPositions}`);
    console.log(`Dashboard: ws://localhost:${process.env.WS_SERVER_PORT || 4790}`);
    console.log('================================\n');

    this.isRunning = true;

    try {
      // Start dashboard server
      console.log('Starting dashboard server...');
      await this.dashboardServer.start();
      console.log('Dashboard server started successfully!');

      // Connect to WebSocket
      await this.walletMonitor.connect();

      // Update dashboard initial state
      this.dashboardServer.updateConfig(this.config);
      this.updateDashboardStats();
      
      // Start periodic slot difference updates if using Yellowstone
      if ('getSlotDifference' in this.walletMonitor) {
        setInterval(() => {
          const slotDiff = (this.walletMonitor as any).getSlotDifference();
          this.positionManager.updateSlotDifference(slotDiff);
          if (slotDiff !== undefined && slotDiff > 500) {
            console.log(`⚠️ Node is ${slotDiff} slots behind`);
          }
        }, 10000); // Check every 10 seconds
      }

      console.log('✅ Bot is running. Waiting for signals...\n');
      console.log('📱 To view the dashboard, run: cd dashboard-v2 && npm run dev');
      console.log('   Then open: http://localhost:3000');

      // Start price update loop
      this.startPriceUpdateLoop();

      // Print statistics periodically
      setInterval(() => {
        if (this.isRunning) {
          this.positionManager.exportResults();
        }
      }, 300000); // Every 5 minutes

    } catch (error) {
      console.error('Failed to start bot:', error);
      this.shutdown();
    }
  }

  private startPriceUpdateLoop(): void {
    // Dynamic update interval to respect Birdeye 15 RPS limit
    const updatePrices = async () => {
      const numPositions = this.positionManager.getOpenPositions().length;
      
      // Calculate safe interval based on number of positions
      let interval = 1000; // Default 1 second
      if (numPositions === 0) {
        interval = 5000; // No positions, check less frequently
      } else if (numPositions <= 2) {
        interval = 500; // 2 RPS per position = 4 RPS total
      } else if (numPositions <= 3) {
        interval = 750; // 1.33 RPS per position = 4 RPS total
      } else if (numPositions <= 5) {
        interval = 1000; // 1 RPS per position = 5 RPS total
      } else if (numPositions <= 10) {
        interval = 2000; // 0.5 RPS per position = 5 RPS total
      } else {
        interval = 3000; // 0.33 RPS per position for 10+ positions
      }
      
      await this.positionManager.updateAllPositionPrices();
      
      // Clear old interval and set new one with adjusted timing
      if (this.priceUpdateInterval) {
        clearTimeout(this.priceUpdateInterval);
      }
      this.priceUpdateInterval = setTimeout(updatePrices, interval);
    };
    
    // Start the update loop
    updatePrices();
  }

  private async shutdown(): Promise<void> {
    console.log('\n🛑 Shutting down...');
    this.isRunning = false;
    
    if (this.priceUpdateInterval) {
      clearInterval(this.priceUpdateInterval);
    }
    
    // Disconnect services
    await this.walletMonitor.stop();
    this.dashboardServer.stop();
    
    // Export final results
    this.positionManager.exportResults();
    
    // Cleanup database
    await this.databaseService.cleanup();
    
    console.log('Goodbye! 👋');
    process.exit(0);
  }
}

// Start the bot if this is the main module
if (require.main === module) {
  const bot = new EnhancedCopyTrader();
  bot.start().catch(console.error);
}