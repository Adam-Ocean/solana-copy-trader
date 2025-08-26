import { EventEmitter } from 'events';
import { YellowstoneClient } from './YellowstoneClient';

export interface YellowstoneTransaction {
  signature: string;
  slot: number;
  transaction: any;
  meta: any;
}

export class YellowstoneMonitor extends EventEmitter {
  private client: YellowstoneClient;
  private targetWallet: string;
  private isConnected: boolean = false;

  constructor(grpcUrl: string, targetWallet: string) {
    super();
    this.targetWallet = targetWallet;
    
    // Use the new Yellowstone client
    this.client = new YellowstoneClient({
      endpoint: grpcUrl,
      targetWallet: targetWallet
    });
    
    // Forward events
    this.client.on('connected', () => {
      this.isConnected = true;
      this.emit('connected');
    });
    
    this.client.on('error', (error) => {
      this.emit('error', error);
    });
    
    this.client.on('test_signal', (signal) => {
      console.log('📡 Yellowstone test signal:', signal);
    });
    
    console.log(`🟡 Yellowstone monitor initialized for ${grpcUrl}`);
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
    } catch (error) {
      console.error('❌ Yellowstone connection error:', error);
      this.isConnected = false;
      this.emit('error', error);
    }
  }

  async subscribeToWallet(): Promise<void> {
    if (!this.isConnected) {
      console.log('⚠️ Yellowstone not connected, using fallback');
      return;
    }
    
    // Subscription logic will be implemented once node is synced
    console.log(`📡 Yellowstone will monitor: ${this.targetWallet}`);
  }

  async close(): Promise<void> {
    await this.client.disconnect();
    this.isConnected = false;
    console.log('🟡 Yellowstone connection closed');
  }

  isReady(): boolean {
    return this.isConnected;
  }
}
