module.exports = {
  apps: [{
    name: 'copy-trader',
    script: './dist/EnhancedCopyTrader.js',
    instances: 1,
    exec_mode: 'cluster',
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production',
      PAPER_TRADING: 'true',
      ENABLE_DASHBOARD: 'true',
      DASHBOARD_PORT: '4791',
      WS_SERVER_PORT: '4791',
      LOG_LEVEL: 'info',
      YELLOWSTONE_GRPC: 'solana-yellowstone-grpc.publicnode.com:443',
      USE_YELLOWSTONE: 'true',
      TARGET_WALLET: 'GVJp1bkQgw3QdXBmvWRBK5SaXcr3kzf45SfrvRDobQQE'
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};