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
  amount: number;
  solInvested: number;
  currentPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  status: 'open' | 'closed';
  exitPrice?: number;
  exitTime?: number;
  exitTx?: string;
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