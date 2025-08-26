/**
 * Frontrun Dump Strategy
 * 
 * Logic: When dump wallet receives free tokens, it signals:
 * 1. Token is being pumped (has momentum)
 * 2. Dump is coming soon (2-6 hours typically)
 * 3. We can ride the wave IF we're fast
 */

import axios from 'axios';
import { EventEmitter } from 'events';

interface TokenTransfer {
  token: string;
  symbol: string;
  amount: number;
  from: string;
  timestamp: number;
  type: 'transfer' | 'buy' | 'sell';
}

interface PumpSignal {
  token: string;
  symbol: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  suggestedAction: 'buy' | 'avoid';
  riskLevel: number; // 1-10
  timeToExit: number; // estimated hours
}

export class FrontrunDumpStrategy extends EventEmitter {
  private readonly apiKey: string;
  private readonly dumpWallets: string[];
  private trackedTokens: Map<string, any> = new Map();
  private readonly PUMP_FUN_SUFFIX = 'pump';

  constructor(apiKey: string, dumpWallets: string[]) {
    super();
    this.apiKey = apiKey;
    this.dumpWallets = dumpWallets;
  }

  async analyzeFreeTokenReceipt(transfer: TokenTransfer): Promise<PumpSignal | null> {
    console.log(`\n🔍 Analyzing free token receipt: ${transfer.symbol}`);
    
    // Check if it's a pump.fun token
    const isPumpFun = transfer.token.includes(this.PUMP_FUN_SUFFIX);
    
    // Get token age and metrics
    const tokenMetrics = await this.getTokenMetrics(transfer.token);
    
    if (!tokenMetrics) {
      return {
        token: transfer.token,
        symbol: transfer.symbol,
        confidence: 'low',
        reason: 'Unable to fetch token metrics',
        suggestedAction: 'avoid',
        riskLevel: 10,
        timeToExit: 0
      };
    }

    // Analyze the signal strength
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let suggestedAction: 'buy' | 'avoid' = 'avoid';
    let riskLevel = 10;
    let timeToExit = 2; // Default 2 hours
    let reason = '';

    // Decision logic
    if (isPumpFun && tokenMetrics.ageMinutes < 60) {
      // Fresh pump.fun token - HIGH RISK but potential
      if (tokenMetrics.volume24h > 10 && tokenMetrics.holders > 50) {
        confidence = 'medium';
        suggestedAction = 'buy';
        riskLevel = 7;
        timeToExit = 1; // Exit within 1 hour
        reason = 'Fresh pump.fun with growing volume';
      } else {
        confidence = 'low';
        suggestedAction = 'avoid';
        reason = 'Fresh pump.fun but low activity';
      }
    } else if (tokenMetrics.priceChange1h > 50) {
      // Already pumping hard
      confidence = 'high';
      suggestedAction = 'buy';
      riskLevel = 8;
      timeToExit = 0.5; // Exit within 30 mins
      reason = 'Active pump in progress - QUICK EXIT NEEDED';
    } else if (tokenMetrics.volume24h > 50 && tokenMetrics.holders > 100) {
      // Established token with volume
      confidence = 'medium';
      suggestedAction = 'buy';
      riskLevel = 5;
      timeToExit = 3;
      reason = 'Established token with good volume';
    } else {
      // Default avoid
      confidence = 'low';
      suggestedAction = 'avoid';
      reason = 'Low volume or holder count';
    }

    const signal: PumpSignal = {
      token: transfer.token,
      symbol: transfer.symbol,
      confidence,
      reason,
      suggestedAction,
      riskLevel,
      timeToExit
    };

    // Emit signal
    this.emit('pumpSignal', signal);
    
    return signal;
  }

  private async getTokenMetrics(token: string): Promise<any> {
    try {
      const response = await axios.get(
        `https://data.solanatracker.io/tokens/${token}`,
        {
          headers: { 'x-api-key': this.apiKey },
          timeout: 5000
        }
      );

      const data = response.data;
      
      // Calculate age
      const createdAt = data.createdAt || data.timestamp || 0;
      const ageMinutes = (Date.now() / 1000 - createdAt) / 60;

      return {
        ageMinutes,
        volume24h: data.volume24h || 0,
        holders: data.holders || 0,
        priceChange1h: data.priceChange1h || 0,
        liquidity: data.liquidity || 0,
        marketCap: data.marketCap || 0
      };
    } catch (error) {
      return null;
    }
  }

  async monitorDumpWallets(): Promise<void> {
    console.log('👀 Monitoring dump wallets for free token transfers...\n');
    
    for (const wallet of this.dumpWallets) {
      await this.checkWalletTransfers(wallet);
    }
  }

  private async checkWalletTransfers(wallet: string): Promise<void> {
    try {
      // Get recent transactions
      const response = await axios.get(
        `https://data.solanatracker.io/wallet/${wallet}/transfers`,
        {
          headers: { 'x-api-key': this.apiKey },
          params: { limit: 20 },
          timeout: 5000
        }
      );

      const transfers = response.data || [];
      
      for (const transfer of transfers) {
        // Check if it's an incoming token transfer (not a buy)
        if (transfer.to === wallet && transfer.type === 'transfer') {
          await this.analyzeFreeTokenReceipt({
            token: transfer.token,
            symbol: transfer.symbol || 'Unknown',
            amount: transfer.amount,
            from: transfer.from,
            timestamp: transfer.timestamp,
            type: 'transfer'
          });
        }
      }
    } catch (error) {
      console.error(`Error checking wallet ${wallet}:`, error);
    }
  }
}

// Risk Management Rules
export class RiskManager {
  private readonly maxPositions = 3;
  private readonly maxRiskPerTrade = 0.1; // 0.1 SOL max
  private readonly stopLossPercent = 20; // Exit if down 20%
  private readonly takeProfitPercent = 50; // Take profit at 50%
  
  shouldTakeTrade(signal: PumpSignal, currentPositions: number): boolean {
    // Never take high risk trades
    if (signal.riskLevel > 8) {
      console.log('❌ Risk too high');
      return false;
    }
    
    // Don't exceed max positions
    if (currentPositions >= this.maxPositions) {
      console.log('❌ Max positions reached');
      return false;
    }
    
    // Only take medium-high confidence
    if (signal.confidence === 'low') {
      console.log('❌ Confidence too low');
      return false;
    }
    
    // Avoid if exit time is too short
    if (signal.timeToExit < 0.5) {
      console.log('⚠️ Very short exit window - be ready!');
    }
    
    return signal.suggestedAction === 'buy';
  }

  getPositionSize(signal: PumpSignal): number {
    // Scale position by confidence and risk
    if (signal.confidence === 'high' && signal.riskLevel < 6) {
      return 0.1; // Full size
    } else if (signal.confidence === 'medium') {
      return 0.05; // Half size
    } else {
      return 0.03; // Minimum size
    }
  }

  getExitStrategy(signal: PumpSignal): any {
    return {
      stopLoss: -this.stopLossPercent,
      takeProfit: this.takeProfitPercent,
      timeLimit: signal.timeToExit * 3600 * 1000, // Convert hours to ms
      trailingStop: signal.confidence === 'high' ? 10 : 15 // Tighter trail for high confidence
    };
  }
}