import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Position, PositionEntry, PartialExit, WalletSignal, DashboardConfig } from '../types/enhanced';
import { BirdeyeWebSocketService, PriceUpdate, BirdeyeConfig } from './BirdeyeWebSocketService';
import { TelegramAlerts } from './TelegramAlerts';

export class EnhancedPositionManager extends EventEmitter {
  private positions: Map<string, Position> = new Map();
  private closedPositions: Position[] = [];
  private solPriceUSD: number = 180; // Default SOL price
  private lastSolPriceUpdate: number = 0;
  private readonly SOL_PRICE_CACHE_DURATION = 300000; // 5 minutes cache
  private config: DashboardConfig;
  private slotDifference: number | undefined;
  
  // Birdeye WebSocket for real-time prices
  private birdeyeWS: BirdeyeWebSocketService | null = null;
  private subscribedTokens: Set<string> = new Set();
  private useWebSocket: boolean = false;
  private telegramAlerts: TelegramAlerts;
  private lastPositionLogTime: Map<string, number> = new Map(); // Track last log time per position
  private mode: 'paper' | 'live' = 'paper'; // Trading mode

  private dailyStats = {
    startTime: Date.now(),
    startBalance: 0,
    currentBalance: 0,
    totalWins: 0,
    totalLosses: 0,
    totalPnL: 0,
    dailyPnL: 0,
    largestWin: 0,
    largestLoss: 0,
    avgWinAmount: 0,
    avgLossAmount: 0,
    winRate: 0,
    totalVolume: 0
  };

  constructor(
    config: DashboardConfig = {
      maxPositions: 5,
      partialExitEnabled: true,
      partialExitPercent: [25, 50, 75],
      positionSize: 0.5,
      paperTrading: true,
      copyTrading: true,
      globalStop: false
    },
    private wsConfig?: BirdeyeConfig
  ) {
    super();
    this.config = config;
    this.mode = config.paperTrading ? 'paper' : 'live';
    this.dailyStats.startBalance = 10;
    this.dailyStats.currentBalance = 10;
    
    // Initialize Telegram alerts
    this.telegramAlerts = new TelegramAlerts();
    
    // Initialize Birdeye WebSocket if config provided
    if (wsConfig?.apiKey) {
      this.initializeBirdeyeWebSocket();
    } else {
      // Fallback to REST polling
      this.initializeRestPolling();
    }
  }
  
  private async initializeBirdeyeWebSocket(): Promise<void> {
    try {
      console.log('💰 Initializing Birdeye WebSocket for real-time price updates...');
      
      this.birdeyeWS = new BirdeyeWebSocketService(this.wsConfig!);
      await this.birdeyeWS.connect();
      this.useWebSocket = true;
      
      // Subscribe to SOL price immediately
      const SOL_TOKEN = 'So11111111111111111111111111111111111111112';
      await this.birdeyeWS.subscribeToPrices([SOL_TOKEN], '1s');
      this.subscribedTokens.add(SOL_TOKEN);
      
      // Handle real-time price updates
      this.birdeyeWS.on('price-update', (update: PriceUpdate) => {
        this.handleWebSocketPriceUpdate(update);
      });
      
      // Handle connection events
      this.birdeyeWS.on('connected', () => {
        console.log('✅ Birdeye WebSocket connected for position price updates');
        this.resubscribeToAllTokens();
      });
      
      this.birdeyeWS.on('disconnected', () => {
        console.log('❌ Birdeye WebSocket disconnected, falling back to REST');
        this.useWebSocket = false;
        // Restart REST polling as fallback
        this.initializeRestPolling();
      });
      
      console.log('✅ Real-time price updates initialized');
    } catch (error) {
      console.error('Failed to initialize Birdeye WebSocket:', error);
      this.useWebSocket = false;
      this.initializeRestPolling();
    }
  }
  
  private initializeRestPolling(): void {
    // Fetch SOL price immediately
    this.updateSolPrice().then(() => {
      console.log(`[SOL Price] Initial price set to: $${this.solPriceUSD}`);
    });
    
    // Update SOL price every minute
    setInterval(() => {
      this.lastSolPriceUpdate = 0; // Force update
      this.updateSolPrice();
    }, 60000);
  }
  
