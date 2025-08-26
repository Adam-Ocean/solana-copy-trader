import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Position, PositionEntry, PartialExit, WalletSignal, DashboardConfig, BirdeyeWebSocketConfig } from '../types/enhanced';
import { BirdeyeWebSocketService, PriceUpdate } from './BirdeyeWebSocketService';
import { TelegramAlerts } from './TelegramAlerts';

export class EnhancedPositionManagerWithWebSocket extends EventEmitter {
  private positions: Map<string, Position> = new Map();
  private closedPositions: Position[] = [];
  private solPriceUSD: number = 180; // Default SOL price
  private lastSolPriceUpdate: number = 0;
  private readonly SOL_PRICE_CACHE_DURATION = 300000; // 5 minutes cache
  
  // WebSocket service for real-time prices
  private birdeyeWS: BirdeyeWebSocketService | null = null;
  private subscribedTokens: Set<string> = new Set();
  private priceUpdateInterval: NodeJS.Timeout | null = null;
  private useWebSocket: boolean = false;
  private telegramAlerts: TelegramAlerts;

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
    private config: DashboardConfig = {
      maxPositions: 5,
      partialExitEnabled: true,
      partialExitPercent: [25, 50, 75],
      positionSize: 0.5,
      paperTrading: true,
      copyTrading: true,
      globalStop: false
    },
    private wsConfig?: BirdeyeWebSocketConfig
  ) {
    super();
    this.dailyStats.startBalance = 10;
    this.dailyStats.currentBalance = 10;
    
    // Initialize Telegram alerts
    this.telegramAlerts = new TelegramAlerts();
    
    // Initialize WebSocket if config provided and enabled
    if (wsConfig?.enabled && wsConfig?.apiKey) {
      this.initializeWebSocket();
    } else {
      // Fall back to REST API polling
      this.initializeRestPolling();
    }
  }

  /**
   * Initialize Birdeye WebSocket for real-time price updates
   */
  private async initializeWebSocket(): Promise<void> {
    try {
      console.log('🚀 Initializing Birdeye WebSocket for real-time prices...');
      
      this.birdeyeWS = new BirdeyeWebSocketService({
        apiKey: this.wsConfig!.apiKey,
        maxConnections: this.wsConfig?.maxConnections || 2,
        reconnectDelay: this.wsConfig?.reconnectDelay || 1000,
        maxReconnectDelay: this.wsConfig?.maxReconnectDelay || 30000
      });

      // Connect to WebSocket
      await this.birdeyeWS.connect();
      this.useWebSocket = true;

      // Subscribe to SOL price
      await this.birdeyeWS.subscribeToPrices(['So11111111111111111111111111111111111111112']);
      
      // Handle real-time price updates
      this.birdeyeWS.on('price-update', (priceUpdate: PriceUpdate) => {
        this.handleWebSocketPriceUpdate(priceUpdate);
      });

      // Handle connection events
      this.birdeyeWS.on('connected', () => {
        console.log('✅ WebSocket connected, re-subscribing to position tokens...');
        this.resubscribeToPositionTokens();
      });

      this.birdeyeWS.on('disconnected', () => {
        console.log('❌ WebSocket disconnected, falling back to REST...');
        this.useWebSocket = false;
      });

      console.log('✅ Birdeye WebSocket initialized for real-time price updates');
      
    } catch (error) {
      console.error('❌ Failed to initialize WebSocket, falling back to REST:', error);
      this.useWebSocket = false;
      this.initializeRestPolling();
    }
  }

  /**
   * Initialize REST API polling as fallback
   */
  private initializeRestPolling(): void {
    console.log('📊 Using REST API polling for price updates');
    
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

  /**
   * Handle real-time price update from WebSocket
   */
  private handleWebSocketPriceUpdate(priceUpdate: PriceUpdate): void {
    const { token, price, timestamp } = priceUpdate;
    
    // Update SOL price
    if (token === 'So11111111111111111111111111111111111111112') {
      this.solPriceUSD = price;
      this.lastSolPriceUpdate = timestamp;
      this.emit('sol-price-update', price);
    }
    
    // Update position prices in real-time
    const position = this.positions.get(token);
    if (position && (position.status === 'open' || position.status === 'partial')) {
      const oldPrice = position.currentPrice;
      position.currentPrice = price;
      
      // Calculate P&L with new price
      const pnl = this.calculatePositionPnL(position);
      position.pnl = pnl.pnl;
      position.pnlPercent = pnl.pnlPercent;
      
      // Emit real-time update
      this.emit('position-price-update', {
        token,
        oldPrice,
        newPrice: price,
        pnl: pnl.pnl,
        pnlPercent: pnl.pnlPercent,
        timestamp
      });
    }
  }

  /**
   * Subscribe to price updates for a new position
   */
  private async subscribeToPositionToken(token: string): Promise<void> {
    if (!this.birdeyeWS || !this.useWebSocket) return;
    
    if (!this.subscribedTokens.has(token)) {
      try {
        await this.birdeyeWS.subscribeToPrices([token]);
        this.subscribedTokens.add(token);
        console.log(`📈 Subscribed to real-time prices for ${token}`);
      } catch (error) {
        console.error(`Failed to subscribe to ${token}:`, error);
      }
    }
  }

  /**
   * Unsubscribe from price updates when position closes
   */
  private async unsubscribeFromPositionToken(token: string): Promise<void> {
    if (!this.birdeyeWS || !this.useWebSocket) return;
    
    // Check if any other positions use this token
    const otherPositions = Array.from(this.positions.values()).filter(
      p => p.token === token && (p.status === 'open' || p.status === 'partial')
    );
    
    if (otherPositions.length === 0 && this.subscribedTokens.has(token)) {
      try {
        await this.birdeyeWS.unsubscribeFromPrices([token]);
        this.subscribedTokens.delete(token);
        console.log(`📉 Unsubscribed from real-time prices for ${token}`);
      } catch (error) {
        console.error(`Failed to unsubscribe from ${token}:`, error);
      }
    }
  }

  /**
   * Re-subscribe to all position tokens after reconnection
   */
  private async resubscribeToPositionTokens(): Promise<void> {
    if (!this.birdeyeWS || !this.useWebSocket) return;
    
    const activeTokens = new Set<string>();
    
    // Always subscribe to SOL
    activeTokens.add('So11111111111111111111111111111111111111112');
    
    // Add all open position tokens
    for (const position of this.positions.values()) {
      if (position.status === 'open' || position.status === 'partial') {
        activeTokens.add(position.token);
      }
    }
    
    if (activeTokens.size > 0) {
      try {
        await this.birdeyeWS.subscribeToPrices(Array.from(activeTokens));
        this.subscribedTokens = activeTokens;
        console.log(`📊 Re-subscribed to ${activeTokens.size} tokens`);
      } catch (error) {
        console.error('Failed to re-subscribe to tokens:', error);
      }
    }
  }

  // ... Rest of the existing EnhancedPositionManager methods remain the same ...
  
  /**
   * Add or update a position with WebSocket subscription
   */
  async addOrUpdatePosition(signal: WalletSignal): Promise<Position | null> {
    // Call the original implementation
    const position = await this.addOrUpdatePositionInternal(signal);
    
    // Subscribe to real-time prices if using WebSocket
    if (position && this.useWebSocket) {
      await this.subscribeToPositionToken(position.token);
    }
    
    return position;
  }

  /**
   * Close a position and unsubscribe from price updates
   */
  async closePosition(token: string, exitPrice: number, exitAmount: number, exitTx: string): Promise<Position | null> {
    const position = this.positions.get(token);
    if (!position) return null;
    
    // Update position status
    position.status = 'closed';
    position.exitPrice = exitPrice;
    position.exitAmount = exitAmount;
    position.exitTx = exitTx;
    position.exitTime = Date.now();
    
    // Calculate final P&L
    const pnl = this.calculatePositionPnL(position);
    position.pnl = pnl.pnl;
    position.pnlPercent = pnl.pnlPercent;
    
    // Update stats
    this.updateStats(position);
    
    // Move to closed positions
    this.closedPositions.push(position);
    this.positions.delete(token);
    
    // Unsubscribe from price updates if using WebSocket
    if (this.useWebSocket) {
      await this.unsubscribeFromPositionToken(token);
    }
    
    // Emit events
    this.emit('position-closed', position);
    this.emit('stats-update', this.getStats());
    
    return position;
  }

  /**
   * Get WebSocket status
   */
  getWebSocketStatus(): { 
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

  /**
   * Cleanup and disconnect WebSocket
   */
  async cleanup(): Promise<void> {
    if (this.birdeyeWS) {
      await this.birdeyeWS.disconnect();
      this.birdeyeWS = null;
    }
    
    if (this.priceUpdateInterval) {
      clearInterval(this.priceUpdateInterval);
      this.priceUpdateInterval = null;
    }
    
    this.subscribedTokens.clear();
    this.useWebSocket = false;
  }

  // Placeholder for the internal implementation
  private async addOrUpdatePositionInternal(signal: WalletSignal): Promise<Position | null> {
    // This would contain the original addOrUpdatePosition logic
    // For now, returning null as placeholder
    return null;
  }

  private calculatePositionPnL(position: Position): { pnl: number; pnlPercent: number } {
    // Calculate P&L based on current price
    const currentValue = position.tokenAmount * position.currentPrice;
    const entryValue = position.entryAmount;
    const pnl = currentValue - entryValue;
    const pnlPercent = (pnl / entryValue) * 100;
    
    return { pnl, pnlPercent };
  }

  private updateStats(position: Position): void {
    // Update daily stats based on closed position
    if (position.pnl) {
      this.dailyStats.totalPnL += position.pnl;
      
      if (position.pnl > 0) {
        this.dailyStats.totalWins++;
        this.dailyStats.largestWin = Math.max(this.dailyStats.largestWin, position.pnl);
      } else {
        this.dailyStats.totalLosses++;
        this.dailyStats.largestLoss = Math.min(this.dailyStats.largestLoss, position.pnl);
      }
      
      // Update win rate
      const totalTrades = this.dailyStats.totalWins + this.dailyStats.totalLosses;
      this.dailyStats.winRate = totalTrades > 0 ? (this.dailyStats.totalWins / totalTrades) * 100 : 0;
    }
  }

  private async updateSolPrice(): Promise<void> {
    // Existing REST API implementation for fallback
    // ... (keep the existing updateSolPrice logic)
  }

  private getStats(): any {
    return this.dailyStats;
  }
}