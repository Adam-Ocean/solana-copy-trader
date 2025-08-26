#!/usr/bin/env node

// Monitor when our local validator catches up to mainnet

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getSlot(rpcUrl) {
    try {
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getSlot'
            })
        });
        const data = await response.json();
        return data.result;
    } catch (e) {
        return null;
    }
}

async function monitor() {
    console.log('🔄 Monitoring validator sync progress...');
    console.log('Target wallet trades every 30s-2min, latest was 3 mins ago\n');
    
    while (true) {
        const mainnetSlot = await getSlot('https://api.mainnet-beta.solana.com/');
        const localSlot = await getSlot('http://localhost:8899/');
        
        if (mainnetSlot && localSlot) {
            const behind = mainnetSlot - localSlot;
            const catchingUp = behind < 100; // Within 100 slots = ~1 minute
            
            console.log(`Mainnet: ${mainnetSlot} | Local: ${localSlot} | Behind: ${behind} slots ${catchingUp ? '✅ CLOSE!' : '⏳'}`);
            
            if (catchingUp) {
                console.log('\n✅ Validator is caught up! Yellowstone should be receiving current transactions now.');
                console.log('🟡 The bot should detect the next wallet transaction within 30s-2min');
                break;
            }
        } else if (mainnetSlot && !localSlot) {
            console.log(`Mainnet: ${mainnetSlot} | Local: Not ready yet ⏳`);
        } else {
            console.log('Checking...');
        }
        
        await sleep(10000); // Check every 10 seconds
    }
}

monitor().catch(console.error);