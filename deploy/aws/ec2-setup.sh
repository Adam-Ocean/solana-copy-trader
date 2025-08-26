#!/bin/bash

# AWS EC2 Setup Script for Copy Trading Bot
# Recommended: t3.medium or t3.large instance
# Region: us-east-1 (N. Virginia)

set -e

echo "🚀 Setting up Copy Trading Bot on AWS EC2..."

# Update system
sudo apt-get update
sudo apt-get upgrade -y

# Install Docker
echo "📦 Installing Docker..."
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker ubuntu
rm get-docker.sh

# Install Docker Compose
echo "📦 Installing Docker Compose..."
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Install Node.js (for running directly if needed)
echo "📦 Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install monitoring tools
echo "📊 Installing monitoring tools..."
sudo apt-get install -y htop iotop nethogs

# Setup swap (important for smaller instances)
echo "💾 Setting up swap space..."
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Configure firewall
echo "🔒 Configuring firewall..."
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 3000/tcp  # Dashboard
sudo ufw allow 4789/tcp  # WebSocket API
sudo ufw --force enable

# Create app directory
echo "📁 Creating application directory..."
mkdir -p ~/copy-trader
cd ~/copy-trader

# Create environment file template
echo "📝 Creating environment template..."
cat > .env.example << 'EOF'
# RPC Configuration (Get from Helius, QuickNode, or Alchemy)
RPC_ENDPOINT=https://api.mainnet-beta.solana.com
BACKUP_RPC=https://api.mainnet-beta.solana.com

# API Keys
SOLANATRACKER_API_KEY=your_key_here
METIS_API_KEY=your_key_here
NEXTBLOCK_API_KEY=your_key_here

# Target Wallet to Copy
TARGET_WALLET=GVJp1bkQgw3QdXBmvWRBK5SaXcr3kzf45SfrvRDobQQE

# Your Wallet (for live trading only)
PRIVATE_KEY=

# Trading Configuration
POSITION_SIZE=0.5
MAX_POSITIONS=5
SLIPPAGE_BPS=200
MIN_LIQUIDITY_USD=10000
MAX_DAILY_LOSS=-0.7

# Mode
PAPER_TRADING=true
NODE_ENV=production

# Database (optional)
DB_PASSWORD=secure_password_here
EOF

echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Copy your code to ~/copy-trader/"
echo "   scp -r /path/to/copy-trader/* ubuntu@<EC2_IP>:~/copy-trader/"
echo ""
echo "2. Configure environment:"
echo "   cd ~/copy-trader"
echo "   cp .env.example .env"
echo "   nano .env  # Add your API keys"
echo ""
echo "3. Start the application:"
echo "   docker-compose -f deploy/aws/docker-compose.yml up -d"
echo ""
echo "4. View logs:"
echo "   docker-compose -f deploy/aws/docker-compose.yml logs -f"
echo ""
echo "5. Access dashboard:"
echo "   http://<EC2_IP>:3000"
echo ""
echo "🔐 Security reminder:"
echo "   - Use AWS Secrets Manager for production keys"
echo "   - Enable CloudWatch monitoring"
echo "   - Set up auto-scaling if needed"
echo "   - Use Application Load Balancer for HTTPS"