import { NextRequest, NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';

export async function GET(request: NextRequest) {
  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    const searchParams = request.nextUrl.searchParams;
    const userId = searchParams.get('userId');
    
    const sql = neon(databaseUrl);
    
    // Get daily P&L
    const dailyPnL = await sql`
      SELECT 
        COALESCE(SUM(pnl), 0) as daily_pnl,
        COUNT(*) as total_trades,
        COUNT(CASE WHEN pnl > 0 THEN 1 END) as winning_trades
      FROM trades
      WHERE user_id = ${userId || 'default'}
      AND DATE(executed_at) = CURRENT_DATE
    `;
    
    // Get open positions count
    const openPositions = await sql`
      SELECT COUNT(*) as count
      FROM positions
      WHERE user_id = ${userId || 'default'}
      AND status = 'OPEN'
    `;
    
    // Get all-time stats
    const allTimeStats = await sql`
      SELECT 
        COALESCE(SUM(pnl), 0) as total_pnl,
        COUNT(*) as total_trades,
        COUNT(CASE WHEN pnl > 0 THEN 1 END) as winning_trades,
        AVG(pnl_percent) as avg_pnl_percent
      FROM trades
      WHERE user_id = ${userId || 'default'}
    `;
    
    const winRate = allTimeStats[0].total_trades > 0 
      ? (allTimeStats[0].winning_trades / allTimeStats[0].total_trades) * 100 
      : 0;
    
    return NextResponse.json({
      dailyPnL: Number(dailyPnL[0].daily_pnl),
      dailyTrades: Number(dailyPnL[0].total_trades),
      openPositions: Number(openPositions[0].count),
      totalPnL: Number(allTimeStats[0].total_pnl),
      totalTrades: Number(allTimeStats[0].total_trades),
      winRate: winRate,
      avgPnLPercent: Number(allTimeStats[0].avg_pnl_percent) || 0
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    return NextResponse.json({ error: 'Failed to fetch statistics' }, { status: 500 });
  }
}