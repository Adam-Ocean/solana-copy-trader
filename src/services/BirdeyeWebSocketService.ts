import { EventEmitter } from 'events';
import { client as WebSocketClient, connection as WebSocketConnection } from 'websocket';
import * as util from 'util';

export interface BirdeyeConfig {
  apiKey: string;
  chain?: string;
  maxConnections?: number;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  heartbeatInterval?: number;
  messageQueueSize?: number;
}

export interface PriceUpdate {
  token: string;
  symbol?: string;
  price: number;
  priceChange24h?: number;
  priceChange24hPercent?: number;
  volume24h?: number;
  liquidity?: number;
  marketCap?: number;
  timestamp: number;
  updateType?: 'trade' | 'liquidity' | 'oracle' | 'aggregated';
  // OHLCV data
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  unixTime?: number;
}

export interface WalletTransaction {
  wallet: string;
  signature: string;
  type: 'swap' | 'transfer' | 'mint' | 'burn' | 'stake' | 'unstake' | string;
  timestamp: number;
  slot?: number;
  status?: string;
  tokenIn?: TokenInfo;
  tokenOut?: TokenInfo;
  platform?: string;
  fee?: number;
  priceImpact?: number;
  // Birdeye specific fields
  blockUnixTime?: number;
  owner?: string;
  txHash?: string;
  volumeUSD?: number;
  network?: string;
  base?: {
    symbol: string;
    address: string;
    uiAmount: number;
  };
  quote?: {
    symbol: string;
    address: string;
    uiAmount: number;
  };
}

export interface TokenInfo {
  address: string;
  symbol: string;
  amount: number;
  decimals?: number;
  usdValue?: number;
}

export interface TokenTransaction {
  signature: string;
  token: string;
  type: string;
  side: 'buy' | 'sell';
  timestamp: number;
  slot?: number;
  buyer?: string;
  seller?: string;
  amount: number;
  price: number;
  value?: number;
  platform?: string;
  poolAddress?: string;
  priceImpact?: number;
}

interface ConnectionInfo {
  connection: WebSocketConnection | null;
  client: any;
  subscriptions: Set<string>;
  reconnectAttempts: number;
  pingInterval?: NodeJS.Timeout;
}

