# Complete Setup Guide for Enhanced Copy Trader

## Step 1: Install Dependencies

```bash
cd copy-trader
npm install
```

## Step 2: Configure Your .env File

Create a `.env` file from the example:
```bash
cp .env.example .env
```

Edit `.env` with your actual values:

```env
# Target wallet to copy trades from
TARGET_WALLET=GVJp1bkQgw3QdXBmvWRBK5SaXcr3kzf45SfrvRDobQQE

# Position size per trade
POSITION_SOL=0.5

# Solana Tracker API (get from solanatracker.io)
SOLANATRACKER_API_KEY=your-actual-api-key
WS_URL=wss://datastream.solanatracker.io/your-actual-url

# NextBlock Configuration (you provided this)
NEXT_BLOCK_API_KEY=trial1755950295-OhIQ5OB6n8K7quGlsr9W1C4fwjqOYe%2BDDX1ULtbBV9c%3D
NEXT_BLOCK_ENDPOINTS=fra.nextblock.io,ams.nextblock.io,nyc.nextblock.io
NEXT_BLOCK_USE_ANTI_MEV=true
NEXT_BLOCK_USE_GRPC=true

# Metis for quotes (we no longer use Jupiter v6)
METIS_URL=https://jupiter-swap-api.quiknode.pro/your-endpoint

# RPC endpoints
QUICKNODE_RPC=https://your-quicknode-endpoint.solana-mainnet.quiknode.pro/
PRIORITY_RPC=https://your-priority-rpc.com

# Trading mode
PAPER_TRADING=true  # Keep true for testing
TEST_MODE=false

# Risk Management
MAX_POSITIONS=20
MAX_DAILY_LOSS=-0.7
MAX_EXPOSURE_SOL=10
SLIPPAGE_BPS=200
MIN_LIQUIDITY_USD=5000

# Dashboard
DASHBOARD_PORT=3000
WS_SERVER_PORT=4790
DASHBOARD_UPDATE_MS=100

# For real trading (keep empty for paper trading)
WALLET_SECRET_KEY=
```

## Step 3: Run the Bot

### Paper Trading Mode (Recommended)

In one terminal, start the bot:
```bash
npm run paper
```

In another terminal (optional), start the dashboard server:
```bash
npm run dashboard
```

Open your browser to: **http://localhost:3000**

## Step 4: Using the Dashboard

### Main Interface
- **Left Panel**: Shows all open positions with real-time P&L
- **Center**: Price chart (when a position is selected)
- **Right Panel**: Trading controls and settings
- **Header**: Bot status and overall statistics

### Manual Trading
1. Enter a token address in the input field
2. Set the amount (default 0.5 SOL)
3. Click BUY to open a position
4. Click on a position to select it
5. Use partial exit buttons (25%, 50%) or CLOSE

### Settings
- **Copy Trading**: Toggle to enable/disable copying the target wallet
- **Auto Exit**: Enable automatic stop loss and take profit
- **Trailing Stop**: Enable dynamic stop loss that follows price
- **Partial Exits**: Enable automatic partial profit taking

### Emergency Controls
- **CLOSE ALL**: Closes all open positions
- **EMERGENCY STOP**: Closes all positions and stops the bot

## Step 5: Monitor Performance

The bot will show:
- Real-time P&L for each position
- Daily P&L summary
- Win rate percentage
- Number of open positions
- Total trading volume

## Testing with Target Wallet

The wallet `GVJp1bkQgw3QdXBmvWRBK5SaXcr3kzf45SfrvRDobQQE` is already configured. 
When you run the bot, it will:
1. Monitor all trades from this wallet
2. Simulate copying with 0.5 SOL positions
3. Show results in real-time on the dashboard
4. Track P&L without using real funds

## Switching to Live Trading

**⚠️ WARNING: Only do this after extensive paper trading**

1. Set `PAPER_TRADING=false` in `.env`
2. Add your wallet secret key to `WALLET_SECRET_KEY`
3. Ensure you have SOL in your wallet
4. Start with small position sizes
5. Monitor closely using the dashboard

## Troubleshooting

### Bot won't start
- Check all required API keys are in `.env`
- Verify RPC endpoints are working
- Look for error messages in console

### WebSocket disconnected
- Verify SOLANATRACKER_API_KEY is correct
- Check WS_URL format
- Ensure you have Premium/Business plan

### Dashboard not connecting
- Make sure bot is running first
- Check ports 3000 and 4790 are free
- Try refreshing the browser

### No trades executing
- Verify target wallet is making trades
- Check liquidity thresholds
- Review position limits

## Support Commands

Check bot status:
```bash
# See if processes are running
ps aux | grep "EnhancedCopyTrader"

# Check port usage
lsof -i :3000
lsof -i :4790

# View real-time logs
# The bot outputs logs directly to console
```

## Next Steps

1. **Test in Paper Mode**: Run for at least 24 hours
2. **Adjust Settings**: Fine-tune position size and risk parameters
3. **Monitor Performance**: Track win rate and daily P&L
4. **Add More Wallets**: Monitor multiple wallets (modify the code)
5. **Go Live**: Only after successful paper trading

## Important Notes

- The bot will automatically test NextBlock endpoints to find the fastest one
- Positions are tracked even if you restart the bot (in-memory)
- The dashboard updates in real-time via WebSocket
- All trades in paper mode are simulated
- Emergency stop will close all positions immediately

Good luck with your copy trading!