#!/bin/bash

# Deployment script for Copy Trader Bot & Dashboard
# This script deploys the bot to EC2 and the dashboard to Vercel

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
EC2_HOST="107.22.92.147"
EC2_USER="ec2-user"
PEM_FILE="../speed-bot-virginia.pem"
REMOTE_DIR="~/copy-trader"

echo -e "${GREEN}🚀 Starting deployment...${NC}"

# Step 1: Build the bot
echo -e "${YELLOW}📦 Building bot...${NC}"
cd ../
npm run build

# Step 2: Deploy bot to EC2
echo -e "${YELLOW}🔄 Deploying bot to EC2...${NC}"
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude 'dashboard-v2' \
  --exclude '.env' \
  --exclude '.git' \
  --exclude 'test-results' \
  --exclude 'coverage' \
  -e "ssh -i $PEM_FILE" \
  ./dist ./src ./package.json ./package-lock.json \
  $EC2_USER@$EC2_HOST:$REMOTE_DIR/

# Step 3: Install dependencies and restart bot on EC2
echo -e "${YELLOW}🔧 Installing dependencies and restarting bot...${NC}"
ssh -i $PEM_FILE $EC2_USER@$EC2_HOST << 'ENDSSH'
  cd ~/copy-trader
  npm ci --production
  
  # Create PM2 ecosystem file if it doesn't exist
  if [ ! -f ecosystem.config.js ]; then
    cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'copy-trader',
    script: './dist/EnhancedCopyTrader.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 4789
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};
EOF
  fi
  
  # Restart with PM2
  pm2 reload ecosystem.config.js --update-env
  pm2 save
ENDSSH

# Step 4: Deploy dashboard to Vercel
echo -e "${YELLOW}🌐 Deploying dashboard to Vercel...${NC}"
cd dashboard-v2
vercel --prod

echo -e "${GREEN}✅ Deployment complete!${NC}"
echo ""
echo "Bot running at: $EC2_HOST:4789"
echo "Dashboard: Check Vercel output above"
echo ""
echo "To check bot logs: ssh -i $PEM_FILE $EC2_USER@$EC2_HOST 'pm2 logs copy-trader'"