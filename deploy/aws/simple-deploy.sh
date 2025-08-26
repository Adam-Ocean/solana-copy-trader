#!/bin/bash

# Simple AWS EC2 Deployment WITHOUT Docker
# Using PM2 process manager for production

set -e

echo "🚀 Simple deployment setup for Copy Trading Bot..."

# Update system
sudo apt-get update && sudo apt-get upgrade -y

# Install Node.js 20
echo "📦 Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential

# Install PM2 globally
echo "📦 Installing PM2..."
sudo npm install -g pm2

# Install git
sudo apt-get install -y git

# Setup the application directory
mkdir -p ~/copy-trader
cd ~/copy-trader

# Clone or copy your code here
echo "📁 Ready for code deployment..."

# Create PM2 ecosystem file
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'copy-trader',
      script: './dist/index.js',
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
    },
    {
      name: 'dashboard',
      script: 'npm',
      args: 'run start',
      cwd: './dashboard-v2',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
EOF

# Create systemd service for PM2
echo "🔧 Setting up PM2 as system service..."
pm2 startup systemd -u ubuntu --hp /home/ubuntu
pm2 save

echo "✅ Setup complete!"
echo ""
echo "📋 To deploy your code:"
echo "1. Copy files: scp -r ./* ubuntu@<IP>:~/copy-trader/"
echo "2. SSH in: ssh ubuntu@<IP>"
echo "3. Install deps: cd ~/copy-trader && npm install"
echo "4. Build: npm run build"
echo "5. Start: pm2 start ecosystem.config.js"
echo "6. Monitor: pm2 monit"