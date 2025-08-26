import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { BirdeyeWebSocketService, BirdeyeConfig, PriceUpdate, WalletTransaction } from '../services/BirdeyeWebSocketService';

// Mock WebSocket
vi.mock('ws');

describe('BirdeyeWebSocketService', () => {
  let service: BirdeyeWebSocketService;
  let mockConfig: BirdeyeConfig;
  let mockWebSocket: any;

  beforeEach(() => {
    mockConfig = {
      apiKey: 'test-api-key',
      maxConnections: 5,
      reconnectDelay: 100,
      maxReconnectDelay: 1000,
      heartbeatInterval: 5000
    };

    // Setup mock WebSocket
    mockWebSocket = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
      ping: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn()
    };

    (WebSocket as any).mockImplementation(() => mockWebSocket);

    service = new BirdeyeWebSocketService(mockConfig);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Connection Management', () => {
    it('should initialize with correct configuration', () => {
      expect(service).toBeDefined();
      expect(service.getStatus()).toBeDefined();
    });

    it('should connect to WebSocket endpoints', async () => {
      // Simulate successful connection
      mockWebSocket.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'open') {
          setTimeout(() => handler(), 0);
        }
      });

      await service.connect();

      expect(WebSocket).toHaveBeenCalled();
      expect(mockWebSocket.on).toHaveBeenCalledWith('open', expect.any(Function));
      expect(mockWebSocket.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWebSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockWebSocket.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should handle connection errors', async () => {
      const error = new Error('Connection failed');
      mockWebSocket.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'error') {
          setTimeout(() => handler(error), 0);
        }
      });

      const errorHandler = vi.fn();
      service.on('error', errorHandler);

      await service.connect().catch(() => {});

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        error
      }));
    });

    it('should reconnect on disconnect with exponential backoff', async () => {
      vi.useFakeTimers();

      // First connect
      mockWebSocket.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'open') {
          setTimeout(() => handler(), 0);
        }
      });

      await service.connect();

      // Simulate disconnect
      const closeHandler = mockWebSocket.on.mock.calls.find(
        (call: any) => call[0] === 'close'
      )?.[1];

      closeHandler?.();

      // Should attempt reconnect after delay
      vi.advanceTimersByTime(100); // First reconnect delay

      expect(WebSocket).toHaveBeenCalledTimes(3); // Initial connections + reconnect attempt

      vi.useRealTimers();
    });

    it('should setup heartbeat on connection', async () => {
      vi.useFakeTimers();

      mockWebSocket.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'open') {
          handler();
        }
      });

      await service.connect();

      // Advance time to trigger heartbeat
      vi.advanceTimersByTime(5000);

      expect(mockWebSocket.ping).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('Price Subscriptions', () => {
    beforeEach(async () => {
      mockWebSocket.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'open') {
          handler();
        }
      });
      await service.connect();
    });

    it('should subscribe to price updates', async () => {
      const tokens = ['token1', 'token2', 'token3'];

      await service.subscribeToPrices(tokens);

      expect(mockWebSocket.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'SUBSCRIBE_PRICE',
          data: {
            tokens,
            chain: 'solana',
            currency: 'usd'
          }
        })
      );
    });

    it('should enforce price subscription limit', async () => {
      const tokens = new Array(501).fill(0).map((_, i) => `token${i}`);

      await expect(service.subscribeToPrices(tokens)).rejects.toThrow(
        'Cannot subscribe to 501 tokens (max 500)'
      );
    });

    it('should batch large price subscriptions', async () => {
      const tokens = new Array(250).fill(0).map((_, i) => `token${i}`);

      await service.subscribeToPrices(tokens);

      // Should be sent in 3 batches (100, 100, 50)
      expect(mockWebSocket.send).toHaveBeenCalledTimes(3);
    });

    it('should handle price updates', async () => {
      const priceUpdate: PriceUpdate = {
        token: 'token1',
        price: 1.23,
        timestamp: Date.now()
      };

      const promise = new Promise<void>((resolve) => {
        service.on('price-update', (data: PriceUpdate) => {
          expect(data).toEqual(priceUpdate);
          resolve();
        });
      });

      // Simulate incoming price message
      const messageHandler = mockWebSocket.on.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      messageHandler?.(Buffer.from(JSON.stringify({
        type: 'PRICE_UPDATE',
        data: priceUpdate
      })));

      await promise;
    });

    it('should cache price updates', async () => {
      const priceUpdate: PriceUpdate = {
        token: 'token1',
        price: 1.23,
        timestamp: Date.now()
      };

      // Simulate incoming price message
      const messageHandler = mockWebSocket.on.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      messageHandler?.(Buffer.from(JSON.stringify({
        type: 'PRICE_UPDATE',
        data: priceUpdate
      })));

      const cachedPrice = service.getCachedPrice('token1');
      expect(cachedPrice).toEqual(priceUpdate);
    });

    it('should unsubscribe from prices', async () => {
      const tokens = ['token1', 'token2'];

      await service.unsubscribeFromPrices(tokens);

      expect(mockWebSocket.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'UNSUBSCRIBE_PRICE',
          data: { tokens }
        })
      );
    });
  });

  describe('Wallet Monitoring', () => {
    beforeEach(async () => {
      mockWebSocket.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'open') {
          handler();
        }
      });
      await service.connect();
    });

    it('should subscribe to wallet transactions', async () => {
      const wallets = ['wallet1', 'wallet2'];

      await service.subscribeToWallets(wallets);

      expect(mockWebSocket.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'SUBSCRIBE_WALLET_TXS',
          data: {
            wallets,
            chain: 'solana',
            filters: undefined
          }
        })
      );
    });

    it('should enforce wallet subscription limit', async () => {
      const wallets = new Array(51).fill(0).map((_, i) => `wallet${i}`);

      await expect(service.subscribeToWallets(wallets)).rejects.toThrow(
        'Cannot subscribe to 51 wallets (max 50)'
      );
    });

    it('should handle wallet transactions', async () => {
      const walletTx: WalletTransaction = {
        wallet: 'wallet1',
        signature: 'sig123',
        type: 'swap',
        timestamp: Date.now(),
        slot: 123456,
        status: 'confirmed'
      };

      const promise = new Promise<void>((resolve) => {
        service.on('wallet-transaction', (data: WalletTransaction) => {
          expect(data).toEqual(walletTx);
          resolve();
        });
      });

      // Simulate incoming wallet transaction
      const messageHandler = mockWebSocket.on.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      messageHandler?.(Buffer.from(JSON.stringify({
        type: 'WALLET_TX',
        data: walletTx
      })));

      await promise;
    });

    it('should emit trade signals for swaps', async () => {
      const walletTx: WalletTransaction = {
        wallet: 'wallet1',
        signature: 'sig123',
        type: 'swap',
        timestamp: Date.now(),
        slot: 123456,
        status: 'confirmed',
        tokenIn: {
          address: 'SOL',
          symbol: 'SOL',
          amount: 10,
          decimals: 9
        },
        tokenOut: {
          address: 'token1',
          symbol: 'TOKEN',
          amount: 1000,
          decimals: 6
        }
      };

      const promise = new Promise<void>((resolve) => {
        service.on('trade-signal', (signal: any) => {
          expect(signal.wallet).toBe('wallet1');
          expect(signal.action).toBe('buy');
          expect(signal.token).toBe('token1');
          expect(signal.amount).toBe(10);
          resolve();
        });
      });

      // Simulate incoming wallet transaction
      const messageHandler = mockWebSocket.on.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      messageHandler?.(Buffer.from(JSON.stringify({
        type: 'WALLET_TX',
        data: walletTx
      })));

      await promise;
    });
  });

  describe('Subscription Restoration', () => {
    it('should restore price subscriptions after reconnect', async () => {
      mockWebSocket.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'open') {
          handler();
        }
      });

      await service.connect();

      // Subscribe to prices
      const tokens = ['token1', 'token2'];
      await service.subscribeToPrices(tokens);

      // Clear mock calls
      mockWebSocket.send.mockClear();

      // Simulate reconnection
      const openHandler = mockWebSocket.on.mock.calls.find(
        (call: any) => call[0] === 'open'
      )?.[1];

      openHandler?.();

      // Should restore subscriptions
      expect(mockWebSocket.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'SUBSCRIBE_PRICE',
          data: {
            tokens,
            chain: 'solana',
            currency: 'usd'
          }
        })
      );
    });
  });

  describe('Status and Metrics', () => {
    beforeEach(async () => {
      mockWebSocket.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'open') {
          handler();
        }
      });
      await service.connect();
    });

    it('should report connection status', () => {
      const status = service.getStatus();
      
      expect(status.prices).toBe('connected');
      expect(status.wallets).toBe('connected');
    });

    it('should track subscription counts', async () => {
      await service.subscribeToPrices(['token1', 'token2']);
      await service.subscribeToWallets(['wallet1']);

      const counts = service.getSubscriptionCounts();

      expect(counts.prices).toBe(2);
      expect(counts.wallets).toBe(1);
      expect(counts.tokens).toBe(0);
    });
  });

  describe('Disconnection', () => {
    it('should properly disconnect all connections', async () => {
      mockWebSocket.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'open') {
          handler();
        }
      });

      await service.connect();
      await service.disconnect();

      expect(mockWebSocket.close).toHaveBeenCalled();

      const counts = service.getSubscriptionCounts();
      expect(counts.prices).toBe(0);
      expect(counts.wallets).toBe(0);
      expect(counts.tokens).toBe(0);
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      mockWebSocket.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'open') {
          handler();
        }
      });
      await service.connect();
    });

    it('should handle error messages from server', async () => {
      const errorData = {
        code: 'INVALID_TOKEN',
        message: 'Token address is invalid'
      };

      const promise = new Promise<void>((resolve) => {
        service.on('subscription-error', (error: any) => {
          expect(error.error).toEqual(errorData);
          resolve();
        });
      });

      // Simulate error message
      const messageHandler = mockWebSocket.on.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      messageHandler?.(Buffer.from(JSON.stringify({
        type: 'ERROR',
        data: errorData
      })));

      await promise;
    });

    it('should handle malformed messages gracefully', () => {
      const messageHandler = mockWebSocket.on.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      // Should not throw
      expect(() => {
        messageHandler?.(Buffer.from('invalid json'));
      }).not.toThrow();
    });
  });
});