# Solana Copy Trader Bot

Ultra-low latency Solana copy trading bot using Yellowstone gRPC for sub-5ms transaction monitoring.

## Features

- **Ultra-Low Latency**: Direct Yellowstone gRPC connection to Solana validator for <5ms detection
- **Comprehensive DEX Support**: 24+ DEX programs including Jupiter, Raydium, Orca, Pump.fun, PAMM
- **Smart Position Management**: Automatic risk management with configurable position sizing
- **Real-time Dashboard**: Web interface for monitoring trades and performance
- **Paper Trading Mode**: Test strategies without real capital

## Tech Stack

- **TypeScript/Node.js**: Core bot architecture
- **Yellowstone gRPC**: Direct validator connection for ultra-fast transaction monitoring
- **Solana Web3.js**: Blockchain interaction
- **React Dashboard**: Real-time monitoring interface
- **PM2**: Process management and auto-restart

## Requirements

- Node.js 18+
- Solana validator with Yellowstone Geyser plugin (v8.1.0)
- QuickNode RPC endpoint for transaction execution

## Installation

```bash
npm install
```

## Configuration

Create `.env` file with:
```
QUICKNODE_RPC=your_quicknode_endpoint
TARGET_WALLET=wallet_to_monitor
YELLOWSTONE_ENDPOINT=your_yellowstone_endpoint
```

## Running

```bash
# Start the bot
npm start

# View dashboard
npm run dashboard
```

## Architecture

- **YellowstoneClient**: Manages gRPC connection with conservative keepalive settings
- **YellowstoneWalletMonitor**: Processes transactions and emits trading signals
- **EnhancedCopyTrader**: Executes trades based on signals
- **Dashboard**: Real-time monitoring and control interface

## Performance

- Transaction detection: <5ms from block production
- Processing latency: ~10-20ms
- Execution speed: Limited only by RPC response time