export class BirdeyeWebSocketService extends EventEmitter {
  private config: BirdeyeConfig;
  private connections: Map<string, ConnectionInfo> = new Map();
  private isConnected: boolean = false;
  private priceCache: Map<string, PriceUpdate> = new Map();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: BirdeyeConfig) {
    super();
    this.config = {
      chain: 'solana',
      maxConnections: 5,
      reconnectDelay: 1000,
      maxReconnectDelay: 30000,
      heartbeatInterval: 30000,
      messageQueueSize: 1000,
      ...config
    };
  }

  /**
   * Initialize WebSocket connections
   */
  async connect(): Promise<void> {
    console.log('🦅 Initializing Birdeye WebSocket connections...');
    
    try {
      // Create separate connections for different data types
      await Promise.all([
        this.createConnection('prices'),
        this.createConnection('wallets')
      ]);
      
      this.isConnected = true;
      console.log('✅ All Birdeye WebSocket connections established');
      this.emit('connected');
    } catch (error) {
      console.error('❌ Failed to establish WebSocket connections:', error);
      throw error;
    }
  }

  /**
   * Create a WebSocket connection with proper headers
   */
  private async createConnection(connectionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`   Connecting ${connectionId} endpoint...`);
      
      const client = new WebSocketClient();
      const url = util.format(
        'wss://public-api.birdeye.so/socket/%s?x-api-key=%s',
        this.config.chain,
        this.config.apiKey
      );

      // Store connection info
      const connInfo: ConnectionInfo = {
        connection: null,
        client: client,
        subscriptions: new Set(),
        reconnectAttempts: 0
      };
      this.connections.set(connectionId, connInfo);

      client.on('connectFailed', (error: Error) => {
        console.error(`❌ ${connectionId} connection failed:`, error.message);
        this.scheduleReconnect(connectionId);
        reject(error);
      });

      client.on('connect', (connection: WebSocketConnection) => {
        console.log(`   ✅ ${connectionId} endpoint connected`);
        
        connInfo.connection = connection;
        connInfo.reconnectAttempts = 0;
        
        // Clear any pending reconnect timer
        if (this.reconnectTimers.has(connectionId)) {
          clearTimeout(this.reconnectTimers.get(connectionId)!);
          this.reconnectTimers.delete(connectionId);
        }

        connection.on('error', (error: Error) => {
          console.error(`❌ Error from ${connectionId}:`, error.message);
          this.emit('error', { connectionId, error });
        });

        connection.on('close', () => {
          console.log(`❌ ${connectionId} WebSocket closed`);
          connInfo.connection = null;
          this.clearPingInterval(connectionId);
          
          if (this.isConnected) {
            this.scheduleReconnect(connectionId);
          }
          
          this.emit('disconnected', connectionId);
        });

        connection.on('message', (message) => {
          if (message.type === 'utf8' && message.utf8Data) {
            try {
              const data = JSON.parse(message.utf8Data);
              this.handleMessage(connectionId, data);
            } catch (error) {
              console.error(`Error parsing message from ${connectionId}:`, error);
            }
          }
        });

        // Setup ping-pong heartbeat
        this.setupPingPong(connectionId, connection);

        // Restore subscriptions if reconnecting
        if (connInfo.subscriptions.size > 0) {
          this.restoreSubscriptions(connectionId);
        }

        this.emit('connected', connectionId);
        resolve();
      });

      // Connect with echo-protocol as required by Birdeye
      client.connect(url, 'echo-protocol');
    });
  }

  /**
   * Setup ping-pong heartbeat to keep connection alive
   */
  private setupPingPong(connectionId: string, connection: WebSocketConnection): void {
    const connInfo = this.connections.get(connectionId);
    if (!connInfo) return;

    // Clear existing interval if any
    this.clearPingInterval(connectionId);

    const interval = setInterval(() => {
      if (connection.connected) {
        connection.ping(Buffer.from(''));
      }
    }, this.config.heartbeatInterval);

    connInfo.pingInterval = interval;

    connection.on('pong', () => {
      // Connection is healthy
    });
  }

  /**
   * Clear ping interval for a connection
   */
  private clearPingInterval(connectionId: string): void {
    const connInfo = this.connections.get(connectionId);
    if (connInfo?.pingInterval) {
      clearInterval(connInfo.pingInterval);
      connInfo.pingInterval = undefined;
    }
  }

  /**
   * Handle incoming messages from Birdeye
   */
  private handleMessage(connectionId: string, message: any): void {
    switch (message.type) {
      case 'PRICE_DATA':
        this.handlePriceData(message.data);
        break;
        
      case 'TXS_DATA':
        this.handleTransactionData(message.data);
        break;
        
      case 'WALLET_TXS_DATA':
        this.handleWalletTransaction(message.data);
        break;
        
      case 'WELCOME':
        console.log(`   Welcome message from ${connectionId}`);
        break;
        
      case 'ERROR':
        console.error(`❌ Error from ${connectionId}:`, message.data);
        this.emit('subscription-error', { connectionId, error: message.data });
        break;
        
      default:
        // Unknown message type
        this.emit('unknown-message', { connectionId, message });
    }
  }

  /**
   * Handle price data updates
   */
  private handlePriceData(data: any): void {
    const priceUpdate: PriceUpdate = {
      token: data.address,
      symbol: data.symbol,
      price: data.c || data.close || 0,
      timestamp: Date.now(),
      o: data.o,
      h: data.h,
      l: data.l,
      c: data.c,
      v: data.v,
      unixTime: data.unixTime,
      updateType: data.eventType
    };
    
    // Update cache
    this.priceCache.set(data.address, priceUpdate);
    
    // Emit events
    this.emit('price-update', priceUpdate);
    this.emit(`price:${data.address}`, priceUpdate);
  }

  /**
   * Handle transaction data
   */
  private handleTransactionData(data: any): void {
    const txUpdate: TokenTransaction = {
      signature: data.txHash,
      token: data.tokenAddress || data.address,
      type: data.type || 'swap',
      side: data.side || 'buy',
      amount: data.amount || 0,
      price: data.tokenPrice || data.price || 0,
      timestamp: (data.blockUnixTime || data.unixTime) * 1000,
      buyer: data.buyer,
      seller: data.seller,
      platform: data.source || data.platform
    };
    
    this.emit('transaction-update', txUpdate);
    this.emit(`token:${txUpdate.token}`, txUpdate);
  }

  /**
   * Handle wallet transaction data
   */
  private handleWalletTransaction(data: any): void {
    const walletTx: WalletTransaction = {
      wallet: data.owner || data.wallet,
      signature: data.txHash,
      type: data.type,
      timestamp: (data.blockUnixTime || data.unixTime) * 1000,
      blockUnixTime: data.blockUnixTime,
      owner: data.owner,
      txHash: data.txHash,
      volumeUSD: data.volumeUSD,
      network: data.network,
      base: data.base,
      quote: data.quote
    };
    
    this.emit('wallet-transaction', walletTx);
    this.emit(`wallet:${walletTx.wallet}`, walletTx);
    
    // Emit trade signal for swaps
    if (data.type === 'swap' && data.quote) {
      this.emit('trade-signal', {
        wallet: walletTx.wallet,
        action: 'buy',
        token: data.quote.address,
        amount: data.base?.uiAmount || 0,
        signature: data.txHash,
        timestamp: walletTx.timestamp
      });
    }
  }

  /**
   * Subscribe to price updates
   */
  async subscribeToPrices(tokens: string[], chartType: string = '1s'): Promise<void> {
    const connInfo = this.connections.get('prices');
    if (!connInfo?.connection?.connected) {
      console.warn('Prices connection not available');
      return;
    }

    // Validate Solana-specific timeframes (from Birdeye docs)
    const validTimeframes = ['1s', '5s', '15s', '30s', '1m', '3m', '5m', '15m', '30m', 
                           '1H', '2H', '4H', '6H', '8H', '12H', '1D', '3D', '1W', '1M'];
    if (!validTimeframes.includes(chartType)) {
      console.warn(`Invalid timeframe ${chartType}, using 1m`);
      chartType = '1m';
    }

    // Subscribe in batches of 100 (Birdeye limit)
    const batchSize = 100;
    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      
      if (batch.length === 1) {
        // Simple subscription for single token
        const msg = {
          type: 'SUBSCRIBE_PRICE',
          data: {
            queryType: 'simple',
            chartType: chartType,
            currency: 'usd',
            address: batch[0]
          }
        };
        
        connInfo.connection.send(JSON.stringify(msg));
        connInfo.subscriptions.add(batch[0]);
        console.log(`Subscribing to ${batch[0]} with ${chartType} timeframe`);
      } else {
        // Complex query for multiple tokens
        const queries = batch.map(token => 
          `(address = ${token} AND chartType = ${chartType} AND currency = usd)`
        ).join(' OR ');
        
        const msg = {
          type: 'SUBSCRIBE_PRICE',
          data: {
            queryType: 'complex',
            query: queries
          }
        };
        
        connInfo.connection.send(JSON.stringify(msg));
        batch.forEach(token => connInfo.subscriptions.add(token));
      }
    }
    
    console.log(`📊 Subscribed to ${tokens.length} token prices with ${chartType} timeframe`);
  }

  /**
   * Unsubscribe from price updates
   */
  async unsubscribeFromPrices(tokens: string[]): Promise<void> {
    const connInfo = this.connections.get('prices');
    if (!connInfo?.connection?.connected) return;

    // According to Birdeye docs, unsubscribe doesn't need address
    const msg = {
      type: 'UNSUBSCRIBE_PRICE'
    };
    
    connInfo.connection.send(JSON.stringify(msg));
    
    // Clear all subscriptions for these tokens
    for (const token of tokens) {
      connInfo.subscriptions.delete(token);
    }
    
    console.log(`📉 Unsubscribed from ${tokens.length} token prices`);
  }

  /**
   * Subscribe to wallet transactions
   */
  async subscribeToWallets(wallets: string[]): Promise<void> {
    const connInfo = this.connections.get('wallets');
    if (!connInfo?.connection?.connected) {
      console.warn('Wallets connection not available');
      return;
    }

    // Birdeye limit: 1 wallet per connection for detailed tracking
    for (const wallet of wallets) {
      const msg = {
        type: 'SUBSCRIBE_WALLET_TXS',
        data: {
          address: wallet
        }
      };
      
      connInfo.connection.send(JSON.stringify(msg));
      connInfo.subscriptions.add(wallet);
    }
    
    console.log(`👛 Subscribed to ${wallets.length} wallet(s)`);
  }

  /**
   * Subscribe to token transactions
   */
  async subscribeToTransactions(tokens: string[]): Promise<void> {
    const connInfo = this.connections.get('prices'); // Use prices connection for transactions
    if (!connInfo?.connection?.connected) {
      console.warn('Connection not available for transactions');
      return;
    }

    for (const token of tokens) {
      const msg = {
        type: 'SUBSCRIBE_TXS',
        data: {
          queryType: 'simple',
          address: token
        }
      };
      
      connInfo.connection.send(JSON.stringify(msg));
    }
    
    console.log(`📝 Subscribed to transactions for ${tokens.length} tokens`);
  }

  /**
   * Restore subscriptions after reconnection
   */
  private restoreSubscriptions(connectionId: string): void {
    const connInfo = this.connections.get(connectionId);
    if (!connInfo || !connInfo.connection || connInfo.subscriptions.size === 0) return;

    console.log(`   Restoring ${connInfo.subscriptions.size} subscriptions for ${connectionId}...`);
    
    const tokens = Array.from(connInfo.subscriptions);
    
    if (connectionId === 'prices') {
      // Resubscribe to prices
      tokens.forEach(token => {
        const msg = {
          type: 'SUBSCRIBE_PRICE',
          data: {
            queryType: 'simple',
            chartType: '1s',
            address: token,
            currency: 'usd'
          }
        };
        connInfo.connection!.send(JSON.stringify(msg));
      });
    } else if (connectionId === 'wallets') {
      // Resubscribe to wallets
      tokens.forEach(wallet => {
        const msg = {
          type: 'SUBSCRIBE_WALLET_TXS',
          data: {
            address: wallet
          }
        };
        connInfo.connection!.send(JSON.stringify(msg));
      });
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(connectionId: string): void {
    const connInfo = this.connections.get(connectionId);
    if (!connInfo) return;

    const attempts = connInfo.reconnectAttempts;
    const delay = Math.min(
      this.config.reconnectDelay! * Math.pow(2, attempts),
      this.config.maxReconnectDelay!
    );

    console.log(`   Reconnecting ${connectionId} in ${delay}ms (attempt ${attempts + 1})...`);
    
    const timer = setTimeout(() => {
      connInfo.reconnectAttempts++;
      this.createConnection(connectionId).catch(error => {
        console.error(`Failed to reconnect ${connectionId}:`, error);
      });
    }, delay);

    this.reconnectTimers.set(connectionId, timer);
  }

  /**
   * Get cached price for a token
   */
  getCachedPrice(token: string): PriceUpdate | undefined {
    return this.priceCache.get(token);
  }

  /**
   * Get all cached prices
   */
  getAllCachedPrices(): Map<string, PriceUpdate> {
    return new Map(this.priceCache);
  }

  /**
   * Disconnect all connections
   */
  async disconnect(): Promise<void> {
    console.log('🛑 Disconnecting Birdeye WebSocket connections...');
    this.isConnected = false;
    
    // Clear all ping intervals
    for (const [id, _] of this.connections) {
      this.clearPingInterval(id);
    }
    
    // Clear all reconnect timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    
    // Close all connections
    for (const [id, connInfo] of this.connections) {
      if (connInfo.connection?.connected) {
        connInfo.connection.close();
      }
    }
    
    this.connections.clear();
    console.log('✅ All connections closed');
    this.emit('disconnected');
  }

  /**
   * Get connection status
   */
  getStatus(): { [key: string]: string } {
    const status: { [key: string]: string } = {};
    
    for (const [id, connInfo] of this.connections) {
      status[`conn-${id}`] = connInfo.connection?.connected ? 'connected' : 'disconnected';
    }
    
    return status;
  }

  /**
   * Get subscription counts
   */
  getSubscriptionCounts(): { prices: number; wallets: number; tokens: number } {
    const pricesConn = this.connections.get('prices');
    const walletsConn = this.connections.get('wallets');
    
    return {
      prices: pricesConn?.subscriptions.size || 0,
      wallets: walletsConn?.subscriptions.size || 0,
      tokens: 0 // Combined with prices now
    };
  }
}