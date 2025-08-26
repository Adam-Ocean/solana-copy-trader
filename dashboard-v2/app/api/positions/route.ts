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
    const status = searchParams.get('status'); // 'open', 'closed', or 'all'
    
    const sql = neon(databaseUrl);
    
    // Build query based on status filter
    let query;
    if (status === 'open') {
      query = sql`
        SELECT * FROM positions
        WHERE user_id = ${userId || 'default'}
        AND status = 'OPEN'
        ORDER BY opened_at DESC
      `;
    } else if (status === 'closed') {
      query = sql`
        SELECT * FROM positions
        WHERE user_id = ${userId || 'default'}
        AND status = 'CLOSED'
        ORDER BY closed_at DESC
        LIMIT 100
      `;
    } else {
      query = sql`
        SELECT * FROM positions
        WHERE user_id = ${userId || 'default'}
        ORDER BY opened_at DESC
        LIMIT 200
      `;
    }
    
    const positions = await query;
    
    return NextResponse.json({ positions });
  } catch (error) {
    console.error('Error fetching positions:', error);
    return NextResponse.json({ error: 'Failed to fetch positions' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    const body = await request.json();
    const { positionId, currentPrice, pnl, pnlPercent } = body;

    const sql = neon(databaseUrl);
    
    // Update position
    await sql`
      UPDATE positions
      SET 
        current_price = ${currentPrice},
        pnl = ${pnl},
        pnl_percent = ${pnlPercent},
        updated_at = NOW()
      WHERE id = ${positionId}
    `;
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating position:', error);
    return NextResponse.json({ error: 'Failed to update position' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    const searchParams = request.nextUrl.searchParams;
    const positionId = searchParams.get('id');
    const exitPrice = searchParams.get('exitPrice');

    const sql = neon(databaseUrl);
    
    // Close position
    await sql`
      UPDATE positions
      SET 
        status = 'CLOSED',
        exit_price = ${exitPrice},
        closed_at = NOW()
      WHERE id = ${positionId}
    `;
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error closing position:', error);
    return NextResponse.json({ error: 'Failed to close position' }, { status: 500 });
  }
}