import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const token = searchParams.get('token')
  
  if (!token) {
    return NextResponse.json({ error: 'Token address required' }, { status: 400 })
  }

  try {
    const birdeyeKey = process.env.BIRDEYE_API_KEY
    if (!birdeyeKey) {
      console.error('Birdeye API key is not configured')
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
    }
    
    // Get token overview which includes pool information
    const url = `https://public-api.birdeye.so/defi/v2/tokens/info?address=${token}`
    
    const response = await fetch(url, {
      headers: {
        'X-API-KEY': birdeyeKey,
        'x-chain': 'solana',
        'Accept': 'application/json'
      }
    })

    if (response.ok) {
      const data = await response.json()
      
      // Try to find Axiom pool or any pool
      let axiomPool = null
      let primaryPool = null
      
      // Check if we have pool data
      if (data.data?.pools && Array.isArray(data.data.pools)) {
        // Look for Axiom pool specifically
        for (const pool of data.data.pools) {
          if (pool.source?.toLowerCase().includes('axiom')) {
            axiomPool = pool.address || pool.poolAddress
            break
          }
        }
        
        // If no Axiom pool, get the primary pool (usually highest liquidity)
        if (!axiomPool && data.data.pools.length > 0) {
          primaryPool = data.data.pools[0].address || data.data.pools[0].poolAddress
        }
      }
      
      // Alternative: Try markets endpoint
      if (!axiomPool && !primaryPool) {
        const marketsUrl = `https://public-api.birdeye.so/defi/v2/markets?address=${token}`
        const marketsResponse = await fetch(marketsUrl, {
          headers: {
            'X-API-KEY': birdeyeKey,
            'x-chain': 'solana',
            'Accept': 'application/json'
          }
        })
        
        if (marketsResponse.ok) {
          const marketsData = await marketsResponse.json()
          if (marketsData.data?.items && Array.isArray(marketsData.data.items)) {
            for (const market of marketsData.data.items) {
              // Check for Axiom markets
              if (market.source?.toLowerCase().includes('axiom') || 
                  market.dexId?.toLowerCase().includes('axiom')) {
                axiomPool = market.address || market.marketAddress
                break
              }
            }
            
            // Fallback to first market
            if (!axiomPool && marketsData.data.items.length > 0) {
              primaryPool = marketsData.data.items[0].address || marketsData.data.items[0].marketAddress
            }
          }
        }
      }
      
      return NextResponse.json({
        token,
        axiomPool,
        primaryPool: axiomPool || primaryPool,
        pools: data.data?.pools || []
      })
    }
    
    return NextResponse.json({ 
      error: 'Failed to fetch pool data',
      token,
      axiomPool: null,
      primaryPool: null 
    }, { status: 404 })
    
  } catch (error) {
    console.error('Error fetching pool data:', error)
    return NextResponse.json({ error: 'Failed to fetch pool data' }, { status: 500 })
  }
}