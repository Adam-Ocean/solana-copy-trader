import { neon } from '@neondatabase/serverless';
import { EventEmitter } from 'events';

export interface Trade {
  id?: number;
  wallet_address: string;
  token_address: string;
  token_symbol?: string;
  action: 'BUY' | 'SELL' | 'PARTIAL_EXIT';
  entry_price?: number;
  exit_price?: number;
  amount_sol: number;
  token_amount?: number;
  pnl?: number;
  pnl_percent?: number;
  status: 'OPEN' | 'PARTIAL' | 'CLOSED';
  executed_at: Date;
  closed_at?: Date;
  metadata?: any;
}

export interface Position {
  id?: number;
  wallet_address: string;
  token_address: string;
  token_symbol?: string;
  entry_price: number;
  current_price?: number;
  amount_sol: number;
  remaining_sol: number;
  token_amount: number;
  remaining_tokens: number;
  peak_price?: number;
  trail_percent?: number;
  pnl?: number;
  pnl_percent?: number;
  status: 'OPEN' | 'PARTIAL' | 'CLOSED';
  opened_at: Date;
  updated_at: Date;
  closed_at?: Date;
}

export class DatabaseService extends EventEmitter {
  private sql: any;
  private initialized = false;

  constructor() {
    super();
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.warn('⚠️ DATABASE_URL not set - trades will not be persisted');
      return;
    }
    
