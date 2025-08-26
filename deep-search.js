#!/usr/bin/env node

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const bs58 = require('bs58');

const WALLET = 'GVJp1bkQgw3QdXBmvWRBK5SaXcr3kzf45SfrvRDobQQE';
const walletBytes = bs58.default.decode(WALLET);
const firstBytes = Array.from(walletBytes.slice(0, 4)); // First 4 bytes

const protoPath = path.join(process.cwd(), 'geyser.proto');
const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});

const geyserProto = grpc.loadPackageDefinition(packageDefinition);
const client = new geyserProto.geyser.Geyser('localhost:10015', grpc.credentials.createInsecure());
const stream = client.subscribe();

let checked = 0;

// Helper to check if buffer matches wallet
const matchesWallet = (buf) => {
    if (!Buffer.isBuffer(buf) || buf.length !== 32) return false;
    return buf[0] === firstBytes[0] && buf[1] === firstBytes[1] && 
           buf[2] === firstBytes[2] && buf[3] === firstBytes[3];
};

stream.on('data', (data) => {
    if (data.update_oneof === 'transaction' && checked < 5000) {
        checked++;
        const tx = data.transaction;
        
        // Deep search for wallet bytes
        const search = (obj, path = '') => {
            if (Buffer.isBuffer(obj)) {
                if (matchesWallet(obj)) {
                    console.log('✅ FOUND WALLET at', path);
                    console.log('Slot:', tx.slot);
                    const sig = tx.transaction?.signature;
                    if (sig) {
                        console.log('Signature:', Buffer.from(sig).toString('hex').substring(0, 40) + '...');
                    }
                    
                    // Show the full path structure
                    console.log('\nFull path to wallet:');
                    const parts = path.split(/[\.\[\]]+/).filter(p => p);
                    let current = tx;
                    let fullPath = 'tx';
                    for (const part of parts) {
                        if (!isNaN(part)) {
                            current = current[parseInt(part)];
                            fullPath += `[${part}]`;
                        } else {
                            current = current[part];
                            fullPath += `.${part}`;
                        }
                    }
                    console.log(fullPath);
                    
                    process.exit(0);
                }
            } else if (Array.isArray(obj)) {
                obj.forEach((item, i) => search(item, path + '[' + i + ']'));
            } else if (obj && typeof obj === 'object') {
                Object.keys(obj).forEach(key => search(obj[key], path + '.' + key));
            }
        };
        
        search(tx);
        
        if (checked % 500 === 0) {
            console.log('Checked', checked, 'transactions...');
        }
    }
});

stream.on('error', (err) => {
    console.error('Error:', err.message);
});

stream.write({ transactions: { 'all': { vote: false } }, commitment: 'processed' });
console.log('Deep searching for wallet bytes [' + firstBytes.join(', ') + '...] in transactions...');

setTimeout(() => {
    console.log('Searched', checked, 'transactions, wallet not found');
    process.exit(1);
}, 60000);