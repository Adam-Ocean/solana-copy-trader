import { Position, WalletSignal } from '../types';
import dayjs from 'dayjs';

export class PositionManager {
  private positions: Map<string, Position> = new Map();
  private closedPositions: Position[] = [];
  private dailyPnL = 0;
  private dailyStartTime = Date.now();

  getPosition(token: string): Position | undefined {
    return this.positions.get(token);
  }

  getOpenPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  getClosedPositions(): Position[] {
    return this.closedPositions;
  }

  openPosition(signal: WalletSignal, txHash: string, solInvested: number): Position {
    const position: Position = {
      token: signal.token,
      symbol: signal.tokenSymbol || signal.token.substring(0, 8),
      entryPrice: signal.price,
      entryTime: signal.timestamp,
      entryTx: txHash,
      amount: signal.amount,
      solInvested,
      status: 'open',
      pnl: 0,
      pnlPercent: 0
    };

    this.positions.set(signal.token, position);
    
    console.log(`\n📊 Position Opened:`);
    console.log(`   Token: ${position.symbol}`);
    console.log(`   Entry: $${position.entryPrice}`);
    console.log(`   Size: ${solInvested} SOL`);
    console.log(`   Open positions: ${this.positions.size}`);
    
    return position;
  }

  closePosition(token: string, exitPrice: number, exitTx: string): Position | null {
    const position = this.positions.get(token);
    if (!position) return null;

    // Calculate P&L
    const priceChange = (exitPrice - position.entryPrice) / position.entryPrice;
    const exitValue = position.solInvested * (1 + priceChange);
    const pnl = exitValue - position.solInvested;
    const pnlPercent = (pnl / position.solInvested) * 100;

    // Update position
    position.status = 'closed';
    position.exitPrice = exitPrice;
    position.exitTime = Date.now() / 1000;
    position.exitTx = exitTx;
    position.pnl = pnl;
    position.pnlPercent = pnlPercent;

    // Move to closed positions
    this.positions.delete(token);
    this.closedPositions.push(position);
    this.dailyPnL += pnl;

    const emoji = pnl > 0 ? '✅' : '❌';
    console.log(`\n${emoji} Position Closed:`);
    console.log(`   Token: ${position.symbol}`);
    console.log(`   Entry: $${position.entryPrice.toFixed(8)}`);
    console.log(`   Exit: $${exitPrice.toFixed(8)}`);
    console.log(`   P&L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(4)} SOL (${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
    console.log(`   Hold time: ${((position.exitTime - position.entryTime) / 3600).toFixed(1)}h`);
    
    return position;
  }

  updatePrice(token: string, currentPrice: number): void {
    const position = this.positions.get(token);
    if (!position) return;

    position.currentPrice = currentPrice;
    
    // Calculate unrealized P&L
    const priceChange = (currentPrice - position.entryPrice) / position.entryPrice;
    const currentValue = position.solInvested * (1 + priceChange);
    position.pnl = currentValue - position.solInvested;
    position.pnlPercent = (position.pnl / position.solInvested) * 100;
  }

  getStatistics(): any {
    const openPositions = this.getOpenPositions();
    const totalInvested = openPositions.reduce((sum, p) => sum + p.solInvested, 0);
    const unrealizedPnL = openPositions.reduce((sum, p) => sum + (p.pnl || 0), 0);
    
    const allTrades = [...this.closedPositions];
    const wins = allTrades.filter(p => p.pnl && p.pnl > 0);
    const losses = allTrades.filter(p => p.pnl && p.pnl < 0);
    
    // Reset daily P&L if new day
    const now = Date.now();
    if (now - this.dailyStartTime > 86400000) {
      this.dailyPnL = 0;
      this.dailyStartTime = now;
    }

    return {
      openPositions: openPositions.length,
      totalInvested,
      unrealizedPnL,
      closedTrades: this.closedPositions.length,
      winRate: allTrades.length > 0 ? (wins.length / allTrades.length) * 100 : 0,
      totalWins: wins.length,
      totalLosses: losses.length,
      realizedPnL: this.closedPositions.reduce((sum, p) => sum + (p.pnl || 0), 0),
      dailyPnL: this.dailyPnL,
      avgWin: wins.length > 0 ? wins.reduce((sum, p) => sum + (p.pnl || 0), 0) / wins.length : 0,
      avgLoss: losses.length > 0 ? losses.reduce((sum, p) => sum + (p.pnl || 0), 0) / losses.length : 0
    };
  }

  isHoldingToken(token: string): boolean {
    const position = this.positions.get(token);
    return position !== undefined && position.status !== 'closed';
  }

  shouldTakeNewPosition(maxPositions: number, maxDailyLoss: number): boolean {
    // Check max positions
    if (this.positions.size >= maxPositions) {
      console.log(`⚠️ Max positions reached (${maxPositions})`);
      return false;
    }

    // Check daily loss limit
    const totalInvested = this.getOpenPositions().reduce((sum, p) => sum + p.solInvested, 0);
    if (totalInvested > 0 && this.dailyPnL / totalInvested < maxDailyLoss) {
      console.log(`⚠️ Daily loss limit reached (${(this.dailyPnL / totalInvested * 100).toFixed(1)}%)`);
      return false;
    }

    return true;
  }

  exportResults(): void {
    const stats = this.getStatistics();
    const timestamp = dayjs().format('YYYY-MM-DD_HHmmss');
    
    console.log('\n' + '='.repeat(50));
    console.log('📊 COPY TRADING RESULTS');
    console.log('='.repeat(50));
    console.log(`Time: ${timestamp}`);
    console.log(`\nPOSITIONS:`);
    console.log(`  Open: ${stats.openPositions}`);
    console.log(`  Closed: ${stats.closedTrades}`);
    console.log(`  Win Rate: ${stats.winRate.toFixed(1)}% (${stats.totalWins}W/${stats.totalLosses}L)`);
    
    console.log(`\nP&L:`);
    console.log(`  Realized: ${stats.realizedPnL > 0 ? '+' : ''}${stats.realizedPnL.toFixed(4)} SOL`);
    console.log(`  Unrealized: ${stats.unrealizedPnL > 0 ? '+' : ''}${stats.unrealizedPnL.toFixed(4)} SOL`);
    console.log(`  Daily: ${stats.dailyPnL > 0 ? '+' : ''}${stats.dailyPnL.toFixed(4)} SOL`);
    console.log(`  Avg Win: ${stats.avgWin.toFixed(4)} SOL`);
    console.log(`  Avg Loss: ${stats.avgLoss.toFixed(4)} SOL`);
    
    if (this.closedPositions.length > 0) {
      console.log(`\nRECENT CLOSED TRADES:`);
      this.closedPositions.slice(-5).forEach(p => {
        const emoji = p.pnl && p.pnl > 0 ? '✅' : '❌';
        console.log(`  ${emoji} ${p.symbol}: ${p.pnl?.toFixed(4)} SOL (${p.pnlPercent?.toFixed(1)}%)`);
      });
    }
    
    console.log('='.repeat(50));
  }
}