import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import EventEmitter from 'events';
import { 
  WebSocketMessage, 
  DashboardCommand, 
  Position, 
  BotStatus,
  MarketData,
  DashboardConfig
} from '../types/enhanced';
import { BirdeyeWebSocketService, PriceUpdate, BirdeyeConfig } from './BirdeyeWebSocketService';
import { DatabaseService } from './DatabaseService';

export class DashboardWebSocketServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private httpServer: any = null;
  private clients: Set<WebSocket> = new Set();
  private port: number;
  private tradeHistory: any[] = [];
  
  // Birdeye WebSocket for real-time chart data
  private birdeyeWS: BirdeyeWebSocketService | null = null;
  private chartSubscriptions: Map<string, Set<WebSocket>> = new Map(); // token -> clients interested
  // Store price history per token AND timeframe
  private priceHistory: Map<string, any[]> = new Map(); // key: token:timeframe
  private readonly MAX_HISTORY_SIZE = 1000; // Keep last 1000 price points per token
  
  private botStatus: BotStatus = {
    isRunning: false,
    isPaused: false,
    mode: 'paper',
    connectedWallets: [],
    activePositions: 0,
    totalPositions: 0,
    dailyPnL: 0,
    totalPnL: 0,
    winRate: 0,
    avgWin: 0,
    avgLoss: 0,
    lastUpdate: Date.now()
  };
  private positions: Map<string, Position> = new Map();
  private marketData: Map<string, MarketData> = new Map();
  private config: DashboardConfig | null = null;
  private broadcastInterval: NodeJS.Timeout | null = null;
  private database: DatabaseService | null = null;

  constructor(port: number, private wsConfig?: BirdeyeConfig) {
    super();
    this.port = port;
  }

  setDatabase(database: DatabaseService): void {
    this.database = database;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Create HTTP server
        this.httpServer = createServer();
        
        // Create WebSocket server
        this.wss = new WebSocketServer({ 
          server: this.httpServer,
          path: '/ws'
        });

        this.wss.on('connection', (ws: WebSocket, req: any) => {
          // Extract auth from URL
          const url = new URL(req.url || '', `http://${req.headers.host}`);
          const email = url.searchParams.get('email');
          
          // Only allow your email - SECURITY CHECK
          if (email !== 'me@adamx.cloud' && email !== encodeURIComponent('me@adamx.cloud')) {
            console.log('⛔ Unauthorized connection attempt from:', email);
            ws.close(1008, 'Unauthorized - Access Denied');
            return;
          }
          
          this.handleConnection(ws);
        });

        this.httpServer.listen(this.port, () => {
          console.log(`🌐 Dashboard WebSocket server running on port ${this.port}`);
          
          // Initialize Birdeye WebSocket if configured
          if (this.wsConfig?.apiKey) {
            this.initializeBirdeyeWebSocket();
          }
          
          this.startBroadcastLoop();
          resolve();
        });

        this.httpServer.on('error', (error: Error) => {
          console.error('WebSocket server error:', error);
          reject(error);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Initialize Birdeye WebSocket for real-time chart data
   */
  private async initializeBirdeyeWebSocket(): Promise<void> {
    try {
      console.log('📈 Initializing Birdeye WebSocket for real-time chart updates...');
      
      this.birdeyeWS = new BirdeyeWebSocketService(this.wsConfig!);
      await this.birdeyeWS.connect();

      // Handle real-time price updates
      this.birdeyeWS.on('price-update', (priceUpdate: PriceUpdate) => {
        this.handleBirdeyePriceUpdate(priceUpdate);
      });

      // Subscribe to SOL by default for chart
      await this.birdeyeWS.subscribeToPrices(['So11111111111111111111111111111111111111112'], '1s');
      
      console.log('✅ Birdeye WebSocket connected for real-time chart data');
      
      // Notify all clients that real-time updates are available
      this.broadcast({
        type: 'websocket_status',
        data: {
          birdeye: 'connected',
          realTimeEnabled: true
        },
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error('Failed to initialize Birdeye WebSocket:', error);
    }
  }

  /**
   * Handle real-time price update from Birdeye
   */
  private handleBirdeyePriceUpdate(priceUpdate: PriceUpdate): void {
    const { token, price, timestamp, o, h, l, c, v, unixTime } = priceUpdate;
    
    // Update market data
    const existing = this.marketData.get(token);
    if (existing) {
      this.marketData.set(token, {
        ...existing,
        price,
        lastUpdate: timestamp || Date.now()
      });
    } else {
      this.marketData.set(token, {
        token,
        price,
        priceChange24h: 0,
        volume24h: 0,
        liquidity: 0,
        marketCap: 0,
        lastUpdate: timestamp || Date.now()
      });
    }

    // Add to price history for chart
    if (!this.priceHistory.has(token)) {
      this.priceHistory.set(token, []);
    }
    
    const history = this.priceHistory.get(token)!;
    const chartPoint = {
      time: unixTime || Math.floor(timestamp / 1000), // Convert to seconds for chart
      open: o || price,
      high: h || price,
      low: l || price,
      close: c || price,
      volume: v || 0
    };
    
    // Check if we should update the last candle or create a new one
    if (history.length > 0) {
      const lastCandle = history[history.length - 1];
      // If within the same second, update the candle
      if (lastCandle.time === chartPoint.time) {
        lastCandle.high = Math.max(lastCandle.high, chartPoint.close);
        lastCandle.low = Math.min(lastCandle.low, chartPoint.close);
        lastCandle.close = chartPoint.close;
        lastCandle.volume = chartPoint.volume;
      } else {
        // New candle
        history.push(chartPoint);
        // Trim history if too large
        if (history.length > this.MAX_HISTORY_SIZE) {
          history.shift();
        }
      }
    } else {
      history.push(chartPoint);
    }

    // Broadcast to clients subscribed to this token's chart
    const subscribers = this.chartSubscriptions.get(token);
    if (subscribers && subscribers.size > 0) {
      const chartUpdate = {
        type: 'price_update' as const,
        data: {
          token,
          price,
          timestamp: chartPoint.time * 1000, // Convert back to milliseconds
          o: chartPoint.open,
          h: chartPoint.high,
          l: chartPoint.low,
          c: chartPoint.close,
          v: chartPoint.volume
        },
        timestamp: Date.now()
      };
      
      // Send to subscribed clients only
      for (const client of subscribers) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(chartUpdate));
        }
      }
    }

    // Also broadcast general price update for positions
    this.broadcast({
      type: 'price_update',
      data: {
        token,
        price,
        timestamp
      },
      timestamp: Date.now()
    });
  }

  private handleConnection(ws: WebSocket): void {
    console.log('📱 New dashboard client connected');
    this.clients.add(ws);

    // Send initial state
    this.sendInitialState(ws);

    // Handle client messages
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as DashboardCommand;
        this.handleCommand(message, ws);
      } catch (error) {
        console.error('Error handling client message:', error);
        this.sendError(ws, 'Invalid message format');
      }
    });

    ws.on('close', () => {
      console.log('📱 Dashboard client disconnected');
      this.clients.delete(ws);
      
      // Remove from all chart subscriptions
      for (const subscribers of this.chartSubscriptions.values()) {
        subscribers.delete(ws);
      }
    });

    ws.on('error', (error) => {
      console.error('Client WebSocket error:', error);
      this.clients.delete(ws);
    });

    // Setup ping/pong for connection health
    ws.on('pong', () => {
      (ws as any).isAlive = true;
    });
  }

  private sendInitialState(ws: WebSocket): void {
    // Send bot status
    this.sendMessage(ws, {
      type: 'bot_status',
      data: this.botStatus,
      timestamp: Date.now()
    });

    // Send all positions
    const positions = Array.from(this.positions.values());
    this.sendMessage(ws, {
      type: 'position_update',
      data: { positions, type: 'snapshot' },
      timestamp: Date.now()
    });

    // Send trade history if available
    if (this.tradeHistory.length > 0) {
      this.sendMessage(ws, {
        type: 'trade_history',
        data: this.tradeHistory,
        timestamp: Date.now()
      });
    }

    // Send trader transactions from database
    if (this.database) {
      this.database.getTraderTransactions(100).then((transactions: any[]) => {
        if (transactions.length > 0) {
          // Convert database format to frontend format
          const formattedTransactions = transactions.map((tx: any) => ({
            id: tx.id,
            type: tx.type,
            token: tx.token_address,
            tokenSymbol: tx.token_symbol || 'Unknown',
            amount: parseFloat(tx.amount.toString()),
            price: parseFloat(tx.price.toString()),
            timestamp: tx.timestamp.getTime(),
            trader: tx.trader_wallet,
            txHash: tx.tx_hash
          }));

          this.sendMessage(ws, {
            type: 'trader_transactions_history',
            data: formattedTransactions,
            timestamp: Date.now()
          });
        }
      }).catch((error: any) => {
        console.error('Failed to load trader transactions:', error);
      });
    }

    // Send market data
    const marketData = Array.from(this.marketData.entries()).map(([tokenAddr, data]) => ({
      ...data,
      token: tokenAddr
    }));
    this.sendMessage(ws, {
      type: 'market_data',
      data: { markets: marketData },
      timestamp: Date.now()
    });

    // Send config
    if (this.config) {
      this.sendMessage(ws, {
        type: 'config_update',
        data: this.config,
        timestamp: Date.now()
      });
    }
  }

  private handleCommand(command: DashboardCommand, ws: WebSocket): void {
    // Only log non-status commands to reduce spam
    if (command.type !== 'get_status') {
      console.log(`📡 Received command: ${command.type}`);
    }

    switch (command.type) {
      case 'subscribe_chart':
        this.handleChartSubscription(command.payload, ws);
        break;
        
      case 'unsubscribe_chart':
        this.handleChartUnsubscription(command.payload, ws);
        break;
        
      case 'get_chart_history':
        this.sendChartHistory(command.payload, ws);
        break;

      case 'buy':
        this.emit('manual_buy', command.payload);
        break;

      case 'sell':
        this.emit('manual_sell', command.payload);
        break;

      case 'partial_exit':
        this.emit('partial_exit', command.payload);
        break;

      case 'close_position':
        this.emit('close_position', command.payload);
        break;

      case 'close_all':
        this.emit('close_all_positions');
        break;

      case 'pause':
        this.emit('pause_bot');
        this.botStatus.isPaused = true;
        this.broadcastBotStatus();
        break;

      case 'resume':
        this.emit('resume_bot');
        this.botStatus.isPaused = false;
        this.broadcastBotStatus();
        break;

      case 'update_config':
        this.emit('update_config', command.payload);
        break;

      case 'emergency_stop':
        this.emit('emergency_stop');
        this.botStatus.isRunning = false;
        this.botStatus.isPaused = true;
        this.broadcastBotStatus();
        break;

      case 'start_bot':
        this.handleBotControl('start', ws);
        break;

      case 'stop_bot':
        this.handleBotControl('stop', ws);
        break;

      case 'restart_bot':
        this.handleBotControl('restart', ws);
        break;

      case 'get_logs':
        this.sendRecentLogs(ws);
        break;

      case 'get_status':
        this.sendSystemStatus(ws);
        break;

      case 'set_trading_mode':
        this.handleTradingModeChange(command.payload, ws);
        break;

      default:
        this.sendError(ws, `Unknown command: ${command.type}`);
    }
  }

  /**
   * Handle chart subscription request
   */
  private async handleChartSubscription(payload: { token: string; timeframe?: string }, ws: WebSocket): Promise<void> {
    const { token, timeframe = '1s' } = payload;
    
    console.log(`📊 Chart subscription request: ${token} (${timeframe})`);
    
    // Use timeframe-specific key for price history
    const historyKey = `${token}:${timeframe}`;
    
    // Add client to subscribers for this token
    if (!this.chartSubscriptions.has(token)) {
      this.chartSubscriptions.set(token, new Set());
    }
    
    // Subscribe to Birdeye WebSocket for this token with new timeframe
    if (this.birdeyeWS) {
      try {
        // Don't unsubscribe - just resubscribe with new timeframe
        // Birdeye will handle updating the subscription
        await this.birdeyeWS.subscribeToPrices([token], timeframe);
        console.log(`✅ Subscribed to real-time prices: ${token} (${timeframe})`);
      } catch (error) {
        console.error(`Failed to subscribe to ${token}:`, error);
      }
    }
    
    this.chartSubscriptions.get(token)!.add(ws);
    
    // Always load chart history for the requested timeframe
    await this.loadChartHistory(token, timeframe);
    
    // Send the loaded history with timeframe
    this.sendChartHistory({ token, timeframe }, ws);
    
    // Confirm subscription
    this.sendMessage(ws, {
      type: 'chart_subscribed',
      data: { token, realTime: !!this.birdeyeWS, timeframe },
      timestamp: Date.now()
    });
  }

  /**
   * Handle chart unsubscription request
   */
  private async handleChartUnsubscription(payload: { token: string }, ws: WebSocket): Promise<void> {
    const { token } = payload;
    
    const subscribers = this.chartSubscriptions.get(token);
    if (subscribers) {
      subscribers.delete(ws);
      
      // If no more subscribers, remove from local tracking
      if (subscribers.size === 0) {
        this.chartSubscriptions.delete(token);
        
        // Note: We don't unsubscribe from Birdeye here because
        // UNSUBSCRIBE_PRICE unsubscribes from ALL tokens, not just one
        // This would break other subscriptions
        console.log(`📉 Removed local chart subscription: ${token}`);
      }
    }
  }

  /**
   * Load historical chart data from Birdeye REST API
   */
  private async loadChartHistory(token: string, timeframe: string): Promise<void> {
    try {
      const apiKey = this.wsConfig?.apiKey || process.env.BIRDEYE_API_KEY;
      if (!apiKey) return;
      
      const now = Math.floor(Date.now() / 1000);
      let fromTime = now - 3600; // Default 1 hour
      
      // Load more history - aim for ~300-500 candles
      switch(timeframe.toLowerCase()) {
        case '1s':
          fromTime = now - 600; // 10 minutes = 600 candles
          break;
        case '5s':
          fromTime = now - 2500; // ~40 minutes = 500 candles
          break;
        case '15s':
          fromTime = now - 7500; // ~2 hours = 500 candles
          break;
        case '30s':
          fromTime = now - 15000; // ~4 hours = 500 candles
          break;
        case '1m':
          fromTime = now - 30000; // ~8 hours = 500 candles
          break;
        case '3m':
          fromTime = now - 90000; // ~25 hours = 500 candles
          break;
        case '5m':
          fromTime = now - 150000; // ~41 hours = 500 candles
          break;
        case '15m':
          fromTime = now - 450000; // ~5 days = 500 candles
          break;
        default:
          fromTime = now - 7200; // Default 2 hours
          break;
      }
      
      // Normalize Birdeye type (REST doesn't support seconds; hours use uppercase H)
      // For sub-minute timeframes, load 1m data and we'll interpolate
      const typeMap: Record<string, string> = {
        '1s': '1m',  // Will load 1m data and show as is
        '5s': '1m',
        '15s': '1m',
        '30s': '1m',
        '1m': '1m',
        '3m': '3m',
        '5m': '5m',
        '15m': '15m',
        '30m': '30m',
        '1h': '1H',
        '2h': '2H',
        '4h': '4H',
        '6h': '6H',
        '8h': '8H',
        '12h': '12H',
        '1d': '1D',
        '3d': '3D',
        '1w': '1W'
      };
      const birdeyeType = typeMap[timeframe.toLowerCase()] || '1m';

      // Use v3 API which has better data availability
      const url = `https://public-api.birdeye.so/defi/v3/ohlcv?address=${token}&type=${birdeyeType}&time_from=${fromTime}&time_to=${now}`;
      console.log(`📊 Loading chart history: ${timeframe} from ${new Date(fromTime * 1000).toISOString()} to ${new Date(now * 1000).toISOString()}`);
      
      const response = await fetch(url, { 
        headers: { 
          'X-API-KEY': apiKey,
          'x-chain': 'solana',
          'Accept': 'application/json'
        } 
      });
      
      if (response.ok) {
        const data: any = await response.json();
        console.log(`📊 Birdeye API response for ${token}: ${data?.data?.items?.length || 0} items`);
        if (data?.data?.items && Array.isArray(data.data.items)) {
          // Log first item to debug timestamp format
          if (data.data.items.length > 0) {
            console.log(`📊 First candle raw data:`, data.data.items[0]);
          }
          
          const candles = data.data.items.map((item: any) => {
            // Birdeye v3 API uses unix_time (with underscore) in seconds
            let t = item.unix_time || item.unixTime || item.time || item.timestamp || 0;
            
            // Only convert if clearly in milliseconds (13+ digits)
            // Birdeye v3 returns seconds, so this shouldn't happen
            if (typeof t === 'number' && t > 1e10) {
              t = Math.floor(t / 1000);
            }
            
            return {
              time: t,
              open: item.o || 0,
              high: item.h || 0,
              low: item.l || 0,
              close: item.c || 0,
              volume: item.v || item.v_usd || 0
            };
          }).filter((c: any) => typeof c.time === 'number' && c.time > 0 && isFinite(c.time));

          // Sort ascending by time
          candles.sort((a: any, b: any) => a.time - b.time);

          // Store with timeframe-specific key
          const historyKey = `${token}:${timeframe}`;
          this.priceHistory.set(historyKey, candles);
          console.log(`📊 Loaded ${candles.length} historical candles for ${token} (${timeframe} -> ${birdeyeType})`);
        } else {
          console.log(`📊 No chart data in response for ${token}`);
        }
      } else {
        const errorText = await response.text();
        console.error(`Failed to load chart history: ${response.status} ${response.statusText}`, errorText);
      }
    } catch (error) {
      console.error('Error loading chart history:', error);
    }
  }

  /**
   * Send chart history to client
   */
  private sendChartHistory(payload: { token: string; timeframe?: string }, ws: WebSocket): void {
    const { token, timeframe = '1s' } = payload;
    const historyKey = `${token}:${timeframe}`;
    const history = this.priceHistory.get(historyKey) || [];
    
    if (history.length === 0) {
      console.log(`⚠️ No chart history available for ${token}, will wait for real-time data`);
    }
    
    this.sendMessage(ws, {
      type: 'chart_history',
      data: {
        token,
        candles: history,
        realTime: !!this.birdeyeWS
      },
      timestamp: Date.now()
    });
  }

  private sendMessage(ws: WebSocket, message: WebSocketMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, error: string): void {
    this.sendMessage(ws, {
      type: 'error',
      data: { error },
      timestamp: Date.now()
    });
  }

  public broadcast(message: WebSocketMessage): void {
    const messageStr = JSON.stringify(message);
    
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    }
  }

  // Update methods called by the bot
  public updateBotStatus(status: Partial<BotStatus>): void {
    this.botStatus = { ...this.botStatus, ...status, lastUpdate: Date.now() };
    this.broadcastBotStatus();
  }

  public updateTradeHistory(trades: any[]): void {
    this.tradeHistory = trades;
    // Send to all connected clients
    this.broadcast({
      type: 'trade_history',
      data: trades,
      timestamp: Date.now()
    });
  }

  private broadcastBotStatus(): void {
    this.broadcast({
      type: 'bot_status',
      data: this.botStatus,
      timestamp: Date.now()
    });
  }

  public updatePosition(position: Position): void {
    // Add timestamp to track when position was last updated by position manager
    const positionWithTimestamp = { ...position, lastUpdateTime: Date.now() };
    this.positions.set(position.token, positionWithTimestamp);

    // Debug logging to track P&L updates
    // Disabled: Dashboard handles real-time prices via Birdeye API
    // console.log(`📊 Position update: ${position.tokenSymbol} P&L: ${position.pnl?.toFixed(4)} SOL (${position.pnlPercent?.toFixed(2)}%)`);

    this.broadcast({
      type: 'position_update',
      data: {
        position: positionWithTimestamp,
        type: 'update'
      },
      timestamp: Date.now()
    });
  }

  public addPosition(position: Position): void {
    // Add timestamp to track when position was last updated by position manager
    const positionWithTimestamp = { ...position, lastUpdateTime: Date.now() };
    this.positions.set(position.token, positionWithTimestamp);

    // Send position_opened event for new positions
    this.broadcast({
      type: 'position_opened',
      data: positionWithTimestamp,
      timestamp: Date.now()
    });
    
    // Also send position_update for compatibility
    this.broadcast({
      type: 'position_update',
      data: {
        position: positionWithTimestamp,
        type: 'new'
      },
      timestamp: Date.now()
    });
  }

  public removePosition(token: string): void {
    const position = this.positions.get(token);
    if (position) {
      position.status = 'closed';
      // Broadcast the final update with closed status
      this.broadcast({
        type: 'position_update',
        data: {
          position: { ...position, status: 'closed' },
          type: 'closed'
        },
        timestamp: Date.now()
      });
      // Remove from the positions map
      this.positions.delete(token);
    }
  }

  public updateMarketData(token: string, data: Partial<MarketData>): void {
    const existing = this.marketData.get(token) || {
      token,
      price: 0,
      priceChange24h: 0,
      volume24h: 0,
      liquidity: 0,
      marketCap: 0,
      lastUpdate: Date.now()
    };

    const updated = { ...existing, ...data, lastUpdate: Date.now() };
    this.marketData.set(token, updated);

    // Throttle market data broadcasts to every 100ms
    if (!this.isThrottled('market_' + token, 100)) {
      this.broadcast({
        type: 'market_data',
        data: {
          tokenAddress: token,
          ...updated
        },
        timestamp: Date.now()
      });
    }
  }

  public updateConfig(config: DashboardConfig): void {
    this.config = config;
    
    this.broadcast({
      type: 'config_update',
      data: config,
      timestamp: Date.now()
    });
  }

  public broadcastSignal(signal: any): void {
    this.broadcast({
      type: 'signal',
      data: signal,
      timestamp: Date.now()
    });
  }

  public broadcastTraderTransaction(transaction: {
    type: 'BUY' | 'SELL';
    token: string;
    tokenSymbol: string;
    amount: number;
    price: number;
    trader: string;
    txHash?: string;
  }): void {
    // Save to database
    if (this.database) {
      this.database.saveTraderTransaction({
        trader_wallet: transaction.trader,
        type: transaction.type,
        token_address: transaction.token,
        token_symbol: transaction.tokenSymbol,
        amount: transaction.amount,
        price: transaction.price,
        tx_hash: transaction.txHash
      }).catch((error: any) => {
        console.error('Failed to save trader transaction to database:', error);
      });
    }

    this.broadcast({
      type: 'trader_transaction',
      data: {
        ...transaction,
        timestamp: Date.now()
      },
      timestamp: Date.now()
    });
  }

  public broadcastTradeExecution(execution: any): void {
    this.broadcast({
      type: 'trade_execution',
      data: execution,
      timestamp: Date.now()
    });
  }

  private throttleTimers: Map<string, number> = new Map();
  
  private isThrottled(key: string, delayMs: number): boolean {
    const lastTime = this.throttleTimers.get(key) || 0;
    const now = Date.now();
    
    if (now - lastTime < delayMs) {
      return true;
    }
    
    this.throttleTimers.set(key, now);
    return false;
  }

  private startBroadcastLoop(): void {
    // Send heartbeat and position updates every second
    this.broadcastInterval = setInterval(() => {
      // Update current prices from market data only (don't recalculate P&L)
      for (const position of this.positions.values()) {
        if ((position.status === 'open' || position.status === 'partial')) {
          const marketData = this.marketData.get(position.token);
          if (marketData && marketData.price !== position.currentPrice) {
            // Only update price if we have fresh market data and position hasn't been updated recently
            const timeSinceLastUpdate = Date.now() - (position as any).lastUpdateTime;
            if (timeSinceLastUpdate > 5000) { // Only auto-update if no update for 5+ seconds
              position.currentPrice = marketData.price;
            }
          }
        }
      }

      // Broadcast positions snapshot every 5 seconds
      if (!this.isThrottled('positions_snapshot', 5000)) {
        const positions = Array.from(this.positions.values());
        this.broadcast({
          type: 'position_update',
          data: { positions, type: 'snapshot' },
          timestamp: Date.now()
        });
      }

      // Check client health
      for (const client of this.clients) {
        if ((client as any).isAlive === false) {
          client.terminate();
          this.clients.delete(client);
        } else {
          (client as any).isAlive = false;
          client.ping();
        }
      }
    }, 1000);
  }

  public stop(): void {
    console.log('🛑 Stopping dashboard WebSocket server...');
    
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }

    // Close all client connections
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }

  public getConnectedClients(): number {
    return this.clients.size;
  }

  private sendToClient(ws: WebSocket, message: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private async handleBotControl(command: string, ws: WebSocket): Promise<void> {
    try {
      let message = '';
      let success = true;
      
      switch (command) {
        case 'start':
        case 'start_bot':
          // Resume trading (don't stop the process)
          this.emit('resume_bot');
          this.botStatus.isRunning = true;
          this.botStatus.isPaused = false;
          message = 'Trading resumed successfully';
          console.log('▶️ Bot trading resumed via dashboard');
          break;
          
        case 'stop':
        case 'stop_bot':
          // Pause trading (don't stop the process)
          this.emit('pause_bot');
          this.botStatus.isRunning = false;
          this.botStatus.isPaused = true;
          message = 'Trading paused successfully';
          console.log('⏸️ Bot trading paused via dashboard');
          break;
          
        case 'restart':
        case 'restart_bot':
          // Pause then resume trading
          this.emit('pause_bot');
          this.botStatus.isPaused = true;
          console.log('🔄 Bot restarting...');
          
          // Wait a moment then resume
          setTimeout(() => {
            this.emit('resume_bot');
            this.botStatus.isRunning = true;
            this.botStatus.isPaused = false;
            console.log('✅ Bot restarted');
          }, 1000);
          
          message = 'Bot restarting...';
          break;
          
        default:
          success = false;
          message = `Unknown command: ${command}`;
      }
      
      // Send response
      this.sendToClient(ws, {
        type: 'bot_control_response',
        data: {
          command,
          success,
          message,
          status: this.botStatus
        },
        timestamp: Date.now()
      });
      
      // Broadcast status update to all clients
      this.broadcastBotStatus();
      
      // Send updated system status
      await this.sendSystemStatus(ws);
      
    } catch (error: any) {
      console.error(`Bot control error for ${command}:`, error);
      this.sendToClient(ws, {
        type: 'bot_control_response',
        data: {
          command,
          success: false,
          message: `Failed to ${command.replace('_', ' ')}`,
          error: error?.message || 'Unknown error'
        },
        timestamp: Date.now()
      });
    }
  }

  private async executeBotCommand(command: string): Promise<string> {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    try {
      const { stdout, stderr } = await execAsync(command);
      if (stderr && !stderr.includes('Warning')) {
        console.warn('Command stderr:', stderr);
      }
      return stdout;
    } catch (error) {
      console.error('Command execution error:', error);
      throw error;
    }
  }

  private async sendRecentLogs(ws: WebSocket): Promise<void> {
    try {
      // Read logs directly from PM2 log files
      const fs = require('fs').promises;
      const path = require('path');
      
      let logs: string[] = [];
      
      // Try to read PM2 logs if available
      const logPath = '/home/ec2-user/copy-trader/logs/out-0.log';
      try {
        const logContent = await fs.readFile(logPath, 'utf8');
        const lines = logContent.split('\n');
        // Get last 100 lines
        logs = lines.slice(-100);
      } catch (fileError) {
        // If PM2 logs not available, use console output buffer
        console.log('PM2 logs not available, using console buffer');
        logs = ['[Logs not available - bot may be running locally]'];
      }
      
      this.sendToClient(ws, {
        type: 'log_message',
        data: {
          logs: logs,
          timestamp: Date.now()
        },
        timestamp: Date.now()
      });
    } catch (error: any) {
      console.error('Error fetching logs:', error);
      this.sendToClient(ws, {
        type: 'error',
        data: {
          message: 'Failed to fetch logs',
          error: error?.message || 'Unknown error'
        },
        timestamp: Date.now()
      });
    }
  }

  private async sendSystemStatus(ws: WebSocket): Promise<void> {
    try {
      // Get current process info
      const uptime = process.uptime();
      const memUsage = process.memoryUsage();
      
      const systemStatus = {
        isRunning: this.botStatus.isRunning && !this.botStatus.isPaused,
        status: this.botStatus.isPaused ? 'paused' : (this.botStatus.isRunning ? 'online' : 'stopped'),
        cpu: process.cpuUsage().user / 1000000, // Convert to percentage approximation
        memory: memUsage.heapUsed,
        uptime: uptime * 1000, // Convert to milliseconds
        restarts: 0, // Can't track restarts without PM2
        mode: this.config?.paperTrading ? 'paper' : 'live',
        activePositions: this.positions.size,
        connectedWallets: 1 // Single target wallet
      };
      
      this.sendToClient(ws, {
        type: 'system_status',
        data: systemStatus,
        timestamp: Date.now()
      });
    } catch (error: any) {
      console.error('Error fetching system status:', error);
      // Send basic status if PM2 command fails
      this.sendToClient(ws, {
        type: 'system_status',
        data: {
          isRunning: false,
          status: 'unknown',
          error: error?.message || 'Unknown error'
        },
        timestamp: Date.now()
      });
    }
  }

  private handleTradingModeChange(mode: 'paper' | 'live', ws: WebSocket): void {
    if (this.config) {
      this.config.paperTrading = mode === 'paper';
      
      // Broadcast config update to all clients
      this.broadcast({
        type: 'config_update',
        data: this.config,
        timestamp: Date.now()
      });
      
      this.sendToClient(ws, {
        type: 'bot_control_response',
        data: {
          command: 'set_trading_mode',
          success: true,
          message: `Trading mode set to ${mode}`,
          mode
        },
        timestamp: Date.now()
      });
    }
  }
}