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
    // Use Birdeye API (server-side secret only)
    const birdeyeKey = process.env.BIRDEYE_API_KEY
    if (!birdeyeKey) {
      console.error('Birdeye API key is not configured')
      return NextResponse.json({ error: 'Birdeye API key not configured' }, { status: 500 })
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
    
    // Calculate appropriate time range based on timeframe
    // Load more historical data for better chart visualization
    const timeRangeSeconds: Record<string, number> = {
      '1s': 3600,      // 1 hour of 1s data
      '5s': 7200,      // 2 hours of 5s data
      '15s': 10800,    // 3 hours of 15s data
      '30s': 21600,    // 6 hours of 30s data
      '1m': 86400,     // 24 hours of 1m data
      '3m': 259200,    // 3 days of 3m data
      '5m': 432000,    // 5 days of 5m data
      '15m': 604800,   // 7 days of 15m data
      '30m': 1209600,  // 14 days of 30m data
      '1h': 2592000,   // 30 days of 1h data
      '2h': 5184000,   // 60 days of 2h data
      '4h': 7776000,   // 90 days of 4h data
      '6h': 7776000,   // 90 days of 6h data
      '8h': 7776000,   // 90 days of 8h data
      '12h': 15552000, // 180 days of 12h data
      '1d': 31536000,  // 365 days of 1d data
      '3d': 63072000,  // 2 years of 3d data
      '1w': 94608000   // 3 years of 1w data
    }
    
    const lookbackSeconds = timeRangeSeconds[type] || 86400
    const fromTime = timeFrom || String(Math.floor(Date.now() / 1000) - lookbackSeconds)
    
    // Use the token OHLCV endpoint, not the pair endpoint
    // According to Birdeye docs, /defi/v3/ohlcv is for tokens
    const url = `https://public-api.birdeye.so/defi/v3/ohlcv?address=${token}&type=${birdeyeType}&time_from=${fromTime}&time_to=${timeTo}`
    
    console.log('Birdeye API URL:', url)
    
    const response = await fetch(url, {
      headers: {
        'X-API-KEY': birdeyeKey,
        'x-chain': 'solana',
        'Accept': 'application/json'
      }
    })

    if (!response.ok) {
      console.error('Birdeye API error:', response.status, response.statusText)
      const errorText = await response.text()
      console.error('Error response:', errorText)
      return NextResponse.json({ error: `Birdeye API error: ${response.statusText}` }, { status: response.status })
    }

    const data = await response.json()
    console.log('Birdeye response success:', data.success)
    console.log('Response data structure:', data.data ? Object.keys(data.data) : 'no data object')
    
    // Check if we have data in the expected structure
    if (data.success && data.data) {
      // The OHLCV endpoint returns data in data.data.items array
      const items = data.data.items || []
      
      console.log(`Found ${items.length} candles from Birdeye`)
      
      if (items.length > 0) {
        console.log('First item from Birdeye:', items[0])
        console.log('Item keys:', Object.keys(items[0]))
        
        // Format Birdeye data for TradingView Lightweight Charts
        // Check what field name Birdeye uses for timestamp
        const formattedData = items.map((item: Record<string, unknown>) => {
          // Try different possible field names for timestamp
          const timestamp = item.unixTime || item.unix_time || item.time || item.timestamp || item.t
          
          if (!timestamp) {
            console.warn('No timestamp found in item:', item)
          }
          
          return {
            time: timestamp,
            open: item.o || item.open || 0,
            high: item.h || item.high || 0,
            low: item.l || item.low || 0,
            close: item.c || item.close || 0
          }
        })
        
        // Filter out items without valid timestamps
        const validData = formattedData.filter((item: { time: number }) => item.time && item.time > 0)
        
        console.log(`Returning ${validData.length} valid candles (from ${formattedData.length} total)`)
        if (validData.length > 0) {
          console.log('Sample formatted candle:', validData[0])
        }
        
        return NextResponse.json(validData)
      } else {
        console.log('No items in response. Full response:', JSON.stringify(data, null, 2))
        return NextResponse.json([])
      }
    } else {
      console.log('Unsuccessful or no data from Birdeye')
      console.log('Full response:', JSON.stringify(data, null, 2))
      return NextResponse.json([])
    }
  } catch (error) {
    console.error('Error fetching chart data:', error)
    return NextResponse.json({ error: 'Failed to fetch chart data' }, { status: 500 })
  }
}