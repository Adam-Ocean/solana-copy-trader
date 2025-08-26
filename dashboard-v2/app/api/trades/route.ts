import { NextRequest, NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';

export async function GET(request: NextRequest) {
  try {
    // Get database URL from environment
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    // Get user ID from query params (in production, get from auth session)
    const searchParams = request.nextUrl.searchParams;
    const userId = searchParams.get('userId');
    
    // Connect to database
    const sql = neon(databaseUrl);
    
    // Fetch trades for user
    const trades = await sql`
      SELECT 
        id,
        token_address,
        token_symbol,
        action,
        entry_price,
        exit_price,
        amount_sol,
        token_amount,
        pnl,
        pnl_percent,
        status,
        executed_at,
        closed_at
      FROM trades
      WHERE user_id = ${userId || 'default'}
      ORDER BY executed_at DESC
      LIMIT 100
    `;
    
    return NextResponse.json({ trades });
  } catch (error) {
    console.error('Error fetching trades:', error);
    return NextResponse.json({ error: 'Failed to fetch trades' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    const body = await request.json();
    const { userId, tokenAddress, tokenSymbol, action, entryPrice, amountSol, tokenAmount } = body;

    const sql = neon(databaseUrl);
    
    // Insert new trade
    const result = await sql`
      INSERT INTO trades (
        user_id,
        token_address,
        token_symbol,
        action,
        entry_price,
        amount_sol,
        token_amount,
        status,
        executed_at
      ) VALUES (
        ${userId || 'default'},
        ${tokenAddress},
        ${tokenSymbol},
        ${action},
        ${entryPrice},
        ${amountSol},
        ${tokenAmount},
        'OPEN',
        NOW()
      )
      RETURNING id
    `;
    
    return NextResponse.json({ success: true, tradeId: result[0].id });
  } catch (error) {
    console.error('Error creating trade:', error);
    return NextResponse.json({ error: 'Failed to create trade' }, { status: 500 });
  }
}