// Birdeye WebSocket handler for real-time price updates
export interface BirdeyePriceUpdate {
  type: 'price'
  data: {
    address: string
    price: number
    updateUnixTime: number
    updateHumanTime: string
  }
}

export interface CandleUpdate {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export class BirdeyeWebSocket {
  private ws: WebSocket | null = null
  private apiKey: string
  private subscriptions: Map<string, string> = new Map() // token -> chartType
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000
  private pingInterval: NodeJS.Timeout | null = null
  private onPriceUpdate: ((token: string, price: number, timestamp: number) => void) | null = null
  private isConnecting = false
  private currentChartType: string = '1m'

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  connect(onPriceUpdate: (token: string, price: number, timestamp: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        console.log('Birdeye WebSocket already connected')
        resolve()
        return
      }

      if (this.isConnecting) {
        console.log('Birdeye WebSocket connection already in progress')
        resolve()
        return
      }

      this.isConnecting = true
      this.onPriceUpdate = onPriceUpdate

      try {
        // Birdeye WebSocket endpoint with chain specified
        const wsUrl = `wss://public-api.birdeye.so/socket/solana?x-api-key=${this.apiKey}`
        console.log('Connecting to Birdeye WebSocket')
        
        // Browser WebSocket API doesn't support protocols the same way as Node.js
        // Try with 'echo-protocol' as shown in their example
        this.ws = new WebSocket(wsUrl, 'echo-protocol')

        this.ws.onopen = () => {
          console.log('Birdeye WebSocket connected')
          this.isConnecting = false
          this.reconnectAttempts = 0
          
          // Start ping interval to keep connection alive
          this.startPing()
          
          // Don't subscribe immediately - wait for messages to confirm connection
          // Resubscriptions will happen after we know the format is correct
          
          resolve()
        }

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data)
            this.handleMessage(message)
          } catch (error) {
            console.error('Error parsing Birdeye WebSocket message:', error)
          }
        }

        this.ws.onerror = (error) => {
          console.error('Birdeye WebSocket error:', error)
          this.isConnecting = false
          
          // Don't reject on error, just log it
          // WebSocket errors don't prevent the chart from working (fallback to polling)
          console.warn('Birdeye WebSocket failed to connect, falling back to polling')
          resolve()
        }

