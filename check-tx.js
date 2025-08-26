const { Connection } = require('@solana/web3.js');

async function checkTransaction() {
  const connection = new Connection('https://api.mainnet-beta.solana.com');
  
  // Get recent transaction for the wallet
  const signatures = await connection.getSignaturesForAddress(
    new (require('@solana/web3.js').PublicKey)('GVJp1bkQgw3QdXBmvWRBK5SaXcr3kzf45SfrvRDobQQE'),
    { limit: 1 }
  );
  
  if (signatures.length === 0) {
    console.log('No recent transactions');
    return;
  }
  
  const sig = signatures[0].signature;
  console.log('Checking transaction:', sig);
  
  const tx = await connection.getParsedTransaction(sig, {
    maxSupportedTransactionVersion: 0
  });
  
  if (!tx) {
    console.log('Transaction not found');
    return;
  }
  
  // Extract program IDs
  const programs = new Set();
  tx.transaction.message.instructions.forEach(inst => {
    const programId = inst.programId ? inst.programId.toString() : inst.program;
    programs.add(programId);
  });
  
  console.log('\nPrograms involved:');
  const knownDEXs = {
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter V6',
    'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB': 'Jupiter V4',
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium V4',
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CPMM',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool'
  };
  
  programs.forEach(p => {
    const dexName = knownDEXs[p] || '';
    console.log(`  ${p} ${dexName ? `(${dexName})` : ''}`);
  });
  
  // Check token balance changes
  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  
  console.log('\nToken changes:');
  console.log(`  Pre-balances: ${pre.length} tokens`);
  console.log(`  Post-balances: ${post.length} tokens`);
  
  // Check if this looks like a swap
  const hasTokenChanges = pre.length > 0 || post.length > 0;
  const hasDEX = Array.from(programs).some(p => knownDEXs[p]);
  
  console.log('\nSwap detection:');
  console.log(`  Has token changes: ${hasTokenChanges}`);
  console.log(`  Has DEX program: ${hasDEX}`);
  console.log(`  Likely a swap: ${hasTokenChanges && hasDEX}`);
}

checkTransaction().catch(console.error);