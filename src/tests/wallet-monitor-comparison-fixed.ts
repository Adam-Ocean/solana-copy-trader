import { client as WebSocketClient } from 'websocket';
import WebSocket from 'ws';
import util from 'util';

interface DetectionResult {
  signature: string;
  birdeyeTime?: number;
  quicknodeTime?: number;
  winner?: 'birdeye' | 'quicknode' | 'tie';
  difference?: number;
}

interface ComparisonStats {
  totalTransactions: number;
  birdeyeWins: number;
  quicknodeWins: number;
  ties: number;
  avgDifference: number;
  birdeyeFastest: number;
  quicknodeFastest: number;
  missingFromBirdeye: number;
  missingFromQuicknode: number;
}

export class WalletMonitorComparison {
  private birdeyeConnection: any = null;
  private quicknodeWS: WebSocket | null = null;
  private detectionResults: Map<string, DetectionResult> = new Map();
  private stats: ComparisonStats = {
    totalTransactions: 0,
    birdeyeWins: 0,
    quicknodeWins: 0,
    ties: 0,
    avgDifference: 0,
    birdeyeFastest: Infinity,
    quicknodeFastest: Infinity,
    missingFromBirdeye: 0,
    missingFromQuicknode: 0
  };
  private testStartTime: number = 0;
  private isRunning: boolean = false;

  constructor(
    private birdeyeApiKey: string,
    private quicknodeUrl: string,
    private testWallet: string
  ) {
    console.log(`🔬 Wallet Monitor Comparison Test`);
    console.log(`📍 Testing from: ${process.env.AWS_INSTANCE || 'local'}`);
    console.log(`👛 Monitoring wallet: ${this.testWallet}`);
  }

  async start(): Promise<void> {
    console.log('\\n🚀 Starting comparison test...');
    this.testStartTime = Date.now();
    this.isRunning = true;

    // Start both monitors in parallel
    await Promise.all([
      this.connectBirdeye(),
      this.connectQuickNode()
    ]);

    console.log('✅ Both monitors connected and subscribed');
    console.log('⏳ Monitoring for transactions...');
    console.log('');
  }

