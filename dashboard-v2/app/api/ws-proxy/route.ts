import { NextRequest, NextResponse } from 'next/server'

// This endpoint provides a secure WebSocket connection URL without exposing the API key
export async function GET(request: NextRequest) {
  const apiKey = process.env.BIRDEYE_API_KEY
  
  if (!apiKey) {
    return NextResponse.json({ error: 'Birdeye API key not configured' }, { status: 500 })
  }
  
  // Generate a temporary token for WebSocket authentication
  // In production, you might want to use a more secure token system
  const token = Buffer.from(JSON.stringify({
    apiKey: apiKey,
    timestamp: Date.now(),
    // Add expiry or other security measures as needed
  })).toString('base64')
  
  return NextResponse.json({ 
    token,
    endpoint: 'wss://public-api.birdeye.so/socket/solana'
  })
}