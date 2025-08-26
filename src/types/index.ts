export interface Trade {
  type: 'buy' | 'sell';
  token: string;
  tokenSymbol?: string;
  amount: number;
  solAmount: number;
  price: number;
  timestamp: number;
  tx: string;
}

export interface Position {
  token: string;
  symbol: string;
  poolId?: string;
  entryPrice: number;
  entryTime: number;
  entryTx: string;
  amount: number; // @deprecated Use tokenAmount
  tokenAmount: number; // Total tokens held
  entryAmount: number; // Initial SOL invested
  solInvested: number; // Current SOL invested (reduced by partial exits)
  currentPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  realizedPnl?: number; // P&L from partial exits
  status: 'open' | 'partial' | 'closed';
  exitPrice?: number;
  exitTime?: number;
  exitTx?: string;
  partialExits?: Array<{
    percentage: number;
    tokensSold: number;
    solReduced: number;
    exitPrice: number;
    pnl: number;
    pnlPercent: number;
    timestamp: number;
    txHash: string;
  }>;
}

export interface WalletSignal {
  wallet: string;
  action: 'buy' | 'sell';
  token: string;
  tokenSymbol?: string;
  amount: number;
  solAmount: number;
  price: number;
  timestamp: number;
  signature: string;
}

export interface Config {
  targetWallet: string;
  positionSol: number;
  testMode: boolean;
  paperTrading: boolean;
  maxPositions: number;
  maxDailyLoss: number;
  slippageBps: number;
  minLiquidityUsd: number;
  executionDelayMs: number;
  maxEntryDelaySec: number;
}