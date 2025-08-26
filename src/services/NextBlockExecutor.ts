import axios from 'axios';
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { TradeExecution, NextBlockConfig } from '../types/enhanced';

export class NextBlockExecutor { // Actually using Metis/QuickNode directly now
  private config: NextBlockConfig;
  private connection: Connection;
  private wallet: Keypair | null = null;
  private metisUrl: string;
  private fastestEndpoint: string | null = null;
  private tipFloorCache: any = null;
  private tipFloorLastUpdate = 0;

  // NextBlock tip wallets
  private readonly TIP_WALLETS = [
    'NEXTbLoCkB51HpLBLojQfpyVAMorm3zzKg7w9NFdqid',
    'nextBLoCkPMgmG8ZgJtABeScP35qLa2AMCNKntAP7Xc',
    'NextbLoCkVtMGcV47JzewQdvBpLqT9TxQFozQkN98pE',
    'NexTbLoCkWykbLuB1NkjXgFWkX9oAtcoagQegygXXA2',
    'NeXTBLoCKs9F1y5PJS9CKrFNNLU1keHW71rfh7KgA1X',
    'NexTBLockJYZ7QD7p2byrUa6df8ndV2WSd8GkbWqfbb',
    'neXtBLock1LeC67jYd1QdAa32kbVeubsfPNTJC1V5At',
    'nEXTBLockYgngeRmRrjDV31mGSekVPqZoMGhQEZtPVG'
  ];

  constructor(
    config: NextBlockConfig,
    connection: Connection,
    metisUrl: string,
    walletKey?: string
  ) {
    this.config = config;
    this.connection = connection;
    this.metisUrl = metisUrl;

    if (walletKey) {
      try {
        const secretKey = bs58.decode(walletKey);
        this.wallet = Keypair.fromSecretKey(secretKey);
        console.log('✅ Wallet loaded for NextBlock execution');
      } catch (error) {
        console.error('❌ Invalid wallet secret key');
      }
    }

    // Test endpoints to find fastest ON STARTUP
    console.log('\n🚀 NextBlock Endpoint Testing Starting...');
    console.log('   This happens automatically on bot startup to find the fastest server');
    this.testEndpoints();
    
    // Re-test every 5 minutes to adapt to network conditions
    setInterval(() => {
      console.log('\n🔄 Re-testing NextBlock endpoints for optimal performance...');
      this.testEndpoints();
    }, 5 * 60 * 1000); // 5 minutes
  }

  private async testEndpoints(): Promise<void> {
    console.log('🔍 Testing NextBlock endpoints for fastest response...');
    
    const endpoints = this.config.endpoints;
    
    // Test all endpoints in parallel for faster startup
    const testPromises = endpoints.map(async (endpoint) => {
      try {
        const start = Date.now();
        // Test the submit endpoint with a minimal request
        await axios.post(
          `http://${endpoint}/api/v2/submit`,
          {
            transaction: { content: "test" },
            frontRunningProtection: false
          },
          {
            timeout: 3000,
            headers: {
              'Authorization': this.config.apiKey,
              'Content-Type': 'application/json'
            },
            validateStatus: (status) => status < 500 // Accept 400 errors as valid
          }
        );
        const latency = Date.now() - start;
        console.log(`   ${endpoint}: ${latency}ms ✅`);
        return { endpoint, latency };
      } catch (error: any) {
        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
          console.log(`   ${endpoint}: Not available ❌`);
          return null;
        } else if (error.response?.status === 401) {
          console.log(`   ${endpoint}: Unauthorized (API key issue) ⚠️`);
          return { endpoint, latency: 9999 };
        } else {
          console.log(`   ${endpoint}: Error - ${error.message} ⚠️`);
          return { endpoint, latency: 9999 };
        }
      }
    });

    const results = (await Promise.all(testPromises)).filter(r => r !== null) as { endpoint: string; latency: number }[];

