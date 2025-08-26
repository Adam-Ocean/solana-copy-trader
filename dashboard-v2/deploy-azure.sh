#!/bin/bash

# Azure server details
SERVER="20.9.141.124"
USER="azureuser"
KEY="/Users/adam/Documents/GitHub/Gold-Finder/Solana-Copy-Stream_key.pem"
REMOTE_DIR="/home/azureuser/dashboard-v2"
LOCAL_DIR="/Users/adam/Documents/GitHub/Gold-Finder/copy-trader/dashboard-v2"

echo "🚀 Deploying dashboard-v2 to Azure server root..."

# Create remote directory
echo "📁 Creating remote directory..."
ssh -i "$KEY" "$USER@$SERVER" "mkdir -p $REMOTE_DIR"

# Copy dashboard files to Azure
echo "📤 Uploading dashboard-v2 files..."
rsync -avz --progress \
  -e "ssh -i $KEY" \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '.git' \
  --exclude '*.log' \
  "$LOCAL_DIR/" "$USER@$SERVER:$REMOTE_DIR/"

# Install dependencies and build on Azure
echo "📦 Installing dependencies and building on Azure..."
ssh -i "$KEY" "$USER@$SERVER" << 'EOF'
  cd /home/azureuser/dashboard-v2
  
  # Install dependencies
  echo "Installing dependencies..."
  npm install
  
  # Build the Next.js application
  echo "Building Next.js application..."
  npm run build
  
  # Check if PM2 is installed
  if ! command -v pm2 &> /dev/null; then
    echo "Installing PM2..."
    npm install -g pm2
  fi
  
  # Stop existing instance if running
  pm2 stop dashboard-v2 2>/dev/null || true
  pm2 delete dashboard-v2 2>/dev/null || true
  
  # Start the dashboard with PM2
  echo "Starting dashboard-v2 with PM2..."
  pm2 start npm --name dashboard-v2 -- start
  pm2 save
  
  echo "✅ Dashboard-v2 deployed and started!"
  echo "🌐 Dashboard should be accessible on port 3000"
  pm2 status
EOF

echo "✅ Deployment complete!"
echo "📊 View logs: ssh -i $KEY $USER@$SERVER 'pm2 logs dashboard-v2 --lines 50'"
echo "📊 Check status: ssh -i $KEY $USER@$SERVER 'pm2 status'"
echo "🌐 Access dashboard at: http://$SERVER:3000"