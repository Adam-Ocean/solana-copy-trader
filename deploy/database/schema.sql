-- Neon Database Schema for Copy Trader with Stack Auth
-- Run this in your Neon SQL Editor

-- Create users table (managed by Stack Auth)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  avatar_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create positions table
CREATE TABLE IF NOT EXISTS positions (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL DEFAULT 'default',
  token_address VARCHAR(100) NOT NULL,
  token_symbol VARCHAR(50),
  pool_id VARCHAR(100),
  entry_price DECIMAL(20, 8) NOT NULL,
  current_price DECIMAL(20, 8),
  exit_price DECIMAL(20, 8),
  amount_sol DECIMAL(20, 8) NOT NULL,
  remaining_sol DECIMAL(20, 8),
  token_amount DECIMAL(20, 8) NOT NULL,
  remaining_tokens DECIMAL(20, 8),
  peak_price DECIMAL(20, 8),
  trail_percent DECIMAL(10, 2),
  pnl DECIMAL(20, 8),
  pnl_percent DECIMAL(10, 2),
  status VARCHAR(20) DEFAULT 'OPEN',
  opened_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP,
  metadata JSONB,
  CONSTRAINT positions_status_check CHECK (status IN ('OPEN', 'PARTIAL', 'CLOSED'))
);

-- Create trades table
CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL DEFAULT 'default',
  position_id INTEGER REFERENCES positions(id),
  wallet_address VARCHAR(100),
  token_address VARCHAR(100) NOT NULL,
  token_symbol VARCHAR(50),
  action VARCHAR(20) NOT NULL,
  entry_price DECIMAL(20, 8),
  exit_price DECIMAL(20, 8),
  amount_sol DECIMAL(20, 8) NOT NULL,
  token_amount DECIMAL(20, 8),
  pnl DECIMAL(20, 8),
  pnl_percent DECIMAL(10, 2),
  status VARCHAR(20) DEFAULT 'OPEN',
  executed_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP,
  tx_hash VARCHAR(200),
  metadata JSONB,
  CONSTRAINT trades_action_check CHECK (action IN ('BUY', 'SELL', 'PARTIAL_EXIT')),
  CONSTRAINT trades_status_check CHECK (status IN ('OPEN', 'PARTIAL', 'CLOSED'))
);

-- Create partial_exits table
CREATE TABLE IF NOT EXISTS partial_exits (
  id SERIAL PRIMARY KEY,
  position_id INTEGER REFERENCES positions(id) ON DELETE CASCADE,
  amount DECIMAL(20, 8) NOT NULL,
  sol_received DECIMAL(20, 8) NOT NULL,
  price DECIMAL(20, 8) NOT NULL,
  percentage DECIMAL(10, 2) NOT NULL,
  reason VARCHAR(100),
  tx_hash VARCHAR(200),
  executed_at TIMESTAMP DEFAULT NOW()
);

-- Create trader_transactions table (for monitoring)
CREATE TABLE IF NOT EXISTS trader_transactions (
  id SERIAL PRIMARY KEY,
  trader_wallet VARCHAR(100) NOT NULL,
  type VARCHAR(10) NOT NULL,
  token_address VARCHAR(100) NOT NULL,
  token_symbol VARCHAR(50),
  amount DECIMAL(20, 8) NOT NULL,
  price DECIMAL(20, 8) NOT NULL,
  tx_hash VARCHAR(200),
  timestamp TIMESTAMP DEFAULT NOW(),
  CONSTRAINT trader_tx_type_check CHECK (type IN ('BUY', 'SELL'))
);

-- Create indexes for performance
CREATE INDEX idx_positions_user_status ON positions(user_id, status);
CREATE INDEX idx_positions_token ON positions(token_address);
CREATE INDEX idx_positions_opened_at ON positions(opened_at DESC);

CREATE INDEX idx_trades_user ON trades(user_id);
CREATE INDEX idx_trades_position ON trades(position_id);
CREATE INDEX idx_trades_executed_at ON trades(executed_at DESC);
CREATE INDEX idx_trades_status ON trades(status);

CREATE INDEX idx_partial_exits_position ON partial_exits(position_id);
CREATE INDEX idx_trader_tx_wallet ON trader_transactions(trader_wallet);
CREATE INDEX idx_trader_tx_timestamp ON trader_transactions(timestamp DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE partial_exits ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
-- Users can only see their own positions
CREATE POLICY positions_policy ON positions
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true)::text OR current_setting('app.current_user_id', true) IS NULL);

-- Users can only see their own trades
CREATE POLICY trades_policy ON trades
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true)::text OR current_setting('app.current_user_id', true) IS NULL);

-- Users can only see partial exits for their positions
CREATE POLICY partial_exits_policy ON partial_exits
  FOR ALL
  USING (
    position_id IN (
      SELECT id FROM positions 
      WHERE user_id = current_setting('app.current_user_id', true)::text
    ) OR current_setting('app.current_user_id', true) IS NULL
  );

-- Create functions for statistics
CREATE OR REPLACE FUNCTION get_user_stats(p_user_id VARCHAR)
RETURNS TABLE (
  daily_pnl DECIMAL,
  total_pnl DECIMAL,
  win_rate DECIMAL,
  open_positions INTEGER,
  total_trades INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COALESCE(SUM(CASE WHEN DATE(t.executed_at) = CURRENT_DATE THEN t.pnl ELSE 0 END), 0) as daily_pnl,
    COALESCE(SUM(t.pnl), 0) as total_pnl,
    CASE 
      WHEN COUNT(t.*) > 0 THEN 
        (COUNT(CASE WHEN t.pnl > 0 THEN 1 END)::DECIMAL / COUNT(t.*)::DECIMAL) * 100
      ELSE 0 
    END as win_rate,
    (SELECT COUNT(*)::INTEGER FROM positions WHERE user_id = p_user_id AND status = 'OPEN') as open_positions,
    COUNT(t.*)::INTEGER as total_trades
  FROM trades t
  WHERE t.user_id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_positions_updated_at BEFORE UPDATE ON positions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Sample data for testing (optional)
-- INSERT INTO positions (user_id, token_address, token_symbol, entry_price, amount_sol, token_amount, status)
-- VALUES ('default', 'TokenAddr123', 'TEST', 0.0001, 0.5, 5000, 'OPEN');