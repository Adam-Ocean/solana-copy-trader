import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const token = searchParams.get('token')
  const type = searchParams.get('type') || '1m'
  const timeFrom = searchParams.get('time_from')
  const timeTo = searchParams.get('time_to') || String(Math.floor(Date.now() / 1000))

  if (!token) {
    return NextResponse.json({ error: 'Token address required' }, { status: 400 })
  }

  try {
    // Try Birdeye first (server-side secret only)
    const birdeyeKey = process.env.BIRDEYE_API_KEY
    if (!birdeyeKey) {
      console.error('Birdeye API key is not configured on the server')
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
    }
    
    console.log(`Fetching chart from Birdeye for token: ${token}, type: ${type}`)
    
    // Map type to Birdeye v3 format (pass seconds through for chains that support it)
    const typeMap: Record<string, string> = {
      '1s': '1s',
      '5s': '5s',
      '15s': '15s',
      '30s': '30s',
      '1m': '1m',
      '3m': '3m',
      '5m': '5m',
      '15m': '15m',
      '30m': '30m',
      '1h': '1H',
      '2h': '2H',
      '4h': '4H',
      '6h': '6H',
      '8h': '8H',
      '12h': '12H',
      '1d': '1D',
      '3d': '3D',
      '1w': '1W'
    }
    
    const birdeyeType = typeMap[type] || '1m'
    const fromTime = timeFrom || String(Math.floor(Date.now() / 1000) - 7200)
    // v3 endpoint provides better availability
    const url = `https://public-api.birdeye.so/defi/v3/ohlcv?address=${token}&type=${birdeyeType}&time_from=${fromTime}&time_to=${timeTo}`
    
    const response = await fetch(url, {
      headers: {
        'X-API-KEY': birdeyeKey,
        'x-chain': 'solana',
        'Accept': 'application/json'
      }
    })

    if (response.ok) {
      const data: { success?: boolean; data?: { items?: Array<{ unixTime: number; o: number; h: number; l: number; c: number }> } } = await response.json()
      console.log(`Birdeye response:`, data.success ? 'success' : 'failed')
      
      if (data.data?.items && data.data.items.length > 0) {
        // Format Birdeye data for TradingView Lightweight Charts
        const formattedData = data.data.items.map((item) => ({
          time: item.unixTime,
          open: item.o,
          high: item.h,
          low: item.l,
          close: item.c
        }))
        
        console.log(`Returning ${formattedData.length} candles from Birdeye`)
        return NextResponse.json(formattedData)
      }
    }
    
    // Fallback to SolanaTracker if Birdeye fails
    console.log('Birdeye failed, falling back to SolanaTracker')
    
    try {
      // Dynamic import to avoid build errors if package is not installed
      const { Client } = await import('@solana-tracker/data-api')
      
      const client = new Client({
        apiKey: 'st_edYS78K6-qYDNbM2igi_-'
      })

      const chartData = await client.getChartData({
        tokenAddress: token,
        type: type,
        timeFrom: timeFrom ? parseInt(timeFrom) : Math.floor(Date.now() / 1000) - 7200,
        timeTo: parseInt(timeTo),
        marketCap: false,
        removeOutliers: true,
        dynamicPools: true,
        timezone: 'current',
        fastCache: true
      })

      if (chartData?.oclhv?.length > 0) {
        // SolanaTracker data structure might vary - log it to debug
        console.log('SolanaTracker raw data sample:', chartData.oclhv[0])
        
        const formattedData = chartData.oclhv.map((candle, index: number) => {
          // Ensure we have a timestamp - use index-based time if missing
          const timestamp = candle.time || (Math.floor(Date.now() / 1000) - (chartData.oclhv.length - index) * 60)
          
          return {
            time: timestamp,
            open: candle.open || 0,
            high: candle.high || 0,
            low: candle.low || 0,
            close: candle.close || 0
          }
        })
        
        console.log(`Returning ${formattedData.length} candles from SolanaTracker`)
        console.log('Sample formatted candle:', formattedData[0])
        return NextResponse.json(formattedData)
      }
    } catch (fallbackError) {
      console.error('SolanaTracker fallback also failed:', fallbackError)
    }
    
    // Return empty array if both fail
    return NextResponse.json([])
  } catch (error) {
    console.error('Error fetching chart data:', error)
    return NextResponse.json({ error: 'Failed to fetch chart data' }, { status: 500 })
  }
}