        this.ws.onclose = (event) => {
          console.log('Birdeye WebSocket closed:', event.code, event.reason)
          this.isConnecting = false
          this.stopPing()
          
          // Attempt to reconnect
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnect()
          }
        }
      } catch (error) {
        this.isConnecting = false
        console.error('Failed to create Birdeye WebSocket:', error)
        // Don't reject, just resolve so the app continues working with polling
        resolve()
      }
    })
  }

  private handleMessage(message: Record<string, unknown>) {
    console.log('Birdeye WebSocket message:', message)
    
    // Handle WELCOME message first
    if (message.type === 'WELCOME') {
      console.log('Birdeye connection welcomed, can now subscribe')
      // Now safe to resubscribe to previous subscriptions
      this.subscriptions.forEach((chartType, token) => {
        this.subscribeToToken(token, chartType)
      })
      return
    }
    
    // Handle different message types from Birdeye
    // Based on the example, messages come as:
    // For OHLCV: { type: 'PRICE_DATA', data: {...} }
    // For transactions: { type: 'TXS_DATA', data: {...} }
    
    if (message.type === 'PRICE_DATA') {
      // Price/OHLCV update message
      const data = message.data as Record<string, unknown> | undefined
      if (data && this.onPriceUpdate) {
        // Extract token address and price from the OHLCV data
        const token = (data.address || data.mint) as string | undefined
        
        // For OHLCV data, we get open, high, low, close
        // Use the close price as the current price
        const price = (data.c || data.close || data.price || data.value) as number | undefined
        const timestamp = (data.unixTime || data.unix_time || data.t) as number | undefined || Math.floor(Date.now() / 1000)
        
        if (token && price !== undefined && price !== null) {
          console.log(`Price update for ${token}: ${price} at ${timestamp}`)
          this.onPriceUpdate(token, price, timestamp)
        } else {
          console.warn('Missing token or price in PRICE_DATA:', { token, price })
        }
      }
    } else if (message.type === 'SUBSCRIBE_PRICE_DATA') {
      console.log('Subscribed to price updates:', message)
    } else if (message.type === 'UNSUBSCRIBE_PRICE_DATA') {
      console.log('Unsubscribed from price updates:', message)
    } else if (message.type === 'ERROR') {
      console.error('Birdeye WebSocket error message:', message)
    }
  }

  setChartType(chartType: string) {
    // Map our timeframe format to Birdeye's chartType format
    const chartTypeMap: Record<string, string> = {
      '1s': '1s',
      '15s': '15s',
      '30s': '30s',
      '1m': '1m',
      '5m': '5m',
      '15m': '15m',
      '1h': '1h'
    }
    this.currentChartType = chartTypeMap[chartType] || '1m'
  }

  subscribeToToken(token: string, chartType?: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('Cannot subscribe - WebSocket not connected')
      return
    }

    // Use provided chartType or current one
    const type = chartType || this.currentChartType

    // Add to subscriptions map
    this.subscriptions.set(token, type)

    // Send subscription message in Birdeye's format
    const subscribeMsg = {
      type: 'SUBSCRIBE_PRICE',
      data: {
        chartType: type,
        currency: 'usd',
        address: token
      }
    }

    console.log('Subscribing to Birdeye price updates for:', token, 'with chartType:', type)
    this.ws.send(JSON.stringify(subscribeMsg))
  }

  unsubscribeFromToken(token: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }

    // Remove from subscriptions map
    this.subscriptions.delete(token)

    // Send unsubscribe message
    const unsubscribeMsg = {
      type: 'UNSUBSCRIBE_PRICE'
    }

    console.log('Unsubscribing from Birdeye price updates for:', token)
    this.ws.send(JSON.stringify(unsubscribeMsg))
  }

  private startPing() {
    // Send ping every 30 seconds to keep connection alive
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Birdeye might use a different ping format
        this.ws.send(JSON.stringify({ type: 'PING' }))
      }
    }, 30000)
  }

  private stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  private reconnect() {
    this.reconnectAttempts++
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)
    
    console.log(`Attempting to reconnect to Birdeye WebSocket in ${delay}ms (attempt ${this.reconnectAttempts})`)
    
    setTimeout(() => {
      if (this.onPriceUpdate) {
        this.connect(this.onPriceUpdate).catch(console.error)
      }
    }, delay)
  }

  disconnect() {
    this.stopPing()
    this.subscriptions.clear()
    
    if (this.ws) {
      // Send unsubscribe before closing
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'UNSUBSCRIBE_PRICE' }))
      }
      this.ws.close()
      this.ws = null
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

// Candle aggregation helper
export class CandleAggregator {
  private currentCandle: CandleUpdate | null = null
  private timeframe: string
  private intervalSeconds: number

  constructor(timeframe: string) {
    this.timeframe = timeframe
    this.intervalSeconds = this.getIntervalSeconds(timeframe)
  }

  private getIntervalSeconds(timeframe: string): number {
    const intervals: Record<string, number> = {
      '1s': 1,
      '15s': 15,
      '30s': 30,
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '1h': 3600
    }
    return intervals[timeframe] || 60
  }

  // Get the start time of the current candle period
  private getCandleStartTime(timestamp: number): number {
    return Math.floor(timestamp / this.intervalSeconds) * this.intervalSeconds
  }

  // Update candle with new price data
  updatePrice(price: number, timestamp: number): { candle: CandleUpdate, isNew: boolean } | null {
    const candleStartTime = this.getCandleStartTime(timestamp)
    
    if (!this.currentCandle || this.currentCandle.time !== candleStartTime) {
      // Start a new candle
      const isNew = this.currentCandle !== null
      this.currentCandle = {
        time: candleStartTime,
        open: price,
        high: price,
        low: price,
        close: price
      }
      return { candle: { ...this.currentCandle }, isNew }
    } else {
      // Update existing candle
      this.currentCandle.high = Math.max(this.currentCandle.high, price)
      this.currentCandle.low = Math.min(this.currentCandle.low, price)
      this.currentCandle.close = price
      return { candle: { ...this.currentCandle }, isNew: false }
    }
  }

  // Get current candle
  getCurrentCandle(): CandleUpdate | null {
    return this.currentCandle ? { ...this.currentCandle } : null
  }

  // Reset aggregator
  reset() {
    this.currentCandle = null
  }
}