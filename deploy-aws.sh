#!/bin/bash

# AWS EC2 Deployment Script for Copy Trader Bot
# Usage: ./deploy-aws.sh <server-ip>

SERVER_IP=$1

if [ -z "$SERVER_IP" ]; then
  echo "Usage: ./deploy-aws.sh <server-ip>"
  echo "Example: ./deploy-aws.sh 107.22.92.147"
  exit 1
fi

echo "🚀 Deploying Copy Trader to AWS EC2: $SERVER_IP"

# Build the project locally first
echo "📦 Building project..."
npm run build

if [ $? -ne 0 ]; then
  echo "❌ Build failed. Please fix errors before deploying."
  exit 1
fi

# Create deployment package
echo "📦 Creating deployment package..."
tar -czf deploy.tar.gz \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=dashboard-v2 \
  --exclude=logs \
  --exclude=.env.local \
  dist src package.json package-lock.json .env ecosystem.config.js

echo "📤 Uploading to server..."
scp -i /Users/adam/Documents/GitHub/Gold-Finder/speed-bot-virginia.pem deploy.tar.gz ec2-user@$SERVER_IP:/home/ec2-user/

echo "🔧 Setting up on server..."
ssh -i /Users/adam/Documents/GitHub/Gold-Finder/speed-bot-virginia.pem ec2-user@$SERVER_IP << 'ENDSSH'
  # Stop existing service
  pm2 stop copy-trader 2>/dev/null || true
  pm2 delete copy-trader 2>/dev/null || true

  # Create app directory
  mkdir -p /home/ec2-user/copy-trader
  cd /home/ec2-user/copy-trader

  # Extract files
  tar -xzf /home/ec2-user/deploy.tar.gz
  rm /home/ec2-user/deploy.tar.gz

  # Install dependencies
  npm install --production

  # Install PM2 if not installed
  which pm2 > /dev/null || npm install -g pm2

  # Start with PM2
  pm2 start ecosystem.config.js --env production
  
  # Save PM2 configuration
  pm2 save
  pm2 startup | tail -n 1 | bash

  # Show status
  pm2 status
  
  echo "✅ Deployment complete!"
ENDSSH

# Cleanup local files
rm deploy.tar.gz

echo "✅ Deployment to $SERVER_IP complete!"
echo "🔍 Check status with: ssh -i /Users/adam/Documents/GitHub/Gold-Finder/speed-bot-virginia.pem ec2-user@$SERVER_IP 'pm2 status'"