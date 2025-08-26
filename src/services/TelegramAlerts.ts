import axios from 'axios';
import { WalletSignal, Position } from '../types/enhanced';

export class TelegramAlerts {
  private botToken: string;
  private chatId: string;
  private enabled: boolean;
  private baseUrl: string;
  private lastMessageTime: number = 0;
  private messageQueue: Array<{text: string, parseMode: string}> = [];
  private isProcessingQueue: boolean = false;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    this.chatId = process.env.TELEGRAM_CHAT_ID || '';
    this.enabled = Boolean(this.botToken && this.chatId);
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
    
    if (this.enabled) {
      console.log('✅ Telegram alerts enabled');
      this.sendMessage('🤖 Copy Trading Bot Started\n\nAlerts are now active!');
    } else {
      console.log('⚠️ Telegram alerts disabled (missing bot token or chat ID)');
    }
  }

  private async sendMessage(text: string, parseMode: string = 'HTML'): Promise<void> {
    if (!this.enabled) return;

    // Add to queue instead of sending immediately
    this.messageQueue.push({ text, parseMode });
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.messageQueue.length === 0) return;
    
    this.isProcessingQueue = true;
    
    while (this.messageQueue.length > 0) {
      const now = Date.now();
      const timeSinceLastMessage = now - this.lastMessageTime;
      
      // Rate limit: max 1 message per 1.5 seconds (Telegram allows ~30/minute)
      if (timeSinceLastMessage < 1500) {
        await new Promise(resolve => setTimeout(resolve, 1500 - timeSinceLastMessage));
      }
      
      const message = this.messageQueue.shift();
      if (!message) break;
      
      try {
        await axios.post(`${this.baseUrl}/sendMessage`, {
          chat_id: this.chatId,
          text: message.text,
          parse_mode: message.parseMode,
          disable_web_page_preview: true
        });
        this.lastMessageTime = Date.now();
      } catch (error: any) {
        if (error.response?.status === 429) {
          // Re-queue the message and wait longer
          this.messageQueue.unshift(message);
          const retryAfter = error.response?.data?.parameters?.retry_after || 5;
          console.log(`Rate limited, waiting ${retryAfter} seconds...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        } else {
          console.error('Failed to send Telegram alert:', error.message);
        }
      }
    }
    
    this.isProcessingQueue = false;
  }

  async sendBuySignal(signal: WalletSignal, position: Position): Promise<void> {
    const message = `
🟢 <b>BUY SIGNAL</b>

💎 <b>Token:</b> ${signal.tokenSymbol || 'Unknown'}
💰 <b>Amount:</b> ${signal.solAmount.toFixed(3)} SOL
💵 <b>Entry Price:</b> $${this.formatPrice(signal.price)}
📊 <b>Market Cap:</b> ${signal.marketCap ? `$${this.formatNumber(signal.marketCap)}` : 'Unknown'}
💧 <b>Liquidity:</b> ${signal.liquidity ? `$${this.formatNumber(signal.liquidity)}` : 'Unknown'}

🔗 <b>TX:</b> <a href="https://solscan.io/tx/${signal.signature}">View on Solscan</a>
📍 <b>Token:</b> <code>${signal.token}</code>

⏰ ${new Date().toLocaleTimeString()}
`;
    
    await this.sendMessage(message);
  }

  async sendSellSignal(signal: WalletSignal, position?: Position): Promise<void> {
    let pnlInfo = '';
    if (position && position.pnl !== undefined) {
      const pnlEmoji = position.pnl >= 0 ? '✅' : '❌';
      pnlInfo = `
${pnlEmoji} <b>P&L:</b> ${position.pnl >= 0 ? '+' : ''}${position.pnl.toFixed(3)} SOL (${position.pnlPercent?.toFixed(1)}%)`;
    }

    const message = `
🔴 <b>SELL SIGNAL</b>

💎 <b>Token:</b> ${signal.tokenSymbol || 'Unknown'}
💰 <b>Amount:</b> ${signal.amount.toFixed(0)} tokens
💵 <b>Exit Price:</b> $${this.formatPrice(signal.price)}
${pnlInfo}

🔗 <b>TX:</b> <a href="https://solscan.io/tx/${signal.signature}">View on Solscan</a>

⏰ ${new Date().toLocaleTimeString()}
`;
    
    await this.sendMessage(message);
  }

  async sendPartialExit(tokenSymbol: string, percentage: number, pnl: number): Promise<void> {
    const pnlEmoji = pnl >= 0 ? '✅' : '❌';
    const message = `
📤 <b>PARTIAL EXIT</b>

💎 <b>Token:</b> ${tokenSymbol}
📊 <b>Exit:</b> ${percentage}% of position
${pnlEmoji} <b>P&L:</b> ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} SOL

⏰ ${new Date().toLocaleTimeString()}
`;
    
    await this.sendMessage(message);
  }

  async sendPositionOpened(position: Position): Promise<void> {
    const message = `
📈 <b>POSITION OPENED</b>

💎 <b>Token:</b> ${position.tokenSymbol || 'Unknown'}
💰 <b>Size:</b> ${position.entryAmount.toFixed(3)} SOL
💵 <b>Entry:</b> $${this.formatPrice(position.entryPrice)}
🎯 <b>Tokens:</b> ${this.formatNumber(position.tokenAmount)}

📍 <b>Mode:</b> ${position.isManual ? 'Manual' : 'Copy Trade'}

⏰ ${new Date().toLocaleTimeString()}
`;
    
    await this.sendMessage(message);
  }

  async sendPositionClosed(position: Position): Promise<void> {
    const pnlEmoji = (position.pnl || 0) >= 0 ? '✅' : '❌';
    const duration = position.exitTime && position.entryTime 
      ? this.formatDuration(position.exitTime - position.entryTime)
      : 'Unknown';

    const message = `
📉 <b>POSITION CLOSED</b>

💎 <b>Token:</b> ${position.tokenSymbol || 'Unknown'}
${pnlEmoji} <b>P&L:</b> ${position.pnl ? `${position.pnl >= 0 ? '+' : ''}${position.pnl.toFixed(3)} SOL (${position.pnlPercent?.toFixed(1)}%)` : 'N/A'}

💵 <b>Entry:</b> $${this.formatPrice(position.entryPrice)}
💵 <b>Exit:</b> $${this.formatPrice(position.exitPrice || 0)}
⏱ <b>Duration:</b> ${duration}

⏰ ${new Date().toLocaleTimeString()}
`;
    
    await this.sendMessage(message);
  }

  async sendDailyReport(stats: {
    dailyPnL: number;
    dailyPnLPercent: number;
    winRate: number;
    totalPositions: number;
    wins: number;
    losses: number;
  }): Promise<void> {
    const pnlEmoji = stats.dailyPnL >= 0 ? '💚' : '💔';
    
    const message = `
📊 <b>DAILY REPORT</b>

${pnlEmoji} <b>Daily P&L:</b> ${stats.dailyPnL >= 0 ? '+' : ''}${stats.dailyPnL.toFixed(3)} SOL (${stats.dailyPnLPercent.toFixed(1)}%)

📈 <b>Win Rate:</b> ${stats.winRate.toFixed(1)}%
✅ <b>Wins:</b> ${stats.wins}
❌ <b>Losses:</b> ${stats.losses}
📝 <b>Total Trades:</b> ${stats.totalPositions}

⏰ ${new Date().toLocaleString()}
`;
    
    await this.sendMessage(message);
  }

  async sendError(error: string): Promise<void> {
    const message = `
⚠️ <b>ERROR</b>

${error}

⏰ ${new Date().toLocaleTimeString()}
`;
    
    await this.sendMessage(message);
  }

  async sendAlert(title: string, message: string): Promise<void> {
    const text = `
🔔 <b>${title}</b>

${message}

⏰ ${new Date().toLocaleTimeString()}
`;
    
    await this.sendMessage(text);
  }

  private formatPrice(price: number): string {
    if (price < 0.00001) return price.toExponential(2);
    if (price < 0.01) return price.toFixed(6);
    if (price < 1) return price.toFixed(4);
    return price.toFixed(2);
  }

  private formatNumber(num: number): string {
    if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
    return num.toFixed(0);
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }
}