  private async connectBirdeye(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const client = new WebSocketClient();
        const url = util.format('wss://public-api.birdeye.so/socket/solana?x-api-key=%s', this.birdeyeApiKey);
        
        client.on('connectFailed', (error) => {
          console.log('❌ Birdeye Connect Error: ' + error.toString());
          reject(error);
        });

        client.on('connect', (connection) => {
          console.log('🦅 Birdeye WebSocket connected');
          this.birdeyeConnection = connection;
          
          connection.on('error', (error) => {
            console.error('❌ Birdeye Connection Error: ' + error.toString());
          });

          connection.on('close', () => {
            console.log('🦅 Birdeye WebSocket closed');
            if (this.isRunning) {
              setTimeout(() => this.connectBirdeye(), 5000);
            }
          });

          connection.on('message', (message) => {
            if (message.type === 'utf8') {
              try {
                const data = JSON.parse(message.utf8Data!);
                if (data.type === 'WALLET_TXS_DATA') {
                  this.handleBirdeyeTransaction(data.data);
                }
              } catch (error) {
                console.error('Birdeye message parse error:', error);
              }
            }
          });

          // Subscribe to wallet transactions
          const subscriptionMsg = {
            type: "SUBSCRIBE_WALLET_TXS",
            data: {
              address: this.testWallet
            }
          };
          
          connection.send(JSON.stringify(subscriptionMsg));
          resolve();
        });

        client.connect(url, 'echo-protocol');
      } catch (error) {
        reject(error);
      }
    });
  }

  private async connectQuickNode(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Extract WebSocket URL from QuickNode endpoint
        let wsUrl = this.quicknodeUrl;
        if (!wsUrl) {
          console.log('⚠️ QuickNode WebSocket URL not provided, skipping QuickNode test');
          resolve();
          return;
        }
        wsUrl = wsUrl.replace('https://', 'wss://').replace('http://', 'ws://');
        this.quicknodeWS = new WebSocket(wsUrl);

        this.quicknodeWS.on('open', () => {
          console.log('⚡ QuickNode WebSocket connected');
          
          // Subscribe to wallet logs
          this.quicknodeWS!.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'logsSubscribe',
            params: [
              {
                mentions: [this.testWallet]
              },
              {
                commitment: 'confirmed'
              }
            ]
          }));

          resolve();
        });

        this.quicknodeWS.on('message', (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString());
            
            // Handle subscription confirmation
            if (message.result) {
              console.log(`⚡ QuickNode subscription ID: ${message.result}`);
            }
            
            // Handle log notifications
            if (message.method === 'logsNotification') {
              this.handleQuickNodeTransaction(message.params);
            }
          } catch (error) {
            console.error('QuickNode message parse error:', error);
          }
        });

        this.quicknodeWS.on('error', (error) => {
          console.error('❌ QuickNode WebSocket error:', error);
          reject(error);
        });

        this.quicknodeWS.on('close', () => {
          console.log('⚡ QuickNode WebSocket closed');
          if (this.isRunning) {
            setTimeout(() => this.connectQuickNode(), 5000);
          }
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  private handleBirdeyeTransaction(data: any): void {
    const signature = data.txHash;
    const detectionTime = Date.now();
    
    if (!this.detectionResults.has(signature)) {
      this.detectionResults.set(signature, { signature });
    }
    
    const result = this.detectionResults.get(signature)!;
    result.birdeyeTime = detectionTime;
    
    console.log(`🦅 [Birdeye] Detected: ${signature.slice(0, 8)}... at ${detectionTime - this.testStartTime}ms`);
    
    this.checkWinner(signature);
  }

  private handleQuickNodeTransaction(params: any): void {
    if (!params?.result?.value?.signature) return;
    const signature = params.result.value.signature;
    const detectionTime = Date.now();
    
    if (!this.detectionResults.has(signature)) {
      this.detectionResults.set(signature, { signature });
    }
    
    const result = this.detectionResults.get(signature)!;
    result.quicknodeTime = detectionTime;
    
    console.log(`⚡ [QuickNode] Detected: ${signature.slice(0, 8)}... at ${detectionTime - this.testStartTime}ms`);
    
    this.checkWinner(signature);
  }

  private checkWinner(signature: string): void {
    const result = this.detectionResults.get(signature);
    if (!result) return;

    // Check if both have detected
    if (result.birdeyeTime && result.quicknodeTime) {
      const diff = result.birdeyeTime - result.quicknodeTime;
      result.difference = Math.abs(diff);
      
      if (Math.abs(diff) < 10) {
        result.winner = 'tie';
        this.stats.ties++;
        console.log(`⏱️  TIE: Both detected within 10ms for ${signature.slice(0, 8)}...`);
      } else if (diff < 0) {
        result.winner = 'birdeye';
        this.stats.birdeyeWins++;
        this.stats.birdeyeFastest = Math.min(this.stats.birdeyeFastest, result.difference);
        console.log(`✅ Birdeye FASTER by ${result.difference}ms for ${signature.slice(0, 8)}...`);
      } else {
        result.winner = 'quicknode';
        this.stats.quicknodeWins++;
        this.stats.quicknodeFastest = Math.min(this.stats.quicknodeFastest, result.difference);
        console.log(`✅ QuickNode FASTER by ${result.difference}ms for ${signature.slice(0, 8)}...`);
      }
      
      this.stats.totalTransactions++;
      this.updateAverageDifference();
      this.printStats();
    }
    
    // Check for missing detections after 5 seconds
    setTimeout(() => {
      const finalResult = this.detectionResults.get(signature);
      if (finalResult) {
        if (finalResult.birdeyeTime && !finalResult.quicknodeTime) {
          this.stats.missingFromQuicknode++;
          console.log(`⚠️  QuickNode MISSED transaction ${signature.slice(0, 8)}...`);
        } else if (!finalResult.birdeyeTime && finalResult.quicknodeTime) {
          this.stats.missingFromBirdeye++;
          console.log(`⚠️  Birdeye MISSED transaction ${signature.slice(0, 8)}...`);
        }
      }
    }, 5000);
  }

  private updateAverageDifference(): void {
    const differences: number[] = [];
    
    for (const result of this.detectionResults.values()) {
      if (result.difference !== undefined) {
        differences.push(result.difference);
      }
    }
    
    if (differences.length > 0) {
      this.stats.avgDifference = differences.reduce((a, b) => a + b, 0) / differences.length;
    }
  }

  private printStats(): void {
    console.log('\\n📊 Current Statistics:');
    console.log(`   Total Transactions: ${this.stats.totalTransactions}`);
    console.log(`   Birdeye Wins: ${this.stats.birdeyeWins} (${this.getPercentage(this.stats.birdeyeWins)}%)`);
    console.log(`   QuickNode Wins: ${this.stats.quicknodeWins} (${this.getPercentage(this.stats.quicknodeWins)}%)`);
    console.log(`   Ties (±10ms): ${this.stats.ties} (${this.getPercentage(this.stats.ties)}%)`);
    console.log(`   Average Difference: ${this.stats.avgDifference.toFixed(2)}ms`);
    
    if (this.stats.birdeyeFastest < Infinity) {
      console.log(`   Birdeye Fastest Win: ${this.stats.birdeyeFastest}ms`);
    }
    if (this.stats.quicknodeFastest < Infinity) {
      console.log(`   QuickNode Fastest Win: ${this.stats.quicknodeFastest}ms`);
    }
    
    if (this.stats.missingFromBirdeye > 0) {
      console.log(`   ⚠️ Missed by Birdeye: ${this.stats.missingFromBirdeye}`);
    }
    if (this.stats.missingFromQuicknode > 0) {
      console.log(`   ⚠️ Missed by QuickNode: ${this.stats.missingFromQuicknode}`);
    }
    
    console.log('');
  }

  private getPercentage(value: number): string {
    if (this.stats.totalTransactions === 0) return '0';
    return ((value / this.stats.totalTransactions) * 100).toFixed(1);
  }

  async runForDuration(minutes: number): Promise<ComparisonStats> {
    await this.start();
    
    console.log(`⏰ Running test for ${minutes} minutes...\\n`);
    
    // Run for specified duration
    await new Promise(resolve => setTimeout(resolve, minutes * 60 * 1000));
    
    await this.stop();
    
    return this.stats;
  }

  async stop(): Promise<void> {
    console.log('\\n🛑 Stopping comparison test...');
    this.isRunning = false;
    
    if (this.birdeyeConnection) {
      this.birdeyeConnection.close();
    }
    
    if (this.quicknodeWS) {
      this.quicknodeWS.close();
    }
    
    console.log('\\n📈 Final Results:');
    this.printStats();
    
    // Determine overall winner
    if (this.stats.birdeyeWins > this.stats.quicknodeWins) {
      console.log(`🏆 WINNER: Birdeye (${this.stats.birdeyeWins} wins vs ${this.stats.quicknodeWins})`);
    } else if (this.stats.quicknodeWins > this.stats.birdeyeWins) {
      console.log(`🏆 WINNER: QuickNode (${this.stats.quicknodeWins} wins vs ${this.stats.birdeyeWins})`);
    } else {
      console.log(`🤝 DRAW: Both services performed equally`);
    }
    
    // Save results to file
    await this.saveResults();
  }

  private async saveResults(): Promise<void> {
    const results = {
      testDate: new Date().toISOString(),
      testLocation: process.env.AWS_INSTANCE || 'local',
      wallet: this.testWallet,
      duration: Date.now() - this.testStartTime,
      stats: this.stats,
      transactions: Array.from(this.detectionResults.values())
    };
    
    const fs = await import('fs').then(m => m.promises);
    const filename = `comparison-results-${Date.now()}.json`;
    
    await fs.writeFile(filename, JSON.stringify(results, null, 2));
    console.log(`\\n💾 Results saved to ${filename}`);
  }
}

// Run the test if executed directly
if (require.main === module) {
  // Convert RPC URL to WebSocket URL if needed
  let quicknodeWs = process.env.QUICKNODE_WS_URL || process.env.QUICKNODE_RPC || '';
  if (quicknodeWs && !quicknodeWs.startsWith('ws')) {
    quicknodeWs = quicknodeWs.replace('https://', 'wss://').replace('http://', 'ws://');
  }
  
  const test = new WalletMonitorComparison(
    process.env.BIRDEYE_API_KEY!,
    quicknodeWs,
    process.env.TEST_WALLET || 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH'
  );
  
  // Run for 5 minutes by default
  const duration = parseInt(process.env.TEST_DURATION || '5');
  
  test.runForDuration(duration).then(() => {
    process.exit(0);
  }).catch((error) => {
    console.error('Test failed:', error);
    process.exit(1);
  });
}