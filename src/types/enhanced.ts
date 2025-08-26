export interface PositionEntry {
  id: string;
  amount: number; // SOL amount
  tokenAmount: number; // Tokens received
  price: number; // Entry price per token
  tx: string;
  timestamp: number;
  isManual: boolean;
}

export interface Position {
  id: string;
  token: string;
  tokenSymbol?: string;
  tokenName?: string;
  poolId?: string;
  entries: PositionEntry[]; // Multiple buy entries
  entryPrice: number; // Average entry price
  currentPrice: number;
  entryAmount: number; // Total SOL invested
  tokenAmount: number; // Total tokens held
  initialTokenAmount: number; // Initial tokens purchased (for P&L calculation after partial exits)
  entryTx: string; // First entry tx
  entryTime: number; // First entry time
  traderEntryPrice?: number; // Trader's entry price for comparison
  slippage?: number; // Actual slippage from trader's price
  exitPrice?: number;
  exitAmount?: number;
  exitTx?: string;
  exitTime?: number;
  pnl?: number;
  pnlPercent?: number;
  status: 'open' | 'partial' | 'closed';
  isManual: boolean; // Track if position was manual or copy-trade
  partialExits?: PartialExit[];
  userId?: string; // User ID for multi-user support
  // Automated exit fields removed for copy-only strategy
}

export interface PartialExit {
  id: string;
  amount: number; // Tokens sold
  solReceived: number;
  price: number;
  tx: string;
  timestamp: number;
  percentage: number; // % of position exited
  reason: 'manual' | 'take_profit' | 'stop_loss' | 'copy_signal';
}

export interface WalletSignal {
  wallet: string;
  action: 'buy' | 'sell';
  token: string;
  tokenSymbol?: string;
  tokenName?: string;
  amount: number;
  solAmount: number;
  price: number;
  priceUsd?: number;
  timestamp: number;
  signature: string;
  poolId?: string;
  liquidity?: number;
  marketCap?: number;
  priceImpact?: number;
  traderTotalTokens?: number; // Trader's total position before this trade
  traderSoldTokens?: number; // Amount trader sold in this transaction
}

export interface DashboardConfig {
  partialExitEnabled: boolean;
  partialExitPercent: number[];
  maxPositions: number;
  positionSize: number;
  paperTrading: boolean;
  copyTrading: boolean;
  globalStop: boolean;
}

export interface BotStatus {
  isRunning: boolean;
  isPaused: boolean;
  mode: 'paper' | 'live';
  connectedWallets: string[];
  activePositions: number;
  totalPositions: number;
  dailyPnL: number;
  dailyPnLPercent?: number;
  totalPnL: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  solPrice?: number;
  lastUpdate: number;
}

export interface MarketData {
  token: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  marketCap: number;
  holders?: number;
  lastUpdate: number;
}

export interface TradeExecution {
  type: 'market' | 'limit';
  side: 'buy' | 'sell';
  token: string;
  amount: number; // SOL for buy, tokens for sell
  slippage: number;
  priorityFee?: number;
  useNextBlock: boolean;
  antiMEV: boolean;
  deadline?: number;
}

export interface NextBlockConfig {
  apiKey: string;
  endpoints: string[];
  useGRPC: boolean;
  antiMEV: boolean;
  priorityFee: number;
  tipWallets: string[];
  fastestEndpoint?: string;
}

export interface WebSocketMessage {
  type: 'position_update' | 'position_opened' | 'position_closed' | 'signal' | 'market_data' | 'bot_status' | 'trade_execution' | 'error' | 'config_update' | 'stats_update' | 
        'trader_transaction' | 'chart_subscribed' | 'chart_history' | 'price_update' | 'websocket_status' |
        'log_message' | 'bot_control_response' | 'system_status' | 'trade_history';
  data: any;
  timestamp: number;
}

export interface DashboardCommand {
  type: 'buy' | 'sell' | 'partial_exit' | 'close_position' | 'close_all' | 'pause' | 'resume' | 'update_config' | 'emergency_stop' |
        'subscribe_chart' | 'unsubscribe_chart' | 'get_chart_history' | 'subscribe_price' | 'unsubscribe_price' |
        'start_bot' | 'stop_bot' | 'restart_bot' | 'get_logs' | 'get_status' | 'set_trading_mode';
  payload: any;
  timestamp: number;
}

export interface BirdeyeWebSocketConfig {
  enabled: boolean;
  apiKey: string;
  maxConnections?: number;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  heartbeatInterval?: number;
  messageQueueSize?: number;
  useBirdeyeForWalletMonitoring?: boolean; // Use Birdeye instead of QuickNode for wallet monitoring
}