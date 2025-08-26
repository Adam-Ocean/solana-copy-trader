#!/bin/bash

# Ultra-simple deployment - just run Node.js directly
# For AWS EC2 t3.small or larger

# Quick setup (run once)
setup() {
    # Install Node.js
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    
    # Install dependencies
    npm install
    cd dashboard-v2 && npm install && cd ..
    
    # Build
    npm run build
    cd dashboard-v2 && npm run build && cd ..
}

# Run the bot (use screen or tmux to keep running)
run() {
    # Load environment variables
    export $(cat .env | xargs)
    
    # Start in background using screen
    screen -dmS trader node dist/index.js
    screen -dmS dashboard bash -c "cd dashboard-v2 && npm start"
    
    echo "✅ Started!"
    echo "View trader logs: screen -r trader"
    echo "View dashboard logs: screen -r dashboard"
    echo "Dashboard: http://$(curl -s ifconfig.me):3000"
}

# Simple process management
status() {
    screen -ls
    echo ""
    ps aux | grep -E "node|npm" | grep -v grep
}

stop() {
    pkill -f "node dist/index.js"
    pkill -f "npm start"
    screen -X -S trader quit
    screen -X -S dashboard quit
    echo "Stopped all processes"
}

# Handle commands
case "$1" in
    setup)
        setup
        ;;
    run)
        run
        ;;
    status)
        status
        ;;
    stop)
        stop
        ;;
    *)
        echo "Usage: $0 {setup|run|status|stop}"
        echo ""
        echo "First time: ./run-on-ec2.sh setup"
        echo "Then: ./run-on-ec2.sh run"
        exit 1
        ;;
esac