    this.sql = neon(databaseUrl);
    this.initializeDatabase();
  }

  async initialize() {
    await this.initializeDatabase();
  }

  private async initializeDatabase() {
    try {
      // Create trades table
      await this.sql`
        CREATE TABLE IF NOT EXISTS trades (
          id SERIAL PRIMARY KEY,
          wallet_address VARCHAR(44) NOT NULL,
          token_address VARCHAR(44) NOT NULL,
          token_symbol VARCHAR(20),
          action VARCHAR(20) NOT NULL,
          entry_price DECIMAL(20, 10),
          exit_price DECIMAL(20, 10),
          amount_sol DECIMAL(20, 10) NOT NULL,
          token_amount DECIMAL(20, 10),
          pnl DECIMAL(20, 10),
          pnl_percent DECIMAL(10, 2),
          status VARCHAR(20) NOT NULL,
          executed_at TIMESTAMP NOT NULL DEFAULT NOW(),
          closed_at TIMESTAMP,
          metadata JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `;

      // Create bot_state table
      await this.sql`
        CREATE TABLE IF NOT EXISTS bot_state (
          id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          is_paused BOOLEAN DEFAULT FALSE,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `;

      // Create positions table
      await this.sql`
        CREATE TABLE IF NOT EXISTS positions (
          id SERIAL PRIMARY KEY,
          wallet_address VARCHAR(44) NOT NULL,
          token_address VARCHAR(44) NOT NULL UNIQUE,
          token_symbol VARCHAR(20),
          entry_price DECIMAL(20, 10) NOT NULL,
          current_price DECIMAL(20, 10),
          amount_sol DECIMAL(20, 10) NOT NULL,
          remaining_sol DECIMAL(20, 10) NOT NULL,
          token_amount DECIMAL(20, 10) NOT NULL,
          remaining_tokens DECIMAL(20, 10) NOT NULL,
          peak_price DECIMAL(20, 10),
          trail_percent DECIMAL(10, 2),
          pnl DECIMAL(20, 10),
          pnl_percent DECIMAL(10, 2),
          status VARCHAR(20) NOT NULL,
          opened_at TIMESTAMP NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
          closed_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `;

      // Create indexes
      await this.sql`
        CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet_address);
      `;
      
      await this.sql`
        CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_address);
      `;
      
      await this.sql`
        CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
      `;
      
      await this.sql`
        CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_address);
      `;
      
      await this.sql`
        CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      `;

      this.initialized = true;
      console.log('✅ Database initialized successfully');
    } catch (error) {
      console.error('❌ Database initialization error:', error);
      this.emit('error', error);
    }
  }

  // Trade methods
  async saveTrade(trade: Trade): Promise<Trade | null> {
    if (!this.initialized) return null;

    try {
      const result = await this.sql`
        INSERT INTO trades (
          wallet_address, token_address, token_symbol, action,
          entry_price, exit_price, amount_sol, token_amount,
          pnl, pnl_percent, status, executed_at, closed_at, metadata
        ) VALUES (
          ${trade.wallet_address}, ${trade.token_address}, ${trade.token_symbol}, ${trade.action},
          ${trade.entry_price}, ${trade.exit_price}, ${trade.amount_sol}, ${trade.token_amount},
          ${trade.pnl}, ${trade.pnl_percent}, ${trade.status}, ${trade.executed_at}, 
          ${trade.closed_at}, ${JSON.stringify(trade.metadata)}
        )
        RETURNING *
      `;
      
      return result[0];
    } catch (error) {
      console.error('Error saving trade:', error);
      this.emit('error', error);
      return null;
    }
  }

  async getTrades(wallet?: string, limit = 100): Promise<Trade[]> {
    if (!this.initialized) return [];

    try {
      let query;
      if (wallet) {
        query = this.sql`
          SELECT * FROM trades 
          WHERE wallet_address = ${wallet}
          ORDER BY executed_at DESC
          LIMIT ${limit}
        `;
      } else {
        query = this.sql`
          SELECT * FROM trades 
          ORDER BY executed_at DESC
          LIMIT ${limit}
        `;
      }
      
      return await query;
    } catch (error) {
      console.error('Error getting trades:', error);
      this.emit('error', error);
      return [];
    }
  }

  async getTradesByToken(tokenAddress: string): Promise<Trade[]> {
    if (!this.initialized) return [];

    try {
      return await this.sql`
        SELECT * FROM trades 
        WHERE token_address = ${tokenAddress}
        ORDER BY executed_at DESC
      `;
    } catch (error) {
      console.error('Error getting trades by token:', error);
      this.emit('error', error);
      return [];
    }
  }

  // Position methods
  async savePosition(position: Position): Promise<Position | null> {
    if (!this.initialized) return null;

    try {
      const result = await this.sql`
        INSERT INTO positions (
          wallet_address, token_address, token_symbol,
          entry_price, current_price, amount_sol, remaining_sol,
          token_amount, remaining_tokens, peak_price, trail_percent,
          pnl, pnl_percent, status, opened_at, updated_at, closed_at
        ) VALUES (
          ${position.wallet_address}, ${position.token_address}, ${position.token_symbol},
          ${position.entry_price}, ${position.current_price}, ${position.amount_sol}, 
          ${position.remaining_sol}, ${position.token_amount}, ${position.remaining_tokens}, 
          ${position.peak_price}, ${position.trail_percent}, ${position.pnl}, 
          ${position.pnl_percent}, ${position.status}, ${position.opened_at}, 
          ${position.updated_at}, ${position.closed_at}
        )
        ON CONFLICT (token_address) 
        DO UPDATE SET
          current_price = EXCLUDED.current_price,
          remaining_sol = EXCLUDED.remaining_sol,
          remaining_tokens = EXCLUDED.remaining_tokens,
          peak_price = EXCLUDED.peak_price,
          trail_percent = EXCLUDED.trail_percent,
          pnl = EXCLUDED.pnl,
          pnl_percent = EXCLUDED.pnl_percent,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at,
          closed_at = EXCLUDED.closed_at
        RETURNING *
      `;
      
      return result[0];
    } catch (error) {
      console.error('Error saving position:', error);
      this.emit('error', error);
      return null;
    }
  }

  async getOpenPositions(wallet?: string): Promise<Position[]> {
    if (!this.initialized) return [];

    try {
      let query;
      if (wallet) {
        query = this.sql`
          SELECT * FROM positions 
          WHERE wallet_address = ${wallet} AND status IN ('OPEN', 'PARTIAL')
          ORDER BY opened_at DESC
        `;
      } else {
        query = this.sql`
          SELECT * FROM positions 
          WHERE status IN ('OPEN', 'PARTIAL')
          ORDER BY opened_at DESC
        `;
      }
      
      return await query;
    } catch (error) {
      console.error('Error getting open positions:', error);
      this.emit('error', error);
      return [];
    }
  }

  async getPositionByToken(tokenAddress: string): Promise<Position | null> {
    if (!this.initialized) return null;

    try {
      const result = await this.sql`
        SELECT * FROM positions 
        WHERE token_address = ${tokenAddress}
        LIMIT 1
      `;
      
      return result[0] || null;
    } catch (error) {
      console.error('Error getting position by token:', error);
      this.emit('error', error);
      return null;
    }
  }

  async updatePosition(tokenAddress: string, updates: Partial<Position>): Promise<Position | null> {
    if (!this.initialized) return null;

    try {
      const result = await this.sql`
        UPDATE positions 
        SET 
          current_price = COALESCE(${updates.current_price}, current_price),
          remaining_sol = COALESCE(${updates.remaining_sol}, remaining_sol),
          remaining_tokens = COALESCE(${updates.remaining_tokens}, remaining_tokens),
          peak_price = COALESCE(${updates.peak_price}, peak_price),
          trail_percent = COALESCE(${updates.trail_percent}, trail_percent),
          pnl = COALESCE(${updates.pnl}, pnl),
          pnl_percent = COALESCE(${updates.pnl_percent}, pnl_percent),
          status = COALESCE(${updates.status}, status),
          closed_at = COALESCE(${updates.closed_at}, closed_at),
          updated_at = NOW()
        WHERE token_address = ${tokenAddress}
        RETURNING *
      `;
      
      return result[0] || null;
    } catch (error) {
      console.error('Error updating position:', error);
      this.emit('error', error);
      return null;
    }
  }

  // Statistics methods
  async getDailyStats(wallet?: string): Promise<any> {
    if (!this.initialized) return null;

    try {
      const query = wallet 
        ? this.sql`
            SELECT 
              COUNT(*) as total_trades,
              SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
              SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losing_trades,
              SUM(pnl) as total_pnl,
              AVG(pnl_percent) as avg_pnl_percent
            FROM trades 
            WHERE wallet_address = ${wallet}
              AND executed_at >= CURRENT_DATE
          `
        : this.sql`
            SELECT 
              COUNT(*) as total_trades,
              SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
              SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losing_trades,
              SUM(pnl) as total_pnl,
              AVG(pnl_percent) as avg_pnl_percent
            FROM trades 
            WHERE executed_at >= CURRENT_DATE
          `;
      
      const result = await query;
      return result[0];
    } catch (error) {
      console.error('Error getting daily stats:', error);
      this.emit('error', error);
      return null;
    }
  }

  async saveBotState(isPaused: boolean): Promise<void> {
    try {
      await this.sql`
        INSERT INTO bot_state (id, is_paused, updated_at)
        VALUES (1, ${isPaused}, ${new Date()})
        ON CONFLICT (id)
        DO UPDATE SET is_paused = ${isPaused}, updated_at = ${new Date()}
      `;
    } catch (error) {
      console.error('Error saving bot state:', error);
    }
  }

  async getBotState(): Promise<{ isPaused: boolean } | null> {
    try {
      const result = await this.sql`
        SELECT is_paused FROM bot_state WHERE id = 1
      `;
      return result.length > 0 ? { isPaused: result[0].is_paused } : null;
    } catch (error) {
      console.error('Error getting bot state:', error);
      return null;
    }
  }

  async getRecentTrades(limit: number = 100): Promise<Trade[]> {
    try {
      const trades = await this.sql`
        SELECT * FROM trades
        ORDER BY executed_at DESC
        LIMIT ${limit}
      `;
      return trades;
    } catch (error) {
      console.error('Error getting recent trades:', error);
      return [];
    }
  }

  async cleanup(): Promise<void> {
    // Neon handles connection pooling automatically
    console.log('Database service cleanup complete');
  }
}