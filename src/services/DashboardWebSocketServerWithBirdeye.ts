import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import EventEmitter from 'events';
import { BirdeyeWebSocketService, PriceUpdate } from './BirdeyeWebSocketService';
import { BirdeyeWebSocketConfig } from '../types/enhanced';

export class DashboardWebSocketServerWithBirdeye extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private httpServer: any = null;
  private clients: Set<WebSocket> = new Set();
  private port: number;
  
  // Birdeye WebSocket for real-time prices
  private birdeyeWS: BirdeyeWebSocketService | null = null;
  private chartSubscriptions: Map<string, Set<WebSocket>> = new Map(); // token -> clients interested
  private priceHistory: Map<string, any[]> = new Map(); // Store recent price history for charts
  private readonly MAX_HISTORY_SIZE = 1000; // Keep last 1000 price points per token

  private botStatus = {
    isRunning: false,
    isPaused: false,
    mode: 'paper' as 'paper' | 'live',
    connectedWallets: [] as string[],
    activePositions: 0,
    totalPositions: 0,
    dailyPnL: 0,
    totalPnL: 0,
    winRate: 0,
    avgWin: 0,
    avgLoss: 0,
    lastUpdate: Date.now()
  };

  private positions = new Map();
  private marketData = new Map();
  private config: any = null;
  private broadcastInterval: NodeJS.Timeout | null = null;
  private throttleTimers = new Map();

  constructor(port: number, private wsConfig?: BirdeyeWebSocketConfig) {
    super();
    this.port = port;
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

        this.wss.on('connection', (ws: WebSocket) => {
          this.handleConnection(ws);
        });

        this.httpServer.listen(this.port, () => {
          console.log(`🌐 Dashboard WebSocket server running on port ${this.port}`);
          
          // Initialize Birdeye WebSocket if configured
          if (this.wsConfig?.enabled && this.wsConfig?.apiKey) {
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
      
      this.birdeyeWS = new BirdeyeWebSocketService({
        apiKey: this.wsConfig!.apiKey,
        maxConnections: 2, // One for prices, one for backup
        reconnectDelay: 1000,
        maxReconnectDelay: 30000
      });

      await this.birdeyeWS.connect();

      // Handle real-time price updates
      this.birdeyeWS.on('price-update', (priceUpdate: PriceUpdate) => {
        this.handleBirdeyePriceUpdate(priceUpdate);
      });

      // Subscribe to SOL by default for chart
      await this.birdeyeWS.subscribeToPrices(['So11111111111111111111111111111111111111112']);
      
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
    const { token, price, timestamp, volume24h, priceChange24hPercent } = priceUpdate;
    
    // Update market data
    const existing = this.marketData.get(token) || {};
    this.marketData.set(token, {
      ...existing,
      price,
      priceChange24h: priceChange24hPercent || 0,
      volume24h: volume24h || 0,
      lastUpdate: timestamp
    });

    // Add to price history for chart
    if (!this.priceHistory.has(token)) {
      this.priceHistory.set(token, []);
    }
    
    const history = this.priceHistory.get(token)!;
    const chartPoint = {
      time: Math.floor(timestamp / 1000), // Convert to seconds for chart
      open: price,
      high: price,
      low: price,
      close: price,
      volume: volume24h || 0
    };
    
    // Check if we should update the last candle or create a new one
    if (history.length > 0) {
      const lastCandle = history[history.length - 1];
      // If within the same second, update the candle
      if (lastCandle.time === chartPoint.time) {
        lastCandle.high = Math.max(lastCandle.high, price);
        lastCandle.low = Math.min(lastCandle.low, price);
        lastCandle.close = price;
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
        type: 'chart_update',
        data: {
          token,
          candle: chartPoint,
          price,
          priceChange24h: priceChange24hPercent,
          volume24h
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

  private handleConnection(ws: WebSocket & { isAlive?: boolean }): void {
    console.log('📱 New dashboard client connected');
    this.clients.add(ws);
    
    // Send initial state
    this.sendInitialState(ws);
    
    // Handle client messages
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
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

    ws.on('error', (error: Error) => {
      console.error('Client WebSocket error:', error);
      this.clients.delete(ws);
    });

    // Setup ping/pong for connection health
    ws.on('pong', () => {
      ws.isAlive = true;
    });
  }

  private handleCommand(command: any, ws: WebSocket): void {
    console.log(`📡 Received command: ${command.type}`);
    
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
        
      // ... existing command handlers ...
      
      default:
        // Handle existing commands
        this.emit(command.type, command.payload);
    }
  }

  /**
   * Handle chart subscription request
   */
  private async handleChartSubscription(payload: { token: string }, ws: WebSocket): Promise<void> {
    const { token } = payload;
    
    // Add client to subscribers for this token
    if (!this.chartSubscriptions.has(token)) {
      this.chartSubscriptions.set(token, new Set());
      
      // Subscribe to Birdeye WebSocket for this token
      if (this.birdeyeWS) {
        try {
          await this.birdeyeWS.subscribeToPrices([token]);
          console.log(`📊 Subscribed to real-time prices for chart: ${token}`);
        } catch (error) {
          console.error(`Failed to subscribe to ${token}:`, error);
        }
      }
    }
    
    this.chartSubscriptions.get(token)!.add(ws);
    
    // Send current price history if available
    this.sendChartHistory({ token }, ws);
    
    // Confirm subscription
    this.sendMessage(ws, {
      type: 'chart_subscribed',
      data: { token, realTime: !!this.birdeyeWS },
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
      
      // If no more subscribers, unsubscribe from Birdeye
      if (subscribers.size === 0) {
        this.chartSubscriptions.delete(token);
        
        if (this.birdeyeWS) {
          try {
            await this.birdeyeWS.unsubscribeFromPrices([token]);
            console.log(`📉 Unsubscribed from real-time prices for chart: ${token}`);
          } catch (error) {
            console.error(`Failed to unsubscribe from ${token}:`, error);
          }
        }
      }
    }
  }

  /**
   * Send chart history to client
   */
  private sendChartHistory(payload: { token: string }, ws: WebSocket): void {
    const { token } = payload;
    const history = this.priceHistory.get(token) || [];
    
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

  private sendInitialState(ws: WebSocket): void {
    // Send bot status
    this.sendMessage(ws, {
      type: 'bot_status',
      data: this.botStatus,
      timestamp: Date.now()
    });

    // Send WebSocket status
    if (this.birdeyeWS) {
      this.sendMessage(ws, {
        type: 'websocket_status',
        data: {
          birdeye: 'connected',
          realTimeEnabled: true,
          connectionStatus: this.birdeyeWS.getStatus(),
          subscriptions: this.birdeyeWS.getSubscriptionCounts()
        },
        timestamp: Date.now()
      });
    }

    // ... rest of initial state ...
  }

  private sendMessage(ws: WebSocket, message: any): void {
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

  private broadcast(message: any): void {
    const messageStr = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    }
  }

  private startBroadcastLoop(): void {
    // Reduced frequency since we have real-time updates
    this.broadcastInterval = setInterval(() => {
      // Check client health
      for (const client of this.clients) {
        const wsClient = client as WebSocket & { isAlive?: boolean };
        if (wsClient.isAlive === false) {
          client.terminate();
          this.clients.delete(client);
        } else {
          wsClient.isAlive = false;
          client.ping();
        }
      }
    }, 30000); // Every 30 seconds instead of every second
  }

  async stop(): Promise<void> {
    console.log('🛑 Stopping dashboard WebSocket server...');
    
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }

    // Disconnect from Birdeye WebSocket
    if (this.birdeyeWS) {
      await this.birdeyeWS.disconnect();
      this.birdeyeWS = null;
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

  getConnectedClients(): number {
    return this.clients.size;
  }

  getWebSocketStatus(): any {
    if (!this.birdeyeWS) {
      return { enabled: false, connected: false };
    }
    
    return {
      enabled: true,
      connected: true,
      status: this.birdeyeWS.getStatus(),
      subscriptions: this.birdeyeWS.getSubscriptionCounts(),
      chartSubscriptions: this.chartSubscriptions.size
    };
  }
}