    // Select fastest endpoint
    if (results.length > 0) {
      results.sort((a, b) => a.latency - b.latency);
      this.fastestEndpoint = results[0].endpoint;
      console.log(`✅ Selected endpoint: ${this.fastestEndpoint}`);
    } else {
      this.fastestEndpoint = 'fra.nextblock.io'; // Default to Frankfurt
      console.log(`⚠️ Using default endpoint: ${this.fastestEndpoint}`);
    }
  }

  private async getTipFloor(): Promise<number> {
    // Cache tip floor for 1 minute
    if (this.tipFloorCache && Date.now() - this.tipFloorLastUpdate < 60000) {
      return this.tipFloorCache.landed_tips_50th_percentile;
    }

    try {
      const response = await axios.get(
        `https://${this.fastestEndpoint}/api/v1/tip-floor`,
        {
          headers: {
            'Authorization': this.config.apiKey
          },
          timeout: 2000
        }
      );

      this.tipFloorCache = response.data;
      this.tipFloorLastUpdate = Date.now();

      return response.data.landed_tips_50th_percentile || 0.005;
    } catch (error) {
      console.error('Error fetching tip floor:', error);
      return 0.005; // Default 0.005 SOL
    }
  }

  private getRandomTipWallet(): string {
    return this.TIP_WALLETS[Math.floor(Math.random() * this.TIP_WALLETS.length)];
  }

  public async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number
  ): Promise<any> {
    let url = '';
    try {
      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: Math.floor(amount).toString(),
        slippageBps: slippageBps.toString(),
        onlyDirectRoutes: 'false',
        maxAccounts: '64',
        asLegacyTransaction: 'false'
      });

      // Remove trailing slash from metisUrl if it exists
      const baseUrl = this.metisUrl.endsWith('/') ? this.metisUrl.slice(0, -1) : this.metisUrl;
      url = `${baseUrl}/quote?${params}`;
      
      console.log(`🔍 Fetching quote from: ${url.substring(0, 100)}...`);
      
      const response = await axios.get(url, {
        timeout: 5000 // Increased timeout for complex routing calculations
      });

      return response.data;
    } catch (error: any) {
      // Handle specific error cases
      if (error.response?.data?.errorCode === 'TOKEN_NOT_TRADABLE') {
        console.warn(`⚠️ Token not tradable: ${outputMint}`);
        console.log('Full error response:', JSON.stringify(error.response?.data, null, 2));
        return null;
      }
      
      if (error.response?.status === 400) {
        console.error('Quote API error:', error.response?.data?.error || 'Bad request');
        console.log('Full error response:', JSON.stringify(error.response?.data, null, 2));
        return null;
      }
      
      console.error('Error getting quote:', error.message);
      console.log('Request URL was:', url);
      console.log('Error details:', error.response?.status, error.response?.statusText);
      return null;
    }
  }

  public async executeTrade(
    execution: TradeExecution,
    quote: any,
    paperTrading = false
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    try {
      if (paperTrading) {
        console.log(`📝 PAPER TRADE: ${execution.side} ${execution.amount} for ${execution.token}`);
        return {
          success: true,
          txHash: `paper_${execution.side}_${Date.now()}`
        };
      }

      // Only check wallet for real trading
      if (!paperTrading && !this.wallet) {
        return {
          success: false,
          error: 'Wallet not configured for real trading'
        };
      }

      console.log(`🚀 Executing ${execution.side} via Metis/QuickNode...`);

      // Get swap transaction from Metis/Jupiter
      const swapResponse = await this.getSwapTransaction(quote, execution);
      
      if (!swapResponse || !swapResponse.swapTransaction) {
        return {
          success: false,
          error: 'Failed to build swap transaction'
        };
      }

      // Submit directly to QuickNode RPC (not NextBlock)
      console.log(`📡 Submitting to QuickNode RPC with priority fee...`);
      
      // Deserialize, sign, and send the transaction
      const txBuffer = Buffer.from(swapResponse.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(txBuffer);
      
      // Sign the transaction
      transaction.sign([this.wallet!]);
      
      // Submit directly to RPC
      const signature = await this.connection.sendTransaction(transaction, {
        skipPreflight: true,
        maxRetries: 2,
        preflightCommitment: 'processed'
      });
      
      const submitResponse = {
        success: true,
        signature
      };

      if (submitResponse.success && submitResponse.signature) {
        console.log(`✅ Transaction submitted: ${submitResponse.signature}`);
        
        // Monitor transaction status
        await this.monitorTransaction(submitResponse.signature);
        
        return {
          success: true,
          txHash: submitResponse.signature
        };
      } else {
        return {
          success: false,
          error: 'Failed to submit transaction'
        };
      }

    } catch (error: any) {
      console.error('Trade execution error:', error);
      return {
        success: false,
        error: error.message || 'Unknown error'
      };
    }
  }

  private async getSwapTransaction(quote: any, execution: TradeExecution): Promise<any> {
    try {
      // Check if this is a Pump.fun token (Simple AMM)
      const routeLabel = quote.routePlan?.[0]?.swapInfo?.label || '';
      const isPumpFun = routeLabel.toLowerCase().includes('pump.fun');
      
      // Build swap request with dynamic slippage for meme tokens
      const swapRequest = {
        userPublicKey: this.wallet!.publicKey.toString(),
        quoteResponse: quote,
        wrapAndUnwrapSol: true,
        useSharedAccounts: !isPumpFun, // Must be false for Pump.fun tokens
        asLegacyTransaction: false,
        useTokenLedger: false,
        dynamicComputeUnitLimit: true,
        skipUserAccountsRpcCalls: false,
        // Use dynamic slippage for meme tokens
        dynamicSlippage: {
          minBps: 100,   // Min 1% (Jupiter will optimize)
          maxBps: 3000   // Max 30% for extreme volatility
        },
        // Use prioritizationFeeLamports for auto-calculated priority fee
        prioritizationFeeLamports: 'auto' // Auto-calculate priority fee up to 0.005 SOL
      };

      // Remove trailing slash from metisUrl if it exists
      const baseUrl = this.metisUrl.endsWith('/') ? this.metisUrl.slice(0, -1) : this.metisUrl;
      
      const response = await axios.post(
        `${baseUrl}/swap`,
        swapRequest,
        {
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data;
    } catch (error: any) {
      console.error('Error getting swap transaction:');
      if (error.response) {
        console.error('  Status:', error.response.status);
        console.error('  Error:', JSON.stringify(error.response.data, null, 2));
      } else {
        console.error('  Message:', error.message);
      }
      return null;
    }
  }

  private async submitToNextBlock(
    transactionBase64: string,
    priorityFee: number,
    antiMEV: boolean
  ): Promise<{ success: boolean; signature?: string; error?: string }> {
    try {
      // Decode and modify transaction to add tip
      const txBuffer = Buffer.from(transactionBase64, 'base64');
      const transaction = VersionedTransaction.deserialize(txBuffer);
      
      // TODO: Add tip instruction to random NextBlock wallet
      // This would require modifying the transaction to include a transfer instruction
      // to one of the NextBlock tip wallets

      // Submit to NextBlock API (using HTTP for faster connection)
      const response = await axios.post(
        `http://${this.fastestEndpoint}/api/v2/submit`,
        {
          transaction: {
            content: transactionBase64
          },
          skipPreFlight: true,
          useStakedRPCs: false,
          frontRunningProtection: antiMEV,
          fastBestEffort: true
        },
        {
          headers: {
            'Authorization': this.config.apiKey,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      if (response.data.signature) {
        return {
          success: true,
          signature: response.data.signature
        };
      } else {
        return {
          success: false,
          error: response.data.error || 'No signature returned'
        };
      }

    } catch (error: any) {
      console.error('NextBlock submission error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  }

  private async monitorTransaction(signature: string): Promise<void> {
    try {
      console.log('   Monitoring transaction...');
      
      let confirmed = false;
      let attempts = 0;
      const maxAttempts = 30;

      while (!confirmed && attempts < maxAttempts) {
        attempts++;
        
        try {
          const status = await this.connection.getSignatureStatus(signature);
          
          if (status.value?.confirmationStatus === 'confirmed' || 
              status.value?.confirmationStatus === 'finalized') {
            confirmed = true;
            console.log(`   ✅ Transaction confirmed in slot ${status.context.slot}`);
            break;
          }
        } catch (error) {
          // Continue monitoring
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (!confirmed) {
        console.log('   ⚠️ Transaction confirmation timeout');
      }

    } catch (error) {
      console.error('Error monitoring transaction:', error);
    }
  }

  public async checkTokenLiquidity(token: string): Promise<number> {
    try {
      // Try Birdeye first for market data
      const birdeyeKey = process.env.BIRDEYE_API_KEY;
      
      if (birdeyeKey) {
        try {
          const response = await axios.get(
            `https://public-api.birdeye.so/defi/token_overview?address=${token}`,
            {
              headers: { 'X-API-KEY': birdeyeKey },
              timeout: 3000
            }
          );
          
          const liquidity = response.data?.data?.liquidity || response.data?.liquidity || 0;
          if (liquidity > 0) {
            return liquidity;
          }
        } catch {
          // Continue to fallback
        }
      }
      
      // Fallback to SolanaTracker
      const response = await axios.get(
        `https://api.solanatracker.io/tokens/${token}`,
        {
          headers: {
            'x-api-key': process.env.SOLANATRACKER_API_KEY
          },
          timeout: 3000
        }
      );

      const pools = response.data.pools || [];
      let totalLiquidity = 0;

      for (const pool of pools) {
        totalLiquidity += pool.liquidity?.usd || 0;
      }

      return totalLiquidity;
    } catch (error) {
      console.error('Error checking liquidity:', error);
      return 0;
    }
  }

  public updateConfig(config: Partial<NextBlockConfig>): void {
    this.config = { ...this.config, ...config };
    
    // Re-test endpoints if they changed
    if (config.endpoints) {
      this.testEndpoints();
    }
  }
}