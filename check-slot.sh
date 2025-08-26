#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to format numbers with commas
format_number() {
    echo "$1" | sed ':a;s/\B[0-9]\{3\}\>/,&/;ta'
}

# Function to calculate percentage
calc_percentage() {
    if [ "$2" -eq 0 ]; then
        echo "0"
    else
        echo "scale=2; $1 * 100 / $2" | bc
    fi
}

# Check if node is running
check_node_status() {
    if pgrep -f "agave-validator" > /dev/null; then
        echo -e "${GREEN}✓ Validator is running${NC}"
        return 0
    else
        echo -e "${RED}✗ Validator is not running${NC}"
        return 1
    fi
}

# Get slot information
get_slot_info() {
    # Try to get current slot from RPC (without jq)
    LOCAL_SLOT_RESPONSE=$(curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" -d '{"jsonrpc": "2.0", "id": 1, "method": "getSlot"}' 2>/dev/null)
    if echo "$LOCAL_SLOT_RESPONSE" | grep -q '"result"'; then
        LOCAL_SLOT=$(echo "$LOCAL_SLOT_RESPONSE" | grep -oE '"result":[0-9]+' | grep -oE '[0-9]+')
    else
        LOCAL_SLOT="N/A"
    fi
    
    # Get slot from validator log
    LOG_SLOT=$(grep -E "slot:[ ]*[0-9]+" /mnt/solana-data/logs/validator.log 2>/dev/null | tail -1 | grep -oE "[0-9]+" | tail -1)
    
    # Get latest network slot from public RPC (without jq)
    NETWORK_SLOT_RESPONSE=$(curl -s https://api.mainnet-beta.solana.com -X POST -H "Content-Type: application/json" -d '{"jsonrpc": "2.0", "id": 1, "method": "getSlot"}' 2>/dev/null)
    if echo "$NETWORK_SLOT_RESPONSE" | grep -q '"result"'; then
        NETWORK_SLOT=$(echo "$NETWORK_SLOT_RESPONSE" | grep -oE '"result":[0-9]+' | grep -oE '[0-9]+')
    else
        NETWORK_SLOT="N/A"
    fi
    
    # Check if rebuilding snapshot
    REBUILDING=$(grep "rebuilt storages" /mnt/solana-data/logs/validator.log | tail -1)
    if [ ! -z "$REBUILDING" ]; then
        REBUILT_INFO=$(echo "$REBUILDING" | grep -oE "[0-9]+/[0-9]+" | tail -1)
        if [ ! -z "$REBUILT_INFO" ]; then
            REBUILT_CURRENT=$(echo "$REBUILT_INFO" | cut -d'/' -f1)
            REBUILT_TOTAL=$(echo "$REBUILT_INFO" | cut -d'/' -f2)
            REBUILT_PCT=$(calc_percentage $REBUILT_CURRENT $REBUILT_TOTAL)
        fi
    fi
    
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}                 SOLANA NODE STATUS                      ${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}\n"
    
    # Node Status
    check_node_status
    echo ""
    
    # Slot Information
    echo -e "${YELLOW}📊 SLOT INFORMATION:${NC}"
    echo -e "├─ Network Slot:    $(format_number $NETWORK_SLOT)"
    
    if [ "$LOCAL_SLOT" != "N/A" ]; then
        echo -e "├─ Local RPC Slot:  ${GREEN}$(format_number $LOCAL_SLOT)${NC}"
        if [ "$NETWORK_SLOT" != "N/A" ]; then
            BEHIND=$((NETWORK_SLOT - LOCAL_SLOT))
            if [ $BEHIND -lt 100 ]; then
                echo -e "├─ Slots Behind:    ${GREEN}$(format_number $BEHIND) ✓${NC}"
                echo -e "└─ Status:          ${GREEN}SYNCED${NC}"
            else
                echo -e "├─ Slots Behind:    ${YELLOW}$(format_number $BEHIND)${NC}"
                SYNC_PCT=$(calc_percentage $LOCAL_SLOT $NETWORK_SLOT)
                echo -e "├─ Sync Progress:   ${YELLOW}${SYNC_PCT}%${NC}"
                echo -e "└─ Status:          ${YELLOW}CATCHING UP${NC}"
            fi
        fi
    else
        echo -e "├─ Local RPC Slot:  ${RED}Not Available (RPC starting)${NC}"
        if [ ! -z "$LOG_SLOT" ]; then
            echo -e "├─ Log Slot:        $(format_number $LOG_SLOT)"
            if [ "$NETWORK_SLOT" != "N/A" ]; then
                BEHIND=$((NETWORK_SLOT - LOG_SLOT))
                echo -e "├─ Slots Behind:    ${YELLOW}$(format_number $BEHIND)${NC}"
            fi
        fi
        
        # Show rebuild progress if available
        if [ ! -z "$REBUILT_INFO" ]; then
            echo -e "├─ Snapshot Rebuild: ${YELLOW}$(format_number $REBUILT_CURRENT) / $(format_number $REBUILT_TOTAL)${NC}"
            echo -e "├─ Rebuild Progress: ${YELLOW}${REBUILT_PCT}%${NC}"
            
            # Progress bar
            BAR_LENGTH=30
            FILLED=$(echo "scale=0; $BAR_LENGTH * $REBUILT_PCT / 100" | bc)
            EMPTY=$((BAR_LENGTH - FILLED))
            
            echo -n -e "├─ ["
            for ((i=0; i<$FILLED; i++)); do echo -n "█"; done
            for ((i=0; i<$EMPTY; i++)); do echo -n "░"; done
            echo -e "]"
        fi
        echo -e "└─ Status:          ${YELLOW}STARTING UP${NC}"
    fi
    
    # Check Yellowstone status
    echo -e "\n${YELLOW}🟡 YELLOWSTONE STATUS:${NC}"
    if ss -tuln | grep -q :10015; then
        echo -e "├─ gRPC Port 10015: ${GREEN}LISTENING ✓${NC}"
        
        # Check for active connections
        CONNECTIONS=$(ss -tan | grep :10015 | grep ESTAB | wc -l)
        if [ $CONNECTIONS -gt 0 ]; then
            echo -e "└─ Connections:     ${GREEN}$CONNECTIONS active${NC}"
        else
            echo -e "└─ Connections:     ${YELLOW}Waiting for connections${NC}"
        fi
    else
        echo -e "└─ gRPC Port 10015: ${RED}NOT LISTENING ✗${NC}"
    fi
    
    # Check disk usage
    echo -e "\n${YELLOW}💾 DISK USAGE:${NC}"
    LEDGER_SIZE=$(du -sh /mnt/solana-data/ledger 2>/dev/null | cut -f1)
    ACCOUNTS_SIZE=$(du -sh /mnt/solana-data/accounts 2>/dev/null | cut -f1)
    SNAPSHOTS_SIZE=$(du -sh /mnt/solana-data/snapshots 2>/dev/null | cut -f1)
    
    echo -e "├─ Ledger:          $LEDGER_SIZE"
    echo -e "├─ Accounts:        $ACCOUNTS_SIZE"
    echo -e "└─ Snapshots:       $SNAPSHOTS_SIZE"
    
    # Show recent errors if any
    echo -e "\n${YELLOW}⚠️  RECENT ACTIVITY:${NC}"
    RECENT_ERRORS=$(grep -i "error\|warn" /mnt/solana-data/logs/validator.log 2>/dev/null | tail -3)
    if [ ! -z "$RECENT_ERRORS" ]; then
        echo "$RECENT_ERRORS" | while IFS= read -r line; do
            if echo "$line" | grep -qi "error"; then
                echo -e "${RED}└─ ERROR: $(echo "$line" | cut -c1-70)...${NC}"
            else
                echo -e "${YELLOW}└─ WARN: $(echo "$line" | cut -c1-70)...${NC}"
            fi
        done
    else
        echo -e "${GREEN}└─ No recent errors${NC}"
    fi
    
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════${NC}"
}

# Continuous monitoring mode
if [ "$1" == "-w" ] || [ "$1" == "--watch" ]; then
    while true; do
        clear
        get_slot_info
        echo -e "\n${YELLOW}Refreshing every 5 seconds... (Ctrl+C to exit)${NC}"
        sleep 5
    done
else
    get_slot_info
    echo -e "\n${YELLOW}Tip: Use '$0 -w' for continuous monitoring${NC}"
fi