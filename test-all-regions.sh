#!/bin/bash

# EC2 Speed Test Runner for All Regions
# Tests latency from multiple AWS regions

echo "🚀 Running speed tests from all EC2 regions..."
echo "=============================================="

# Set proper permissions for PEM files
chmod 400 /Users/adam/Documents/GitHub/Gold-Finder/*.pem 2>/dev/null

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# Function to test a single region
test_region() {
    local region=$1
    local ip=$2
    local pem=$3
    local region_upper=$(echo "$region" | tr '[:lower:]' '[:upper:]')
    
    echo ""
    echo -e "${CYAN}Testing from ${region_upper} (${ip})...${NC}"
    echo "----------------------------------------------"
    
    # First test SSH connectivity
    ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -i "$pem" ec2-user@"$ip" "echo 'Connected successfully'" 2>/dev/null
    if [ $? -ne 0 ]; then
        echo -e "${RED}❌ Failed to connect to $region${NC}"
        return
    fi
    
    # Copy the speed test script
    scp -o StrictHostKeyChecking=no -i "$pem" /Users/adam/Documents/GitHub/Gold-Finder/copy-trader/speed-test-actual.js ec2-user@"$ip":/tmp/ 2>/dev/null
    
    # Install Node.js if needed and run the test
    ssh -o StrictHostKeyChecking=no -i "$pem" ec2-user@"$ip" << 'EOF'
        # Install Node.js if not present
        if ! command -v node &> /dev/null; then
            echo "Installing Node.js..."
            curl -sL https://rpm.nodesource.com/setup_20.x | sudo bash - &>/dev/null
            sudo yum install -y nodejs &>/dev/null
        fi
        
        # Run the speed test
        cd /tmp
        node speed-test-actual.js
        
        # Show instance details
        echo ""
        echo "📍 Instance Region: $(curl -s http://169.254.169.254/latest/meta-data/placement/region)"
        echo "📍 Instance Type: $(curl -s http://169.254.169.254/latest/meta-data/instance-type)"
        echo "📍 Instance AZ: $(curl -s http://169.254.169.254/latest/meta-data/placement/availability-zone)"
EOF
}

# Test each region with explicit parameters
test_region "sydney" "3.27.255.229" "/Users/adam/Documents/GitHub/Gold-Finder/bot-speed.pem"
test_region "virginia" "107.22.134.239" "/Users/adam/Documents/GitHub/Gold-Finder/speed-bot-virginia.pem"
test_region "oregon" "34.212.214.98" "/Users/adam/Documents/GitHub/Gold-Finder/speed-bot-oregon.pem"
test_region "london" "35.177.198.76" "/Users/adam/Documents/GitHub/Gold-Finder/speed-bot-london.pem"
test_region "frankfurt" "3.124.8.62" "/Users/adam/Documents/GitHub/Gold-Finder/bot-speed-frankfurt.pem"

echo ""
echo "=============================================="
echo -e "${GREEN}✅ All region tests completed!${NC}"
echo ""
echo "📊 Summary:"
echo "- Virginia (us-east-1): Best for Solana validators"
echo "- Oregon (us-west-2): Good backup location"
echo "- Frankfurt (eu-central-1): Best for EU operations"
echo "- London (eu-west-2): Alternative EU location"
echo "- Sydney (ap-southeast-2): For Asia-Pacific coverage"