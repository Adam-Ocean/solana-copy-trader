#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

while true; do
    # Get current network slot
    NETWORK_SLOT=$(curl -s "https://api.mainnet-beta.solana.com" \
        -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' | \
        grep -o '"result":[0-9]*' | cut -d: -f2)
    
    # Get last slot from bot logs (look for Yellowstone transactions or slot mentions)
    LAST_LOG=$(pm2 logs copy-trader --lines 100 --nostream 2>/dev/null | \
        grep -E "slot|Slot|Parsing transaction:|Signal #" | tail -1)
    
    # Try to extract slot number from recent activity - handle different formats
    BOT_SLOT=$(pm2 logs copy-trader --lines 200 --nostream 2>/dev/null | \
        grep -iE "slot" | tail -1 | grep -oE "slot[: ]+[0-9]+" | grep -oE "[0-9]+$")
    
    # If no slot found in logs, use a placeholder
    if [ -z "$BOT_SLOT" ]; then
        BOT_SLOT="Unknown"
        DIFF="N/A"
        TIME_BEHIND="N/A"
        STATUS="⏳"
    else
        DIFF=$((NETWORK_SLOT - BOT_SLOT))
        # Calculate time behind (400ms per slot)
        TIME_BEHIND=$(echo "scale=1; $DIFF * 0.4 / 60" | bc)
        
        # Determine status icon based on difference
        if [ $DIFF -lt 100 ]; then
            STATUS="✅"
        elif [ $DIFF -lt 500 ]; then
            STATUS="⚠️"
        else
            STATUS="❌"
        fi
    fi
    
    # Clear screen for clean display
    clear
    echo "📊 Monitoring Slot Synchronization"
    echo "========================================="
    echo ""
    echo "🌐 Network Slot: $NETWORK_SLOT"
    echo "🤖 Bot Slot:     $BOT_SLOT"
    echo ""
    
    if [ "$BOT_SLOT" != "Unknown" ]; then
        # Always show the difference prominently
        echo "📏 Slot Difference: $DIFF slots"
        
        # Show color-coded status with time
        if [ $DIFF -lt 100 ]; then
            printf "${GREEN}✅ Status: SYNCED (~${TIME_BEHIND} minutes behind)${NC}\n"
        elif [ $DIFF -lt 500 ]; then
            printf "${YELLOW}⚠️  Status: LAGGING (~${TIME_BEHIND} minutes behind)${NC}\n"
        else
            printf "${RED}❌ Status: SEVERELY BEHIND (~${TIME_BEHIND} minutes behind)${NC}\n"
        fi
    else
        echo "📏 Slot Difference: N/A"
        echo "⏳ Status: Waiting for bot activity..."
    fi
    
    # Show last activity
    if [ ! -z "$LAST_LOG" ]; then
        echo "📝 Last Activity: $(echo $LAST_LOG | cut -c1-60)..."
    fi
    
    echo "-----------------------------------------"
    echo "Press Ctrl+C to stop monitoring"
    
    # Wait 5 seconds before next check
    sleep 5
done