  private handleWebSocketPriceUpdate(update: PriceUpdate): void {
    const { token, price, timestamp } = update;
    
    // Update SOL price
    const SOL_TOKEN = 'So11111111111111111111111111111111111111112';
    if (token === SOL_TOKEN) {
      this.solPriceUSD = price;
      this.lastSolPriceUpdate = timestamp;
      this.emit('sol-price-update', price);
    }
    
    // Update position prices
    const position = this.positions.get(token);
    if (position && (position.status === 'open' || position.status === 'partial')) {
      const oldPrice = position.currentPrice;
      position.currentPrice = price;
      
      // Calculate new P&L
      const tokenValueUSD = position.tokenAmount * price;
      const tokenValueSOL = tokenValueUSD / this.solPriceUSD;
      const pnlSOL = tokenValueSOL - position.entryAmount;
      const pnlPercent = (pnlSOL / position.entryAmount) * 100;
      
      position.pnl = pnlSOL;
      position.pnlPercent = pnlPercent;
      
      // Emit real-time update
      this.emit('position-price-update', {
        token,
        oldPrice,
        newPrice: price,
        pnl: pnlSOL,
        pnlPercent,
        timestamp
      });
    }
  }
  
  private async resubscribeToAllTokens(): Promise<void> {
    if (!this.birdeyeWS || !this.useWebSocket) return;
    
    const tokens = Array.from(this.subscribedTokens);
    if (tokens.length > 0) {
      await this.birdeyeWS.subscribeToPrices(tokens, '1s');
      console.log(`Resubscribed to ${tokens.length} token prices`);
    }
  }

  private async updateSolPrice(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSolPriceUpdate < this.SOL_PRICE_CACHE_DURATION) {
      return; // Use cached price
    }

    // Skip SOL price fetching if disabled (for development/testing)
    if (process.env.DISABLE_SOL_PRICE_FETCH === 'true') {
      this.solPriceUSD = 180; // Use fixed price
      return;
    }

