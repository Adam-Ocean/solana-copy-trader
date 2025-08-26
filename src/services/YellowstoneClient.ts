import { EventEmitter } from 'events';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';

export interface YellowstoneConfig {
  endpoint: string;
  targetWallet: string;
}

export class YellowstoneClient extends EventEmitter {
  private config: YellowstoneConfig;
  private client: any;
  private stream: any;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private isConnected = false;
  private lastPingTime: number = 0;
  private currentLatency: number = 0;

  constructor(config: YellowstoneConfig) {
    super();
    this.config = config;
    console.log(`🟡 Yellowstone client initialized for ${config.endpoint}`);
  }

  async connect(): Promise<void> {
    try {
      console.log(`🟡 Connecting to Yellowstone gRPC at ${this.config.endpoint}...`);
      
      // Load proto definition
      const protoPath = path.join(__dirname, '../../geyser.proto');
      const packageDefinition = protoLoader.loadSync(protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true
      });
      
      const geyserProto = grpc.loadPackageDefinition(packageDefinition) as any;
      
      // Create client with appropriate credentials
      const credentials = this.config.endpoint.includes(':443') 
        ? grpc.credentials.createSsl()
        : grpc.credentials.createInsecure();
        
      this.client = new geyserProto.geyser.Geyser(
        this.config.endpoint,
        credentials,
        {
          'grpc.max_receive_message_length': 4 * 1024 * 1024, // 4MB (conservative)
          'grpc.keepalive_time_ms': 30000, // 30 seconds (conservative - this worked!)
          'grpc.keepalive_timeout_ms': 5000,
          'grpc.keepalive_permit_without_calls': 1
        }
      );
      
      // Subscribe to updates
      this.subscribe();
      
    } catch (error: any) {
      console.error('❌ Yellowstone connection error:', error);
      this.emit('error', error);
      this.scheduleReconnect();
    }
  }

  private subscribe(): void {
    try {
      // Create dual subscription request - both transactions and accounts
      // This format works based on successful testing
      const subscribeRequest = {
        transactions: {
          "wallet_txs": {
            vote: false,
            failed: false,
            account_include: [this.config.targetWallet]
          }
        },
        accounts: {
          "wallet_account": {
            account: [this.config.targetWallet],
            filters: [],
            owner: []
          }
        },
        commitment: "processed"
      };
      
      console.log(`📡 Subscribing to Yellowstone for wallet: ${this.config.targetWallet}`);
      
      // Create bidirectional stream for Subscribe RPC with authentication token
      const metadata = new grpc.Metadata();
      const token = process.env.YELLOWSTONE_TOKEN || 'ecfb45c9c4c335fa4b18b26dc53dcbd0aaae144b07df75c0fb29d90ebe1e1237';
      metadata.add('x-token', token);
      
      this.stream = this.client.subscribe(metadata);
      console.log('🟡 Stream created, setting up handlers...');
      
      // Handle stream events - SIMPLIFIED to not break stream
      this.stream.on('data', (data: any) => {
        // Minimal logging to avoid stream interference
        if (data.update_oneof === 'transaction') {
          console.log('🔥 TRANSACTION DETECTED!', {
            slot: data.transaction?.slot,
            hasSignature: !!data.transaction?.transaction?.signature
          });
          // Only handle transaction data - don't process everything
          this.handleData(data);
        } else if (data.update_oneof === 'account') {
          console.log('📊 ACCOUNT UPDATE!', {
            slot: data.account?.slot
          });
          // Only handle account data
          this.handleData(data);
        }
        // Skip processing ping/pong and other messages to avoid stream interference
      });
      
      // Removed global stream reference to avoid interference
      
      // Handle metadata event (confirms subscription)
      this.stream.on('metadata', (metadata: any) => {
        console.log('🟡 Subscription metadata received, sending subscription...');
        
        // Send subscription AFTER metadata is received
        setTimeout(() => {
          console.log('📡 Bot subscription request:', JSON.stringify(subscribeRequest, null, 2));
          this.stream.write(subscribeRequest);
          console.log('🟡 Subscription request sent');
          
          // Mark as connected after subscription
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.emit('connected');
        }, 100);
      });
      
      this.stream.on('error', (error: any) => {
        console.error('❌ Yellowstone stream error:', error.message);
        this.isConnected = false;
        this.emit('error', error);
        // Reconnect on errors to prevent disconnection after signals
        this.scheduleReconnect();
      });
      
      this.stream.on('end', () => {
        console.log('🟡 Yellowstone stream ended - will reconnect');
        this.isConnected = false;
        this.scheduleReconnect();
      });
      
      this.stream.on('close', () => {
        console.log('🟡 Yellowstone stream closed');
      });
      
      this.stream.on('finish', () => {
        console.log('🟡 Yellowstone stream finished');
      });
      
      // Note: Subscription is sent in metadata handler above
      
      // Send periodic pings to keep connection alive
      const pingInterval = setInterval(() => {
        if (this.isConnected && this.stream) {
          const pingId = Date.now();
          this.lastPingTime = pingId;
          const pingRequest = {
            ping: { id: pingId }
          };
          this.stream.write(pingRequest);
        } else {
          clearInterval(pingInterval);
        }
      }, 5000);
      
      // Note: Connection status is set in metadata handler
      console.log('✅ Yellowstone stream initialized');
      
    } catch (error: any) {
      console.error('❌ Yellowstone subscription error:', error);
      this.emit('error', error);
      this.scheduleReconnect();
    }
  }

  private handleData(data: any): void {
    try {
      const timestamp = Date.now();
      
      // Check the update type using update_oneof field
      const updateType = data.update_oneof;
      
      // Handle ping from server - respond with pong
      if (updateType === 'ping' && data.ping) {
        if (this.stream) {
          this.stream.write({ pong: { id: data.ping.id || 1 } });
        }
        return;
      }
      
      // Handle pong responses
      if (updateType === 'pong' && data.pong) {
        // Calculate real latency from our ping
        if (this.lastPingTime && data.pong.id === this.lastPingTime) {
          this.currentLatency = Date.now() - this.lastPingTime;
          console.log(`🏓 Yellowstone latency: ${this.currentLatency}ms`);
        }
        return;
      }
      
      // Handle account updates
      if (updateType === 'account' && data.account) {
        const slot = data.account.slot;
        const pubkey = data.account.account?.pubkey;
        console.log(`🟡 [Yellowstone] Account update at slot ${slot}`);
        this.emit('signal', {
          type: 'account',
          timestamp,
          slot,
          data: data.account,
          latency: this.currentLatency > 0 ? `${this.currentLatency}ms` : '<measuring>'
        });
      }
      
      // Handle transaction updates - server-side filtered for our wallet
      if (updateType === 'transaction' && data.transaction) {
        const slot = data.transaction.slot;
        const signature = data.transaction.transaction?.signature;
        const sigHex = signature ? Buffer.from(signature).toString('hex').substring(0, 20) : 'unknown';
        
        console.log(`🎯 [Yellowstone] Target wallet transaction at slot ${slot}: ${sigHex}...`);
        console.log(`✅ [Yellowstone] Wallet ${this.config.targetWallet} transaction detected`);
        
        this.emit('signal', {
          type: 'transaction',
          timestamp,
          slot,
          signature: signature ? Buffer.from(signature).toString('base64') : undefined,
          data: data.transaction,
          latency: this.currentLatency > 0 ? `${this.currentLatency}ms` : '<measuring>'
        });
      }
      
      // Log other update types
      if (updateType && updateType !== 'ping' && updateType !== 'pong' && updateType !== 'account' && updateType !== 'transaction') {
        console.log(`🟡 [Yellowstone] Other update type: ${updateType}`);
      }
      
      // Emit test signal for monitoring
      this.emit('test_signal', {
        timestamp,
        type: updateType || 'unknown'
      });
      
    } catch (error) {
      console.error('Error handling Yellowstone data:', error);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ Max reconnection attempts reached');
      return;
    }
    
    this.reconnectAttempts++;
    const delay = Math.min(30000, 5000 * this.reconnectAttempts); // Max 30s delay
    
    console.log(`⏳ Scheduling Yellowstone reconnect in ${delay/1000}s...`);
    
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.stream) {
      this.stream.cancel();
      this.stream = null;
    }
    
    this.isConnected = false;
    console.log('🟡 Yellowstone client disconnected');
  }

  isReady(): boolean {
    return this.isConnected;
  }

  getLatency(): string {
    return this.currentLatency > 0 ? `${this.currentLatency}ms` : '<measuring>';
  }
}