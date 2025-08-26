import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import EventEmitter from 'events';
import { URL } from 'url';
import { 
  WebSocketMessage, 
  DashboardCommand, 
  Position, 
  BotStatus,
  MarketData,
  DashboardConfig
} from '../types/enhanced';

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  userEmail?: string;
  isAuthenticated?: boolean;
}

export class DashboardWebSocketServerSecure extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private httpServer: any = null;
  private clients: Map<string, Set<AuthenticatedWebSocket>> = new Map(); // userId -> clients
  private port: number;
  private apiKey: string;
  
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

  constructor(port: number) {
    super();
    this.port = port;
    this.apiKey = process.env.WS_API_KEY || 'b4813ca87a0aeefed2eefc6305e96c1b9b91770f934ec1165a049a7b385449f3';
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      // Create HTTP server
      this.httpServer = createServer();
      
      // Create WebSocket server with authentication
      this.wss = new WebSocketServer({ 
        server: this.httpServer,
        verifyClient: (info, cb) => {
          // Parse URL to get auth parameters
          const url = new URL(info.req.url!, `http://${info.req.headers.host}`);
          const authToken = url.searchParams.get('auth');
          const userEmail = url.searchParams.get('email');
          
          // Simple authentication check
          // In production, verify the authToken with Stack Auth or your auth provider
          if (authToken && userEmail) {
            cb(true); // Accept connection
          } else {
            console.log('WebSocket connection rejected: Missing authentication');
            cb(false, 401, 'Unauthorized');
          }
        }
      });

      this.wss.on('connection', (ws: AuthenticatedWebSocket, req) => {
        // Parse authentication from URL
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const userId = url.searchParams.get('auth') || 'anonymous';
        const userEmail = url.searchParams.get('email') || '';
        
        // Store user info on the socket
        ws.userId = userId;
        ws.userEmail = userEmail;
        ws.isAuthenticated = true;
        
        // Add to user's client set
        if (!this.clients.has(userId)) {
          this.clients.set(userId, new Set());
        }
        this.clients.get(userId)!.add(ws);
        
        console.log(`Client connected: ${userEmail} (${userId})`);
        
        // Send initial state
        this.sendMessage(ws, {
          type: 'bot_status',
          data: this.botStatus
        });
        
        // Send current positions for this user
        const userPositions = Array.from(this.positions.values())
          .filter(p => p.userId === userId || !p.userId); // Filter by user or shared positions
        
        this.sendMessage(ws, {
          type: 'position_update',
          data: {
            type: 'snapshot',
            positions: userPositions
          }
        });

        // Handle messages
        ws.on('message', (message: Buffer) => {
          try {
            const command = JSON.parse(message.toString()) as DashboardCommand;
            this.handleCommand(ws, command);
          } catch (error) {
            console.error('Failed to parse WebSocket message:', error);
          }
        });

        ws.on('close', () => {
          // Remove from user's client set
          const userClients = this.clients.get(userId);
          if (userClients) {
            userClients.delete(ws);
            if (userClients.size === 0) {
              this.clients.delete(userId);
            }
          }
          console.log(`Client disconnected: ${userEmail}`);
        });

        ws.on('error', (error) => {
          console.error('WebSocket error:', error);
        });
      });

      // Start periodic broadcasts
      this.startBroadcasting();

      // Start HTTP server
      this.httpServer.listen(this.port, () => {
        console.log(`Dashboard WebSocket server running on port ${this.port} with authentication`);
        resolve();
      });
    });
  }

  private handleCommand(ws: AuthenticatedWebSocket, command: DashboardCommand): void {
    console.log('Received command:', command.type, 'from user:', ws.userEmail);
    
    // Emit command for the bot to handle
    this.emit('command', {
      ...command,
      userId: ws.userId,
      userEmail: ws.userEmail
    });
    
    // Handle specific commands
    switch (command.type) {
      case 'subscribe_chart':
        // Subscribe to chart updates for a token
        if (command.payload?.token) {
          this.emit('subscribe_chart', {
            token: command.payload.token,
            userId: ws.userId
          });
        }
        break;
        
      case 'unsubscribe_chart':
        // Unsubscribe from chart updates
        if (command.payload?.token) {
          this.emit('unsubscribe_chart', {
            token: command.payload.token,
            userId: ws.userId
          });
        }
        break;
    }
  }

  private sendMessage(ws: WebSocket, message: Omit<WebSocketMessage, 'timestamp'>): void {
    if (ws.readyState === WebSocket.OPEN) {
      const fullMessage: WebSocketMessage = {
        ...message,
        timestamp: Date.now()
      };
      ws.send(JSON.stringify(fullMessage));
    }
  }

  private broadcastToUser(userId: string, message: Omit<WebSocketMessage, 'timestamp'>): void {
    const userClients = this.clients.get(userId);
    if (userClients) {
      userClients.forEach(client => {
        this.sendMessage(client, message);
      });
    }
  }

  private broadcastToAll(message: Omit<WebSocketMessage, 'timestamp'>): void {
    this.clients.forEach(userClients => {
      userClients.forEach(client => {
        this.sendMessage(client, message);
      });
    });
  }

  private startBroadcasting(): void {
    // Broadcast stats every 5 seconds
    this.broadcastInterval = setInterval(() => {
      this.broadcastToAll({
        type: 'stats_update',
        data: {
          dailyPnL: this.botStatus.dailyPnL,
          totalPnL: this.botStatus.totalPnL,
          winRate: this.botStatus.winRate,
          openPositions: this.positions.size,
          totalPositions: this.botStatus.totalPositions
        }
      });
    }, 5000);
  }

  // Public methods for bot integration
  public updateBotStatus(status: Partial<BotStatus>): void {
    this.botStatus = { ...this.botStatus, ...status, lastUpdate: Date.now() };
    this.broadcastToAll({
      type: 'bot_status',
      data: this.botStatus
    });
  }

  public updatePosition(position: Position): void {
    this.positions.set(position.token, position);
    
    // Broadcast to the user who owns this position
    if (position.userId) {
      this.broadcastToUser(position.userId, {
        type: 'position_update',
        data: { position }
      });
    } else {
      // Broadcast to all if no specific user
      this.broadcastToAll({
        type: 'position_update',
        data: { position }
      });
    }
  }

  public removePosition(token: string, userId?: string): void {
    const position = this.positions.get(token);
    if (position) {
      this.positions.delete(token);
      
      const message: WebSocketMessage = {
        type: 'position_update',
        data: {
          type: 'closed',
          position
        },
        timestamp: Date.now()
      };
      
      if (userId || position.userId) {
        this.broadcastToUser(userId || position.userId!, message);
      } else {
        this.broadcastToAll(message);
      }
    }
  }

  public sendTraderTransaction(transaction: any, userId?: string): void {
    const message: WebSocketMessage = {
      type: 'trader_transaction',
      data: transaction,
      timestamp: Date.now()
    };
    
    if (userId) {
      this.broadcastToUser(userId, message);
    } else {
      this.broadcastToAll(message);
    }
  }

  public async stop(): Promise<void> {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
    }
    
    // Close all client connections
    this.clients.forEach(userClients => {
      userClients.forEach(client => {
        client.close();
      });
    });
    this.clients.clear();
    
    // Close servers
    if (this.wss) {
      this.wss.close();
    }
    if (this.httpServer) {
      this.httpServer.close();
    }
    
    console.log('Dashboard WebSocket server stopped');
  }
}