    try {
      // Try Birdeye first
      const birdeyeKey = process.env.BIRDEYE_API_KEY;
      if (birdeyeKey) {
        console.log('[SOL Price] Fetching SOL price from Birdeye...');
        const url = `https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112`;
        const response = await fetch(url, {
          headers: { 'X-API-KEY': birdeyeKey }
        });
        
        if (response.ok) {
          const data = await response.json() as any;
          const price = Number(data?.data?.value || data?.value || 0);
          
          if (isFinite(price) && price > 0) {
            this.solPriceUSD = price;
            this.lastSolPriceUpdate = now;
            console.log(`[SOL Price] Updated from Birdeye: $${price}`);
            return;
          }
        } else {
          console.log(`[SOL Price] Birdeye API returned ${response.status}, trying fallback`);
        }
      }

      // Fallback to SolanaTracker if Birdeye fails
      const solanaTrackerKey = process.env.SOLANATRACKER_API_KEY;
      if (solanaTrackerKey) {
        console.log('[SOL Price] Falling back to SolanaTracker...');
        const url = `https://data.solanatracker.io/tokens/So11111111111111111111111111111111111111112`;
        const response = await fetch(url, {
          headers: { 'x-api-key': solanaTrackerKey }
        });
        
        if (response.ok) {
          const text = await response.text();
          if (text && text.trim() !== '') {
            const data = JSON.parse(text);
            const price = Number(data?.price?.usd || data?.pools?.[0]?.price?.usd || 0);
            
            if (isFinite(price) && price > 0) {
              this.solPriceUSD = price;
              this.lastSolPriceUpdate = now;
              console.log(`[SOL Price] Updated from SolanaTracker: $${price}`);
              return;
            }
          }
        }
      }

      // Final fallback
      console.log('[SOL Price] Using fallback price');
      this.solPriceUSD = 180;
    } catch (error) {
      console.log('[SOL Price] Error fetching price:', error instanceof Error ? error.message : error);
      this.solPriceUSD = 180; // Fallback SOL price
    }
  }

  public openPosition(
    signal: WalletSignal,
    txHash: string,
    actualSolAmount: number,
    isManual = false
  ): Position {
    const existingPosition = this.positions.get(signal.token);
    
    if (existingPosition && existingPosition.status !== 'closed') {
      // Add new entry to existing position
      console.log(`   📈 Adding entry to existing position for ${signal.tokenSymbol}`);
      
      const newEntry: PositionEntry = {
        id: uuidv4(),
        amount: actualSolAmount,
        tokenAmount: signal.amount,
        price: signal.price,
        tx: txHash,
        timestamp: Date.now(),
        isManual
      };
      
      existingPosition.entries.push(newEntry);
      existingPosition.entryAmount += actualSolAmount;
      existingPosition.tokenAmount += signal.amount;
      // Track the total tokens bought (for display purposes)
      if (!existingPosition.initialTokenAmount) {
        existingPosition.initialTokenAmount = existingPosition.tokenAmount;
      } else {
        existingPosition.initialTokenAmount += signal.amount;
      }
      // Keep entry price as the weighted average USD price
      // Convert SOL prices to USD for proper weighted average
      existingPosition.entryPrice = existingPosition.entries.reduce((sum, e) => sum + ((e.price * this.solPriceUSD) * e.tokenAmount), 0) / existingPosition.tokenAmount;
      
      console.log(`   Entry #${existingPosition.entries.length}: ${actualSolAmount.toFixed(4)} SOL for ${signal.amount.toFixed(2)} tokens`);
      console.log(`   New average: ${existingPosition.entryPrice.toFixed(6)} per token`);
      
      this.emit('position_update', existingPosition);
      return existingPosition;
    }

    const firstEntry: PositionEntry = {
      id: uuidv4(),
      amount: actualSolAmount,
      tokenAmount: signal.amount,
      price: signal.price,
      tx: txHash,
      timestamp: Date.now(),
      isManual
    };

    // CRITICAL: Ensure actualSolAmount is the correct value
    if (actualSolAmount < 0.1) {
      console.log(`⚠️ WARNING: Opening position with very small SOL amount: ${actualSolAmount}`);
      console.log(`   Signal SOL amount: ${signal.solAmount}`);
      console.log(`   Actual SOL amount param: ${actualSolAmount}`);
      console.log(`   This will cause incorrect P&L calculations!`);
    }

    const position: Position = {
      id: uuidv4(),
      token: signal.token,
      tokenSymbol: signal.tokenSymbol,
      tokenName: signal.tokenName,
      poolId: signal.poolId,
      entries: [firstEntry],
      entryPrice: signal.price * this.solPriceUSD, // Convert SOL price to USD price per token
      currentPrice: signal.price * this.solPriceUSD, // Convert SOL price to USD price per token
      entryAmount: actualSolAmount, // Total SOL invested - THIS MUST BE CORRECT (0.5+ SOL)
      solInvested: actualSolAmount, // Current SOL invested (reduced by partial exits)
      tokenAmount: signal.amount, // Total tokens held
      initialTokenAmount: signal.amount, // Store initial amount for P&L calculations
      entryTx: txHash,
      entryTime: Date.now(),
      traderEntryPrice: signal.price * this.solPriceUSD, // Store the trader's entry price in USD
      slippage: 0, // Will be calculated after our trade executes
      status: 'open',
      isManual,
      partialExits: [],
      
    };

    this.positions.set(signal.token, position);
    this.dailyStats.totalVolume += actualSolAmount;
    
    console.log(`\n📊 Position Opened:`);
    console.log(`   Token: ${position.tokenSymbol || position.token.substring(0, 8)}`);
    console.log(`   Entry Amount: ${actualSolAmount.toFixed(4)} SOL (stored as: ${position.entryAmount})`);
    console.log(`   Signal Price: ${signal.price} (in SOL terms)`);
    console.log(`   Entry Price USD: $${position.entryPrice.toFixed(6)} (converted)`);
    console.log(`   Token Amount: ${position.tokenAmount}`);
    console.log(`   SOL Price: $${this.solPriceUSD}`);
    console.log(`   Type: ${isManual ? 'Manual' : 'Copy Trade'}`);
    
    // Subscribe to real-time price updates for this token
    if (this.useWebSocket && this.birdeyeWS && !this.subscribedTokens.has(signal.token)) {
      this.birdeyeWS.subscribeToPrices([signal.token], '1s')
        .then(() => {
          this.subscribedTokens.add(signal.token);
          console.log(`   📊 Subscribed to real-time prices for ${signal.tokenSymbol || signal.token.substring(0, 8)}`);
        })
        .catch(error => {
          console.error(`Failed to subscribe to ${signal.token}:`, error);
        });
    }
    
    this.emit('position_opened', position);
    this.updateStats();
    
    return position;
  }

  public async updatePrice(token: string, price: number): Promise<void> {
    const position = this.positions.get(token);
    if (!position || position.status === 'closed') return;

    position.currentPrice = price;

    // No trailing stop tracking

    // Calculate PnL based on current token price
    // Update SOL price first
    await this.updateSolPrice();
    
    // Silent update - no logging or events for price updates
    // Dashboard handles real-time price display
    
    // Ensure we have valid token amount
    if (!position.tokenAmount || position.tokenAmount <= 0) {
      console.log(`⚠️ Invalid tokenAmount for ${position.tokenSymbol}: ${position.tokenAmount}`);
      position.pnl = 0;
      position.pnlPercent = 0;
      return;
    }
    
    // Calculate what our tokens are worth now
    // price is in USD per token
    const remainingTokensValueUSD = position.tokenAmount * price;
    const remainingTokensValueSOL = remainingTokensValueUSD / this.solPriceUSD;
    
    // Add SOL received from partial exits
    let totalSolFromPartialExits = 0;
    if (position.partialExits && position.partialExits.length > 0) {
      for (const exit of position.partialExits) {
        totalSolFromPartialExits += exit.solReceived || 0;
      }
    }

    // Total current value = remaining tokens value + SOL from exits
    const totalCurrentValue = remainingTokensValueSOL + totalSolFromPartialExits;
    
    // Debug logging for extremely small entry amounts
    if (position.entryAmount < 0.01) {
      console.log(`⚠️ DEBUG: Very small entry amount detected for ${position.tokenSymbol}:`);
      console.log(`   Entry Amount: ${position.entryAmount} SOL`);
      console.log(`   Token Amount: ${position.tokenAmount}`);
      console.log(`   Current Price (USD): $${price}`);
      console.log(`   SOL Price: $${this.solPriceUSD}`);
      console.log(`   Remaining Value (USD): $${remainingTokensValueUSD}`);
      console.log(`   Remaining Value (SOL): ${remainingTokensValueSOL}`);
      console.log(`   Entry Price: ${position.entryPrice}`);
      
      // Fix: If entry amount is suspiciously small, recalculate from entries
      if (position.entries && position.entries.length > 0) {
        const recalculatedEntry = position.entries.reduce((sum, e) => sum + e.amount, 0);
        console.log(`   Recalculated from entries: ${recalculatedEntry} SOL`);
        if (recalculatedEntry > position.entryAmount) {
          position.entryAmount = recalculatedEntry;
          console.log(`   Fixed entry amount to: ${position.entryAmount} SOL`);
        }
      }
    }
    
    // P&L = current value - initial investment
    position.pnl = totalCurrentValue - position.entryAmount;
    position.pnlPercent = (position.pnl / position.entryAmount) * 100;

    // Only log significant P&L changes AND throttle to every 30 seconds per position
    const shouldLog = Math.abs(position.pnlPercent) > 5 || Math.abs(position.pnl) > 0.1;
    const lastLogTime = this.lastPositionLogTime.get(position.id) || 0;
    const timeSinceLastLog = Date.now() - lastLogTime;
    const shouldThrottle = timeSinceLastLog > 30000; // 30 seconds throttle
    
    if (shouldLog && shouldThrottle) {
      // Disabled: Dashboard handles real-time prices
      // console.log(`📊 Position update: ${position.tokenSymbol} P&L: ${position.pnl.toFixed(4)} SOL (${position.pnlPercent.toFixed(2)}%)`);
      this.lastPositionLogTime.set(position.id, Date.now());
    }
    
    // Sanity check - if P&L is exactly 50 SOL, something is wrong
    if (Math.abs(position.pnl - 50) < 0.01) {
      console.log(`   ⚠️ WARNING: P&L is suspiciously exactly 50 SOL - likely a calculation error`);
    }
    
    // Cap at reasonable levels
    if (Math.abs(position.pnlPercent) > 10000 || isNaN(position.pnlPercent)) {
      console.log(`   ⚠️ Capping unrealistic P&L`);
      position.pnlPercent = Math.sign(position.pnlPercent) * 10000;
      position.pnl = position.entryAmount * (position.pnlPercent / 100);
    }

    // No automatic exits; copy-only strategy
    
    // Emit position update so dashboard gets the new price and P&L
    this.emit('position_update', position);
  }

  public async updateAllPositionPrices(): Promise<void> {
    const openPositions = this.getOpenPositions();
    if (openPositions.length === 0) return;

    try {
      // Fetch real-time prices from Birdeye price API
      for (const position of openPositions) {
        try {
          const response = await fetch(
            `https://public-api.birdeye.so/defi/price?address=${position.token}`,
            {
              headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY || '637c43ce566444169ee539319322ac35' }
            }
          );
          
          if (response.ok) {
            const data = await response.json() as any;
            const price = data?.data?.value || 0;
            
            // Silent price update - removed verbose logging
            
            if (price > 0 && price < 1000) {
              await this.updatePrice(position.token, price);
            } else if (price >= 1000) {
              console.log(`   ⚠️ Ignoring unrealistic price: $${price}`);
            } else if (price === 0) {
              console.log(`   ⚠️ Got 0 price for ${position.tokenSymbol}`);
            }
          }
        } catch (error) {
          console.log(`   Failed to fetch price for ${position.tokenSymbol}: ${error instanceof Error ? error.message : error}`);
        }
      }
    } catch (error) {
      console.log('[Price Update] Error updating prices:', error instanceof Error ? error.message : error);
    }
  }

  // Automatic exits removed for copy-only strategy

  public async proportionalExit(
    token: string,
    traderSoldTokens: number,
    traderTotalTokens: number, 
    price: number,
    txHash: string
  ): Promise<PartialExit | null> {
    const position = this.positions.get(token);
    if (!position || position.status === 'closed') return null;

    // Calculate what percentage the trader sold
    const traderSellPercent = (traderSoldTokens / traderTotalTokens) * 100;
    console.log(`   Trader sold ${traderSellPercent.toFixed(1)}% of position`);

    // Sell the same percentage of our position
    return await this.partialExit(token, traderSellPercent, price, txHash, 'copy_signal');
  }

  public async partialExit(
    token: string,
    percentage: number,
    price: number,
    txHash: string,
    reason: 'manual' | 'take_profit' | 'stop_loss' | 'copy_signal'
  ): Promise<PartialExit | null> {
    const position = this.positions.get(token);
    if (!position || position.status === 'closed') return null;

    const tokensToSell = position.tokenAmount * (percentage / 100);
    // FIX: Convert USD value to SOL
    const tokenValueUSD = tokensToSell * price;
    await this.updateSolPrice();
    const solReceived = tokenValueUSD / this.solPriceUSD;
    
    const solReduced = position.solInvested * (percentage / 100);
    const pnl = solReceived - solReduced;
    const pnlPercent = (pnl / solReduced) * 100;
    
    const partialExit: PartialExit = {
      percentage,
      tokensSold: tokensToSell,
      solReduced,
      solReceived,
      exitPrice: price,
      pnl,
      pnlPercent,
      txHash,
      timestamp: Date.now()
    };

    position.partialExits?.push(partialExit);
    position.tokenAmount -= tokensToSell;
    position.status = position.tokenAmount > 0 ? 'partial' : 'closed';

    // Recalculate PnL after partial exit
    
    // Calculate the USD value of remaining tokens
    const remainingTokensValueUSD = position.tokenAmount * price;
    
    // Convert USD value to SOL using actual SOL price
    const remainingTokensValueSOL = remainingTokensValueUSD / this.solPriceUSD;
    
    let totalSolFromPartialExits = 0;
    if (position.partialExits) {
      for (const exit of position.partialExits) {
        totalSolFromPartialExits += exit.solReceived || 0;
      }
    }

    // FIXED P&L Calculation:
    // P&L = (Value of remaining tokens + SOL from partial exits) - Original investment
    // But we need to account for the fact that partial exits are already realized profit
    const totalCurrentValue = remainingTokensValueSOL + totalSolFromPartialExits;
    position.pnl = totalCurrentValue - position.entryAmount;
    position.pnlPercent = (position.pnl / position.entryAmount) * 100;

    // Debug logging for P&L calculation
    console.log(`\n🔍 [DEBUG] Partial Exit P&L Calculation for ${position.tokenSymbol || position.token.substring(0, 8)}:`);
    console.log(`   Original Investment: ${position.entryAmount.toFixed(4)} SOL`);
    console.log(`   Remaining Tokens: ${position.tokenAmount.toFixed(2)} tokens`);
    console.log(`   Current Token Price: $${price.toFixed(8)}`);
    console.log(`   SOL Price: $${this.solPriceUSD.toFixed(2)}`);
    console.log(`   Remaining Tokens USD Value: $${remainingTokensValueUSD.toFixed(4)}`);
    console.log(`   Remaining Tokens SOL Value: ${remainingTokensValueSOL.toFixed(4)} SOL`);
    console.log(`   Total SOL from Partial Exits: ${totalSolFromPartialExits.toFixed(4)} SOL`);
    console.log(`   Total Current Value: ${totalCurrentValue.toFixed(4)} SOL`);
    console.log(`   Calculated P&L: ${position.pnl.toFixed(4)} SOL (${position.pnlPercent.toFixed(2)}%)`);
    
    // Additional validation
    if (Math.abs(position.pnlPercent) > 10000) {
      console.log(`⚠️  [WARNING] P&L percentage seems unrealistic: ${position.pnlPercent.toFixed(2)}%`);
      console.log(`   This might indicate a calculation error.`);
      // Cap P&L to prevent display issues
      position.pnlPercent = Math.sign(position.pnlPercent) * 10000;
      position.pnl = position.entryAmount * (position.pnlPercent / 100);
    }

    if (position.status === 'closed') {
      this.closePosition(token, price, txHash);
    } else {
      console.log(`\n📊 Partial Exit (${percentage}%):`);
      console.log(`   Token: ${position.tokenSymbol}`);
      console.log(`   Sold: ${tokensToSell.toFixed(2)} tokens`);
      console.log(`   Received: ${solReceived.toFixed(4)} SOL`);
      console.log(`   Remaining: ${position.tokenAmount.toFixed(2)} tokens`);
      console.log(`   Updated P&L: ${position.pnl > 0 ? '🟢' : '🔴'} ${position.pnl.toFixed(4)} SOL (${position.pnlPercent.toFixed(2)}%)`);
      console.log(`   Reason: ${reason}`);

      this.emit('partial_exit', { position, partialExit });
      this.emit('position_update', position);
      this.updateStats();
    }

    return partialExit;
  }

  public closePosition(token: string, exitPrice: number, txHash: string): void {
    const position = this.positions.get(token);
    if (!position) return;

    position.exitPrice = exitPrice;
    position.exitTime = Date.now();
    position.exitTx = txHash;
    position.status = 'closed';

    // Calculate final PnL including partial exits
    // Calculate the USD value of remaining tokens
    const remainingTokensValueUSD = position.tokenAmount * exitPrice;
    
    // Convert USD value to SOL using actual SOL price
    const remainingTokensValueSOL = remainingTokensValueUSD / this.solPriceUSD;
    
    let totalSolReceived = remainingTokensValueSOL;
    for (const partial of position.partialExits || []) {
      totalSolReceived += partial.solReceived || 0;
    }
    
    position.exitAmount = totalSolReceived;
    position.pnl = totalSolReceived - position.entryAmount;
    position.pnlPercent = (position.pnl / position.entryAmount) * 100;

    // Update stats
    if (position.pnl > 0) {
      this.dailyStats.totalWins++;
      this.dailyStats.largestWin = Math.max(this.dailyStats.largestWin, position.pnl);
    } else {
      this.dailyStats.totalLosses++;
      this.dailyStats.largestLoss = Math.min(this.dailyStats.largestLoss, position.pnl);
    }
    
    this.dailyStats.totalPnL += position.pnl;
    this.dailyStats.currentBalance += position.pnl;
    
    // Only show PnL for live trading, dashboard calculates it for paper trading
    if (this.mode === 'live') {
      console.log(`\n📊 Position Closed:`);
      console.log(`   Token: ${position.tokenSymbol || position.token.substring(0, 8)}`);
      console.log(`   PnL: ${position.pnl > 0 ? '🟢' : '🔴'} ${position.pnl.toFixed(4)} SOL (${position.pnlPercent.toFixed(2)}%)`);
      console.log(`   Duration: ${((position.exitTime - position.entryTime) / 60000).toFixed(1)} minutes`);
    } else {
      console.log(`\n📊 Position Closed: ${position.tokenSymbol || position.token.substring(0, 8)}`);
      console.log(`   Sold: ${position.tokenAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })} tokens`);
      console.log(`   Duration: ${((position.exitTime - position.entryTime) / 60000).toFixed(1)} minutes`);
    }
    
    this.emit('position_closed', position);
    
    // Unsubscribe from price updates if no other positions need this token
    if (this.useWebSocket && this.birdeyeWS && this.subscribedTokens.has(token)) {
      // Check if any other positions use this token
      const otherPositions = Array.from(this.positions.values()).filter(
        p => p.token === token && p.status !== 'closed' && p !== position
      );
      
      if (otherPositions.length === 0) {
        this.birdeyeWS.unsubscribeFromPrices([token])
          .then(() => {
            this.subscribedTokens.delete(token);
            console.log(`   📉 Unsubscribed from real-time prices for ${position.tokenSymbol || token.substring(0, 8)}`);
          })
          .catch(error => {
            console.error(`Failed to unsubscribe from ${token}:`, error);
          });
      }
    }
    
    // Remove the position from the map after closing
    this.positions.delete(token);
    this.updateStats();
  }

  public closeAllPositions(currentPrices: Map<string, number>): void {
    console.log('\n🛑 EMERGENCY STOP - Closing all positions...');
    
    for (const [token, position] of this.positions) {
      if (position.status !== 'closed') {
        const price = currentPrices.get(token) || position.currentPrice;
        this.closePosition(token, price, `emergency_stop_${Date.now()}`);
      }
    }
    
    console.log(`✅ All positions closed. Daily PnL: ${this.dailyStats.dailyPnL.toFixed(4)} SOL`);
  }

  public getPosition(token: string): Position | undefined {
    return this.positions.get(token);
  }

  public getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter(p => p.status !== 'closed');
  }

  public getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  public isHoldingToken(token: string): boolean {
    const position = this.positions.get(token);
    return position !== undefined && (position.status === 'open' || position.status === 'partial');
  }

  public shouldTakeNewPosition(maxPositions: number, maxDailyLoss: number): boolean {
    const openPositions = this.getOpenPositions();
    
    // Check max positions
    if (openPositions.length >= maxPositions) {
      console.log(`   ⚠️ Max positions reached (${openPositions.length}/${maxPositions})`);
      return false;
    }

    // Check daily loss limit
    const dailyPnLPercent = (this.dailyStats.dailyPnL / this.dailyStats.startBalance) * 100;
    if (dailyPnLPercent < maxDailyLoss * 100) {
      console.log(`   ⚠️ Daily loss limit reached (${dailyPnLPercent.toFixed(2)}%)`);
      return false;
    }

    // Check global stop
    if (this.config.globalStop) {
      console.log(`   ⚠️ Global stop is active`);
      return false;
    }

    return true;
  }

  public updateConfig(config: Partial<DashboardConfig>): void {
    this.config = { ...this.config, ...config };
    console.log('📊 Position manager config updated');
    
    // No automated exit settings to re-apply
    
    this.emit('config_updated', this.config);
  }

  public getConfig(): DashboardConfig {
    return { ...this.config };
  }

  public getSolPrice(): number {
    return this.solPriceUSD;
  }

  private updateStats(): void {
    const wins = this.dailyStats.totalWins;
    const losses = this.dailyStats.totalLosses;
    const total = wins + losses;
    
    if (total > 0) {
      this.dailyStats.winRate = (wins / total) * 100;
      
      if (wins > 0) {
        this.dailyStats.avgWinAmount = 
          this.getAllPositions()
            .filter(p => p.status === 'closed' && p.pnl! > 0)
            .reduce((sum, p) => sum + p.pnl!, 0) / wins;
      }
      
      if (losses > 0) {
        this.dailyStats.avgLossAmount = 
          this.getAllPositions()
            .filter(p => p.status === 'closed' && p.pnl! < 0)
            .reduce((sum, p) => sum + p.pnl!, 0) / losses;
      }
    }
    
    this.dailyStats.dailyPnL = this.dailyStats.currentBalance - this.dailyStats.startBalance;
    
    this.emit('stats_update', this.getStatistics());
  }

  public getStatistics() {
    const dailyPnLPercent = this.dailyStats.startBalance > 0 
      ? (this.dailyStats.dailyPnL / this.dailyStats.startBalance) * 100 
      : 0;
    
    return {
      ...this.dailyStats,
      dailyPnLPercent,
      openPositions: this.getOpenPositions().length,
      totalPositions: this.positions.size,
      currentExposure: this.getOpenPositions()
        .reduce((sum, p) => sum + p.entryAmount, 0),
      solPrice: this.solPriceUSD,
      slotDifference: this.slotDifference
    };
  }
  
  public updateSlotDifference(slotDiff: number | undefined): void {
    this.slotDifference = slotDiff;
  }

  public exportResults(): void {
    const stats = this.getStatistics();
    const timestamp = new Date().toISOString();
    
    console.log('\n' + '='.repeat(50));
    console.log('📊 TRADING STATISTICS');
    console.log('='.repeat(50));
    console.log(`Timestamp: ${timestamp}`);
    console.log(`\nPerformance:`);
    console.log(`  Win Rate: ${stats.winRate.toFixed(1)}%`);
    console.log(`  Total Wins: ${stats.totalWins}`);
    console.log(`  Total Losses: ${stats.totalLosses}`);
    console.log(`  Avg Win: ${stats.avgWinAmount.toFixed(4)} SOL`);
    console.log(`  Avg Loss: ${stats.avgLossAmount.toFixed(4)} SOL`);
    console.log(`\nPnL:`);
    console.log(`  Daily PnL: ${stats.dailyPnL > 0 ? '🟢' : '🔴'} ${stats.dailyPnL.toFixed(4)} SOL`);
    console.log(`  Total PnL: ${stats.totalPnL > 0 ? '🟢' : '🔴'} ${stats.totalPnL.toFixed(4)} SOL`);
    console.log(`  Largest Win: ${stats.largestWin.toFixed(4)} SOL`);
    console.log(`  Largest Loss: ${stats.largestLoss.toFixed(4)} SOL`);
    console.log(`\nExposure:`);
    console.log(`  Open Positions: ${stats.openPositions}`);
    console.log(`  Current Exposure: ${stats.currentExposure.toFixed(4)} SOL`);
    console.log(`  Total Volume: ${stats.totalVolume.toFixed(4)} SOL`);
    console.log('='.repeat(50));
  }
  
  public async cleanup(): Promise<void> {
    if (this.birdeyeWS) {
      console.log('🛑 Disconnecting Birdeye WebSocket...');
      await this.birdeyeWS.disconnect();
      this.birdeyeWS = null;
      this.useWebSocket = false;
      this.subscribedTokens.clear();
    }
  }
  
  public getWebSocketStatus(): { 
    enabled: boolean; 
    connected: boolean; 
    subscribedTokens: number;
    connectionStatus?: { [key: string]: string };
    subscriptionCounts?: { prices: number; wallets: number; tokens: number };
  } {
    if (!this.birdeyeWS) {
      return { 
        enabled: false, 
        connected: false, 
        subscribedTokens: 0 
      };
    }
    
    return {
      enabled: this.useWebSocket,
      connected: this.useWebSocket,
      subscribedTokens: this.subscribedTokens.size,
      connectionStatus: this.birdeyeWS.getStatus(),
      subscriptionCounts: this.birdeyeWS.getSubscriptionCounts()
    };
  }
}