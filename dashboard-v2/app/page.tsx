"use client"

import { useEffect, useState, useRef, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { useUser } from "@stackframe/stack"
import { useRouter } from "next/navigation"
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { 
  Settings,
  X,
  GripHorizontal,
  Pause,
  Play,
  ExternalLink,
  Inbox,
  Clock,
  Percent,
  LogOut
} from 'lucide-react'
import { Toaster, toast } from 'sonner'

// Dynamic import for the chart component
const TradingChart = dynamic(() => import('@/components/TradingChart'), {
  ssr: false,
  loading: () => <div className="w-full h-full bg-black" />
})

// Dynamic import for bot control
const BotControl = dynamic(() => import('@/components/BotControl'), {
  ssr: false
})

interface PartialExit {
  id: string
  amount: number
  solReceived: number
  price: number
  tx: string
  timestamp: number
  percentage: number
  reason: string
}

interface Position {
  id: string
  token: string
  tokenSymbol?: string
  poolId?: string
  entryPrice: number
  currentPrice: number
  entryAmount: number
  tokenAmount: number
  initialTokenAmount?: number
  pnl: number
  pnlPercent: number
  status: 'open' | 'partial' | 'closed'
  timestamp?: number
  partialExits?: PartialExit[]
  exitPrice?: number
  exitTime?: number
  entryTime?: number
  traderEntryPrice?: number
  slippage?: number
}

interface TraderTransaction {
  id?: string
  type: 'BUY' | 'SELL'
  token: string
  tokenSymbol: string
  amount: number
  price: number
  timestamp: number
  trader: string
  txHash?: string
}

interface BotStatus {
  isRunning: boolean
  isPaused: boolean
  mode: 'paper' | 'live'
  dailyPnL: number
  dailyPnLPercent: number
  winRate: number
  activePositions: number
  totalPositions: number
  solPrice: number
  slotDifference?: number
}

export default function Home() {
  const user = useUser()
  const router = useRouter()
  const [ws, setWs] = useState<WebSocket | null>(null)
  const [positions, setPositions] = useState<Map<string, Position>>(new Map())
  const [history, setHistory] = useState<Position[]>([])
  const [selectedToken, setSelectedToken] = useState<string | null>(null)
  const [chartData, setChartData] = useState<Array<{ time: number; open: number | string; high: number | string; low: number | string; close: number | string }>>([])
  const [priceFlash, setPriceFlash] = useState<Map<string, 'up' | 'down'>>(new Map())
  const [chartTimeframe, setChartTimeframe] = useState('1s')
  const chartUpdateIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const [botStatus, setBotStatus] = useState<BotStatus>({
    isRunning: false,
    isPaused: false,
    mode: 'paper',
    dailyPnL: 0,
    dailyPnLPercent: 0,
    winRate: 0,
    activePositions: 0,
    totalPositions: 0,
    solPrice: 180,
    slotDifference: undefined
  })
  const [tradeAmount, setTradeAmount] = useState('0.5')
  const [sellPercentage, setSellPercentage] = useState(100)
  const [showSettings, setShowSettings] = useState(false)
  const [traderTransactions, setTraderTransactions] = useState<TraderTransaction[]>([])
  const [flashingTxs, setFlashingTxs] = useState<Set<string>>(new Set())
  const [axiomPools, setAxiomPools] = useState<Map<string, string>>(new Map())

  // Fetch pool address for Axiom links
  const fetchPoolAddress = async (tokenAddress: string) => {
    try {
      const response = await fetch(`/api/pools?token=${tokenAddress}`)
      if (response.ok) {
        const data = await response.json()
        if (data.poolAddress) {
          setAxiomPools(prev => new Map(prev).set(tokenAddress, data.poolAddress))
        }
      }
    } catch (error) {
      console.error('Error fetching pool address:', error)
    }
  }

  // Redirect to login if not authenticated or not whitelisted
  useEffect(() => {
    if (user === null) {
      router.push("/login")
    } else if (user && user.primaryEmail) {
      // Check if user is whitelisted
      const ALLOWED_EMAILS = [
        process.env.NEXT_PUBLIC_ADMIN_EMAIL || "me@adamx.cloud",
        "me@adamx.cloud" // Hardcoded as backup
      ];
      
      if (!ALLOWED_EMAILS.includes(user.primaryEmail)) {
        // Sign out non-whitelisted users
        user.signOut();
        router.push("/login");
      }
    }
  }, [user, router])

  // Typed message handler
  type PositionUpdateData = { type?: 'snapshot' | 'closed'; positions?: Position[]; position?: Position }
  type SignalData = { action: string; token: string; tokenSymbol?: string; amount: number; price: number }
  type PartialExitData = { tokenSymbol: string; percentage: number; solReceived: number }
  type StatsUpdateData = { dailyPnL?: number; dailyPnLPercent?: number; winRate?: number; openPositions?: number; totalPositions?: number; solPrice?: number; slotDifference?: number }

  type IncomingMessage =
    | { type: 'bot_status'; data: BotStatus }
    | { type: 'position_opened'; data: Position }
    | { type: 'position_closed'; data: Position }
    | { type: 'position_update'; data: PositionUpdateData }
    | { type: 'signal'; data: SignalData }
    | { type: 'partial_exit'; data: PartialExitData }
    | { type: 'stats_update'; data: StatsUpdateData }
    | { type: 'trader_transaction'; data: TraderTransaction }
    | { type: 'chart_history'; data: { token: string; candles: Array<{ time: number; open: number | string; high: number | string; low: number | string; close: number | string; volume?: number }>; realTime: boolean } }
    | { type: 'chart_subscribed'; data: { token: string; realTime: boolean; timeframe: string } }
    | { type: 'price_update'; data: { token: string; price: number; timestamp: number; o?: number; h?: number; l?: number; c?: number; v?: number } }
    | { type: 'system_status'; data: Record<string, unknown> }
    | { type: 'log_message'; data: { logs: string[] } }
    | { type: 'bot_control_response'; data: { success: boolean; message: string; command?: string } }

  const selectedTokenRef = useRef<string | null>(null)
  const [botControlData, setBotControlData] = useState<{
    status?: Record<string, unknown>,
    logs?: string[],
    lastResponse?: { success: boolean; message: string; command?: string }
  }>({})
  const [isConnected, setIsConnected] = useState(false)
  
  // Update ref when selectedToken changes
  useEffect(() => {
    selectedTokenRef.current = selectedToken
  }, [selectedToken])
  
  const handleWebSocketMessage = useRef((message: IncomingMessage) => {
    switch (message.type) {
      case 'bot_status':
        setBotStatus(message.data)
        break
      case 'position_opened': {
        const data = message.data
        // Position opened - visual feedback via flash animation instead of toast
        setPositions(prev => new Map(prev).set(data.token, data))
        break
      }
      case 'position_closed': {
        const pos = message.data
        const posPnl = pos.pnl || 0
        const posPnlPercent = pos.pnlPercent || 0
        const pnlSign = posPnl >= 0 ? '+' : ''
        toast[posPnl >= 0 ? 'success' : 'error'](
          `Position closed: ${pos.tokenSymbol || pos.token.substring(0, 8)}`,
          {
            description: `P&L: ${pnlSign}${posPnl.toFixed(4)} SOL (${pnlSign}${posPnlPercent.toFixed(2)}%)`,
            duration: 5000
          }
        )
        setPositions(prev => {
          const newMap = new Map(prev)
          newMap.delete(pos.token)
          return newMap
        })
        setHistory(prev => [pos, ...prev].slice(0, 100))
        break
      }
      case 'position_update': {
        const data = message.data
        if (data.type === 'snapshot' && data.positions) {
          const newPositions = new Map<string, Position>()
          data.positions.forEach((pos: Position) => {
            newPositions.set(pos.token, pos)
          })
          setPositions(newPositions)
        } else if (data.type === 'closed' && data.position) {
          const closedPos = data.position
          const pnl = closedPos.pnl || 0
          const pnlPercent = closedPos.pnlPercent || 0
          const pnlSign = pnl >= 0 ? '+' : ''
          toast[pnl >= 0 ? 'success' : 'error'](
            `Position closed: ${closedPos.tokenSymbol || closedPos.token.substring(0, 8)}`,
            {
              description: `P&L: ${pnlSign}${pnl.toFixed(4)} SOL (${pnlSign}${pnlPercent.toFixed(2)}%)`,
              duration: 5000
            }
          )
          setPositions(prev => {
            const newMap = new Map(prev)
            newMap.delete(closedPos.token)
            return newMap
          })
          setHistory(prev => [closedPos, ...prev].slice(0, 100))
        } else if (data.position) {
          const updatedPos = data.position
          setPositions(prev => {
            const oldPos = prev.get(updatedPos.token)
            // Only flash if price actually changed (not just P&L)
            if (oldPos && oldPos.currentPrice !== updatedPos.currentPrice) {
              const direction = updatedPos.currentPrice > oldPos.currentPrice ? 'up' : 'down'
              setPriceFlash(prev => new Map(prev).set(updatedPos.token, direction))
              setTimeout(() => {
                setPriceFlash(prev => {
                  const newMap = new Map(prev)
                  newMap.delete(updatedPos.token)
                  return newMap
                })
              }, 700)
            }
            const updated = new Map(prev)
            updated.set(updatedPos.token, updatedPos)
            return updated
          })
        }
        break
      }
      case 'signal': {
        // Signal received - visual feedback via flash animation instead of toast
        break
      }
      case 'partial_exit': {
        // Partial exit - visual feedback via flash animation instead of toast
        break
      }
      case 'stats_update': {
        const stats = message.data
        setBotStatus(prev => ({
          ...prev,
          dailyPnL: stats.dailyPnL || 0,
          dailyPnLPercent: stats.dailyPnLPercent || 0,
          winRate: stats.winRate || 0,
          activePositions: stats.openPositions || 0,
          totalPositions: stats.totalPositions || 0,
          solPrice: stats.solPrice || 180,
          slotDifference: stats.slotDifference
        }))
        break
      }
      case 'trader_transaction': {
        const tx = message.data
        // Generate unique ID for this transaction
        const txId = `${tx.timestamp}-${tx.token}-${tx.type}-${tx.txHash || Math.random()}`
        
        setTraderTransactions(prev => {
          // Check for duplicate - same token, type, and timestamp within 100ms
          const isDuplicate = prev.some(existing => 
            existing.token === tx.token &&
            existing.type === tx.type &&
            Math.abs(existing.timestamp - tx.timestamp) < 100
          )
          
          if (isDuplicate) {
            console.log('Skipping duplicate transaction:', tx)
            return prev
          }
          
          // Add new transaction
          const withNew = [{...tx, id: txId}, ...prev]
          
          // Sort by timestamp to handle near-simultaneous trades
          // Transactions within 2 seconds are considered simultaneous
          // and sorted by type (BUY before SELL) for logical ordering
          withNew.sort((a, b) => {
            const timeDiff = b.timestamp - a.timestamp
            if (Math.abs(timeDiff) < 2000) {
              // Within 2 seconds - sort BUY before SELL for same token
              if (a.token === b.token) {
                if (a.type === 'BUY' && b.type === 'SELL') return -1
                if (a.type === 'SELL' && b.type === 'BUY') return 1
              }
            }
            return timeDiff // Otherwise sort by time (newest first)
          })
          
          // Keep only last 20 transactions
          return withNew.slice(0, 20)
        })
        
        // Add to flashing set
        setFlashingTxs(prev => new Set(prev).add(txId))
        
        // Remove from flashing after animation
        setTimeout(() => {
          setFlashingTxs(prev => {
            const next = new Set(prev)
            next.delete(txId)
            return next
          })
        }, 1000)
        
        break
      }
      case 'chart_history': {
        const { token, candles, realTime } = message.data
        console.log(`📊 Received chart_history for ${token}, selectedToken: ${selectedTokenRef.current}, candles:`, candles?.length)
        if (token === selectedTokenRef.current && candles && candles.length > 0) {
          // Ensure candles have proper timestamps
          type RawCandle = {
            time?: number;
            timestamp?: number;
            open?: number | string;
            high?: number | string;
            low?: number | string;
            close?: number | string;
            o?: number | string;
            h?: number | string;
            l?: number | string;
            c?: number | string;
          };
          
          const formattedCandles = (candles as RawCandle[]).map((candle, index) => {
            // Generate proper timestamps regardless of what's provided
            const now = Math.floor(Date.now() / 1000);
            let candleTime: number;
            
            // If we have a proper timestamp, use it
            if (candle.time && candle.time > 1000000000) {
              candleTime = candle.time > 1e10 ? Math.floor(candle.time / 1000) : candle.time;
            } else if (candle.timestamp && candle.timestamp > 1000000000) {
              candleTime = candle.timestamp > 1e10 ? Math.floor(candle.timestamp / 1000) : candle.timestamp;
            } else {
              // Generate timestamps based on index (1 minute intervals)
              candleTime = now - (candles.length - index - 1) * 60;
            }
            
            return {
              time: candleTime,
              open: Number(candle.open || candle.o || 0),
              high: Number(candle.high || candle.h || 0),
              low: Number(candle.low || candle.l || 0),
              close: Number(candle.close || candle.c || 0)
            };
          });
          
          setChartData(formattedCandles)
          console.log(`Set chart data for ${token}: ${formattedCandles.length} candles (realTime: ${realTime})`)
          
          // Also fetch pool address for Axiom link if we don't have it
          if (!axiomPools.has(token)) {
            fetchPoolAddress(token)
          }
        } else if (token === selectedTokenRef.current) {
          console.log(`No chart data available for ${token}`)
          setChartData([])
        }
        break
      }
      case 'chart_subscribed': {
        const { token, realTime, timeframe } = message.data
        console.log(`Subscribed to ${token} chart (${timeframe}, realTime: ${realTime})`)
        break
      }
      case 'price_update': {
        const update = message.data
        if (update.token === selectedTokenRef.current && update.o !== undefined) {
          // This is a candle update for the chart
          setChartData(prev => {
            // Convert timestamp to seconds if needed
            const candleTime = update.timestamp > 1e10 ? 
              Math.floor(update.timestamp / 1000) : update.timestamp
            
            const newCandle = {
              time: candleTime,
              open: update.o || 0,
              high: update.h || 0,
              low: update.l || 0,
              close: update.c || 0
            }
            
            // Add or update the latest candle
            const updated = [...prev]
            const lastIndex = updated.length - 1
            
            // Check if we should update the last candle or add a new one
            if (lastIndex >= 0) {
              const lastCandleTime = updated[lastIndex].time
              // If within the same second, update the existing candle
              if (lastCandleTime === candleTime) {
                updated[lastIndex] = {
                  ...updated[lastIndex],
                  high: Math.max(Number(updated[lastIndex].high), newCandle.high),
                  low: Math.min(Number(updated[lastIndex].low), newCandle.low),
                  close: newCandle.close
                }
              } else if (candleTime > lastCandleTime) {
                // Only add if it's a newer timestamp
                updated.push(newCandle)
                // Keep only last 500 candles
                if (updated.length > 500) {
                  updated.shift()
                }
              }
            } else {
              // First candle
              updated.push(newCandle)
            }
            
            return updated
          })
        }
        break
      }
      case 'system_status':
        setBotControlData(prev => ({ ...prev, status: message.data }))
        break
      case 'log_message':
        setBotControlData(prev => ({ ...prev, logs: message.data.logs }))
        break
      case 'bot_control_response':
        setBotControlData(prev => ({ ...prev, lastResponse: message.data }))
        break
    }
  }).current

  // Initialize WebSocket connection with auto-reconnect
  useEffect(() => {
    // Skip if not authenticated
    if (!user) return;
    
    let websocket: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;
    const reconnectDelay = 3000; // 3 seconds
    let isCleaningUp = false;
    
    const connect = () => {
      // Don't connect if we're cleaning up
      if (isCleaningUp) return;
      // Use NEXT_PUBLIC_WS_URL if available, otherwise construct from parts
      const wsUrl = process.env.NEXT_PUBLIC_WS_URL || (() => {
        const host = process.env.NEXT_PUBLIC_WS_HOST || 'localhost'
        const port = process.env.NEXT_PUBLIC_WS_PORT || '4791'
        // Use ws:// for IP addresses, wss:// for domains with SSL
        const isIP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
        const protocol = process.env.NEXT_PUBLIC_WS_PROTOCOL || (isIP ? 'ws' : 'wss')
        const path = process.env.NEXT_PUBLIC_WS_PATH || '/ws'
        return `${protocol}://${host}:${port}${path}`
      })()
      
      // Add user info to WebSocket connection if available
      const finalUrl = user 
        ? `${wsUrl}?auth=${user.id}&email=${encodeURIComponent(user.primaryEmail || '')}`
        : wsUrl
      
      try {
        websocket = new WebSocket(finalUrl)

        websocket.onopen = () => {
          console.log('Connected to bot WebSocket')
          toast.success('Connected to bot')
          setIsConnected(true)
          reconnectAttempts = 0; // Reset attempts on successful connection
        }

        websocket.onmessage = (event: MessageEvent) => {
          const message = JSON.parse(event.data as string) as IncomingMessage
          handleWebSocketMessage(message)
        }

        websocket.onclose = (event) => {
          console.log('Disconnected from bot', event.code, event.reason)
          setIsConnected(false)
          
          // Only show error if it wasn't a normal closure
          if (event.code !== 1000) {
            toast.error('Disconnected from bot. Reconnecting...')
          }
          
          // Attempt to reconnect
          if (reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            console.log(`Reconnecting... Attempt ${reconnectAttempts}/${maxReconnectAttempts}`)
            reconnectTimeout = setTimeout(connect, reconnectDelay)
          } else {
            toast.error('Failed to connect to bot after multiple attempts')
          }
        }

        websocket.onerror = (error) => {
          console.error('WebSocket error:', error)
        }

        setWs(websocket)
      } catch (error) {
        console.error('Failed to create WebSocket:', error)
        // Retry connection
        if (reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          reconnectTimeout = setTimeout(connect, reconnectDelay)
        }
      }
    }
    
    // Initial connection
    connect();

    return () => {
      isCleaningUp = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout)
      }
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.close(1000, 'Component unmounting') // Normal closure
      }
      // Clear chart update interval
      if (chartUpdateIntervalRef.current) {
        clearInterval(chartUpdateIntervalRef.current)
      }
    }
  }, [user?.id]) // Only reconnect when user ID changes, not on every user object change



  const sendCommand = useCallback((command: string, payload?: Record<string, unknown>) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const message = { type: command, payload }
      console.log('Sending command:', message)
      ws.send(JSON.stringify(message))
    } else {
      console.error('WebSocket not ready:', ws?.readyState)
      toast.error('Connection lost. Please refresh.')
    }
  }, [ws])

  const formatPrice = (price: number) => {
    if (price > 1) return price.toFixed(2)
    if (price > 0.01) return price.toFixed(4)
    return price.toFixed(6)
  }

  const formatPercent = (percent: number | undefined | null) => {
    if (percent === undefined || percent === null || isNaN(percent)) {
      return '0.00%'
    }
    const sign = percent >= 0 ? '+' : ''
    return `${sign}${percent.toFixed(2)}%`
  }

  const formatTime = (timestamp: number) => {
    const now = Date.now()
    const diff = now - timestamp
    if (diff < 60000) return `${Math.floor(diff / 1000)}s`
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`
    return `${Math.floor(diff / 3600000)}h`
  }

  // Function to request live chart data via WebSocket only
  const requestLiveChartData = (token: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log(`Requesting live chart data for ${token}`)
      sendCommand('subscribe_chart', { token, timeframe: chartTimeframe.toLowerCase() })
      // Clear existing data while waiting for new data
      setChartData([])
    } else {
      console.log('WebSocket not ready for chart subscription')
    }
  }

  return (
    <div className="h-screen w-screen text-gray-100 flex overflow-hidden bg-black">
      <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="h-12 border-b border-white/10 bg-black/80 backdrop-blur flex items-center justify-between px-4 relative">
        <div className="flex items-center gap-6">
          <h1 className="text-sm font-semibold tracking-wide text-white">COPY TRADER</h1>
          
          <div className="flex items-center gap-2">
            <Badge variant={botStatus.isRunning ? 'default' : 'secondary'} className="h-5 bg-white/10 border-white/10 text-gray-200">
              {botStatus.isRunning ? 'RUNNING' : 'STOPPED'}
            </Badge>
            <Badge className="h-5 bg-white/10 text-gray-300 border-white/10">
              {botStatus.mode.toUpperCase()}
            </Badge>
          </div>
          
          <Separator orientation="vertical" className="h-6" />
          
          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-gray-500">P&L:</span>
              <span className={botStatus.dailyPnL >= 0 ? 'text-green-400 font-medium' : 'text-red-400 font-medium'}>
                {botStatus.dailyPnL >= 0 ? '+' : ''}{botStatus.dailyPnL.toFixed(4)} SOL
                <span className="text-xs ml-1">
                  ({botStatus.dailyPnLPercent >= 0 ? '+' : ''}{botStatus.dailyPnLPercent?.toFixed(2) || '0.00'}%)
                </span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500">Win Rate:</span>
              <span className="text-green-400">{botStatus.winRate.toFixed(1)}%</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500">SOL:</span>
              <span className="text-gray-300">${botStatus.solPrice?.toFixed(2) || '180.00'}</span>
            </div>
            {botStatus.slotDifference !== undefined && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500">Slot Diff:</span>
                <span className={`${botStatus.slotDifference > 100 ? 'text-yellow-400' : botStatus.slotDifference > 500 ? 'text-red-400' : 'text-green-400'}`}>
                  {botStatus.slotDifference}
                </span>
              </div>
            )}
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {user ? (
            <div className="flex items-center gap-2 mr-2">
              <span className="text-xs text-gray-400">{user.primaryEmail || user.displayName || 'User'}</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-8"
                onClick={() => {
                  user.signOut()
                  router.push("/")
                }}
              >
                <LogOut className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => router.push("/login")}
            >
              Sign In
            </Button>
          )}
          <Separator orientation="vertical" className="h-6" />
          <Button
            size="sm"
            variant={botStatus.isPaused ? 'outline' : 'secondary'}
            className="h-8"
            onClick={() => sendCommand(botStatus.isPaused ? 'resume' : 'pause')}
          >
            {botStatus.isPaused ? <Play className="h-3 w-3 mr-1" /> : <Pause className="h-3 w-3 mr-1" />}
            {botStatus.isPaused ? 'Resume' : 'Pause'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => setShowSettings(true)}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
        {/* removed neon line */}
      </header>

      {/* Removed stat strip per request to keep header compact */}

      {/* Main Content Area with Resizable Panels */}
      <PanelGroup direction="vertical" className="flex-1" autoSaveId="dashboard-v2-vertical">
        <Panel defaultSize={65} minSize={40} className="flex flex-col h-full">
          {/* Chart and Trading Area - Combined in One Panel */}
          <div className="flex flex-1 min-h-0">
            {/* Chart Section - Takes remaining space */}
            <div className="flex-1 flex flex-col min-w-0">
              {/* Chart Header */}
              <div className="h-10 border-b border-white/10 bg-black/60 flex items-center justify-between px-4 shrink-0">
                <div className="flex items-center gap-4">
                  <span className="text-sm font-medium">
                    {selectedToken ? positions.get(selectedToken)?.tokenSymbol || 'Chart' : 'Select a position'}
                  </span>
                  {selectedToken && positions.get(selectedToken) && (
                    <>
                      <span className={`text-lg font-bold transition-colors duration-300 ${
                        (() => {
                          const position = positions.get(selectedToken)!;
                          const isUp = position.currentPrice > position.entryPrice;
                          const isFlashing = priceFlash.get(selectedToken);
                          
                          if (isFlashing === 'up') return 'text-green-400';
                          if (isFlashing === 'down') return 'text-red-400';
                          
                          // Base color on entry price comparison
                          return isUp ? 'text-green-300' : 'text-red-300';
                        })()
                      }`}>
                        ${formatPrice(positions.get(selectedToken)!.currentPrice)}
                      </span>
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${
                          (positions.get(selectedToken)!.pnlPercent || 0) >= 0
                            ? 'text-green-300 bg-green-500/10 border-green-500/30'
                            : 'text-red-300 bg-red-500/10 border-red-500/30'
                        }`}
                      >
                        {formatPercent(positions.get(selectedToken)!.pnlPercent)}
                      </span>
                      <a
                        href={`https://dexscreener.com/solana/${selectedToken}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                        title="View on DexScreener"
                      >
                        <ExternalLink className="h-3 w-3" />
                        DexScreener
                      </a>
                    </>
                  )}
                </div>

                <div className="flex items-center gap-1 flex-wrap">
                  {['1s', '5s', '15s', '30s', '1m', '5m', '15m', '30m', '1h'].map(tf => (
                    <Button
                      key={tf}
                      size="sm"
                      variant={chartTimeframe === tf ? "secondary" : "outline"}
                      className={`h-6 px-1.5 text-[9px] min-w-[28px] ${chartTimeframe === tf ? 'bg-blue-500/20 text-blue-400 border-blue-500/50' : ''}`}
                      onClick={async () => {
                        setChartTimeframe(tf)
                        if (selectedToken && ws && ws.readyState === WebSocket.OPEN) {
                          // Clear current chart data for smooth transition
                          setChartData([])
                          
                          // Unsubscribe from current timeframe
                          ws.send(JSON.stringify({
                            type: 'unsubscribe_chart',
                            payload: { token: selectedToken }
                          }))
                          
                          // Subscribe to new timeframe
                          ws.send(JSON.stringify({
                            type: 'subscribe_chart',
                            payload: {
                              token: selectedToken,
                              timeframe: tf
                            }
                          }))
                          
                          console.log(`Switching to ${tf} timeframe for ${selectedToken}`)
                          // Eagerly fetch history via REST to avoid empty chart while WS warms up
                          requestLiveChartData(selectedToken)
                        } else if (selectedToken) {
                          // Fallback to REST API
                          requestLiveChartData(selectedToken)
                        }
                      }}
                    >
                      {tf.toUpperCase()}
                    </Button>
                  ))}
                </div>
              </div>

              {/* Chart */}
              <div className="flex-1 min-h-0 w-full">
                <TradingChart 
                  data={chartData} 
                  entryPrice={selectedToken && positions.get(selectedToken) ? positions.get(selectedToken)!.entryPrice : undefined}
                  avgExitPrice={selectedToken && positions.get(selectedToken) && positions.get(selectedToken)!.partialExits?.length ? 
                    positions.get(selectedToken)!.partialExits!.reduce((sum, exit) => sum + exit.price, 0) / positions.get(selectedToken)!.partialExits!.length : 
                    undefined
                  }
                  currentPrice={selectedToken && positions.get(selectedToken) ? positions.get(selectedToken)!.currentPrice : undefined}
                />
              </div>
            </div>

            {/* Right Panel - Trading Controls - Fixed Width */}
            <div className="w-[340px] border-l border-white/10 bg-black/50 backdrop-blur flex flex-col">
              <div className="flex items-center justify-between px-4 py-[9.5px] bg-black/70 backdrop-blur border-b border-white/10">
                <h3 className="text-sm font-medium">Trade</h3>
                <Badge className="h-5 text-[10px] bg-white/10 border-white/10 text-gray-300">
                  {botStatus.activePositions} Positions
                </Badge>
              </div>
              <div className="flex flex-col flex-1 p-4 space-y-3 min-h-0">

                <Tabs defaultValue="buy" className="w-full">
                  <TabsList className="grid w-full grid-cols-2 gap-1 h-9 p-0.5 bg-black border border-white/10 rounded-[9px]">
                    <TabsTrigger 
                      value="buy" 
                      className="text-xs font-medium rounded-[6px] text-gray-300 data-[state=active]:bg-green-500/20 data-[state=active]:text-green-400 data-[state=active]:shadow-sm transition-all"
                    >
                      BUY
                    </TabsTrigger>
                    <TabsTrigger 
                      value="sell" 
                      className="text-xs font-medium rounded-[6px] text-gray-300 data-[state=active]:bg-red-500/20 data-[state=active]:text-red-400 data-[state=active]:shadow-sm transition-all"
                    >
                      SELL
                    </TabsTrigger>
                  </TabsList>
                  
                  <TabsContent value="buy" className="space-y-3 mt-3">
                    <div className="space-y-1">
                      <Label className="text-[10px] text-gray-500 uppercase">Amount (SOL)</Label>
                      <Input
                        type="text"
                        className="h-8 bg-black/40 border-white/10 text-xs focus:ring-0 focus-visible:ring-0 focus:border-white/20"
                        value={tradeAmount}
                        onChange={(e) => setTradeAmount(e.target.value)}
                      />
                    </div>

                    <div className="grid grid-cols-4 gap-1">
                      {['0.25', '0.5', '1', '2'].map(amount => (
                        <Button
                          key={amount}
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-[10px] rounded-full border-white/10 bg-black/30 text-gray-300 hover:bg-black/50"
                          onClick={() => setTradeAmount(amount)}
                        >
                          {amount}
                        </Button>
                      ))}
                    </div>

                    <Button
                      size="sm"
                      variant="buy"
                      className="h-10 w-full rounded-full"
                      onClick={() => {
                        if (selectedToken) {
                          sendCommand('manual_buy', { token: selectedToken, amount: parseFloat(tradeAmount) })
                          // Buy order sent - visual feedback via flash animation
                        } else {
                          toast.error('Select a token or position first')
                        }
                      }}
                    >
                      BUY {tradeAmount} SOL
                    </Button>
                  </TabsContent>
                  
                  <TabsContent value="sell" className="space-y-3 mt-3">
                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <Label className="text-[10px] text-gray-500 uppercase">Sell Amount</Label>
                        <span className="text-xs font-bold">{sellPercentage}%</span>
                      </div>
                      <Slider
                        value={[sellPercentage]}
                        onValueChange={(value) => setSellPercentage(value[0])}
                        max={100}
                        min={0}
                        step={5}
                        className="w-full"
                      />
                    </div>

                    <div className="grid grid-cols-4 gap-1">
                      {['25', '50', '75', '100'].map(percent => (
                        <Button
                          key={percent}
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-[10px] rounded-full border-white/10 bg-black/30 text-gray-300 hover:bg-black/50"
                          onClick={() => setSellPercentage(parseInt(percent))}
                        >
                          {percent}%
                        </Button>
                      ))}
                    </div>
                    
                    {selectedToken && positions.get(selectedToken) && (
                      <div className="p-2 bg-black/30 border border-white/10 rounded text-xs text-gray-400 space-y-1">
                        <div className="flex justify-between">
                          <span>Token:</span>
                          <span className="text-gray-300">{positions.get(selectedToken)!.tokenSymbol || selectedToken.substring(0, 8)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Amount:</span>
                          <span className="text-gray-300">{((positions.get(selectedToken)!.tokenAmount * sellPercentage) / 100).toFixed(2)} tokens</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Est. Value:</span>
                          <span className="text-gray-300">{(((positions.get(selectedToken)!.tokenAmount * positions.get(selectedToken)!.currentPrice * sellPercentage) / 100) / (botStatus.solPrice || 180)).toFixed(4)} SOL</span>
                        </div>
                      </div>
                    )}

                    <Button
                      size="sm"
                      variant="sell"
                      className="h-10 w-full rounded-full"
                      onClick={() => {
                        if (selectedToken && positions.get(selectedToken)) {
                          if (sellPercentage === 100) {
                            sendCommand('close_position', { token: selectedToken })
                            // Closing position - visual feedback via flash animation
                          } else {
                            sendCommand('partial_exit', { token: selectedToken, percentage: sellPercentage })
                            // Partial sell - visual feedback via flash animation
                          }
                        } else {
                          toast.error('Select an open position to sell')
                        }
                      }}
                    >
                      SELL {sellPercentage}%
                    </Button>
                  </TabsContent>
                </Tabs>

                <Separator />

                {/* Statistics */}
                <div className="space-y-2">
                  <h4 className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Statistics</h4>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Positions</span>
                      <span>{botStatus.activePositions}/{botStatus.totalPositions}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Win Rate</span>
                      <span className="text-green-400">{botStatus.winRate.toFixed(1)}%</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Daily P&L</span>
                      <span className={botStatus.dailyPnL >= 0 ? 'text-green-400' : 'text-red-400'}>
                        {botStatus.dailyPnL >= 0 ? '+' : ''}{botStatus.dailyPnL.toFixed(3)} SOL
                      </span>
                    </div>
                  </div>
                </div>

                <Separator />

                <Button
                  variant="destructive"
                  className="w-full rounded-full"
                  onClick={() => sendCommand('emergency_stop')}
                >
                  EMERGENCY STOP
                </Button>

                <Separator />

                {/* Trader Transaction History - Full Height */}
                <div className="flex flex-col flex-1 min-h-0">
                  <h4 className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-2">Trader Activity</h4>
                  <div className="flex-1 overflow-y-auto bg-black/30 border border-white/10 rounded p-2">
                    {traderTransactions.length > 0 ? (
                      <div className="space-y-1">
                        {traderTransactions.map((tx, idx) => (
                          <div 
                            key={`${tx.id}-${tx.timestamp}-${idx}`} 
                            className={`
                              flex items-center justify-between text-[10px] py-1 border-b border-white/5 last:border-0
                              ${flashingTxs.has(tx.id || '') ? 
                                (tx.type === 'BUY' ? 'tx-flash-buy' : 'tx-flash-sell') : ''
                              }
                            `}
                          >
                            <div className="flex items-center gap-2">
                              <span className={`font-medium ${tx.type === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>
                                {tx.type}
                              </span>
                              <span className="text-gray-400">{tx.tokenSymbol}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-gray-300">{tx.amount.toFixed(3)} SOL</span>
                              <span className="text-gray-500">{formatTime(tx.timestamp)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex items-center justify-center h-full">
                        <div className="text-center text-[10px] text-gray-500">
                          No recent trader activity
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Panel>
        
        {/* Resize Handle */}
        <PanelResizeHandle className="relative h-1 bg-white/10 hover:bg-white/20 transition-colors">
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex justify-center">
            <GripHorizontal className="h-3 w-8 text-gray-600" />
          </div>
          {/* removed neon-line */}
        </PanelResizeHandle>
        
        {/* Bottom Panel - Positions/Orders/History */}
        <Panel defaultSize={28} minSize={15} className="flex flex-col h-full glass-strong">
          <Tabs defaultValue="positions" className="flex flex-col flex-1 min-h-0">
            <TabsList className="grid w-full grid-cols-4 gap-1 h-9 p-0.5 bg-black border border-white/10 ">
              <TabsTrigger value="positions" className="rounded-[6px] text-[11px] font-medium text-gray-400 data-[state=active]:bg-white/10 data-[state=active]:text-white data-[state=active]:shadow-sm">
                POSITIONS ({botStatus.activePositions})
              </TabsTrigger>
              <TabsTrigger value="orders" className="rounded-[6px] text-[11px] font-medium text-gray-400 data-[state=active]:bg-white/10 data-[state=active]:text-white data-[state=active]:shadow-sm">
                ORDERS
              </TabsTrigger>
              <TabsTrigger value="history" className="rounded-[6px] text-[11px] font-medium text-gray-400 data-[state=active]:bg-white/10 data-[state=active]:text-white data-[state=active]:shadow-sm">
                HISTORY
              </TabsTrigger>
              <TabsTrigger value="control" className="rounded-[6px] text-[11px] font-medium text-gray-400 data-[state=active]:bg-white/10 data-[state=active]:text-white data-[state=active]:shadow-sm">
                BOT CONTROL
              </TabsTrigger>
            </TabsList>
            
            <TabsContent value="positions" className="flex-1 mt-0 p-0 overflow-hidden">
              <ScrollArea className="h-full w-full bg-black">
                <table className="w-full">
                      <thead className="sticky top-0 z-10 bg-black">
                        <tr className="border-b border-white/10">
                          <th className="text-left text-[10px] text-gray-400 uppercase tracking-wider px-3 py-2.5">Token</th>
                          <th className="text-right text-[10px] text-gray-400 uppercase tracking-wider px-3 py-2.5">Entry</th>
                          <th className="text-right text-[10px] text-gray-400 uppercase tracking-wider px-3 py-2.5">Current</th>
                          <th className="text-right text-[10px] text-gray-400 uppercase tracking-wider px-3 py-2.5">Bought</th>
                          <th className="text-right text-[10px] text-gray-400 uppercase tracking-wider px-3 py-2.5">Remaining</th>
                          <th className="text-right text-[10px] text-gray-400 uppercase tracking-wider px-3 py-2.5">P&L</th>
                          <th className="text-center text-[10px] text-gray-400 uppercase tracking-wider px-3 py-2.5">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/10">
                        {Array.from(positions.values()).map(position => (
                          <tr 
                            key={position.token} 
                            className={`cursor-pointer transition-colors hover:bg-black/20 ${
                              selectedToken === position.token ? 'bg-white/5 ring-1 ring-white/10 row-selected' : ''
                            }`}
                            onClick={async () => {
                              setSelectedToken(position.token)
                              
                              // Clear chart data for fresh load
                              setChartData([])
                              
                              // Clear any existing polling
                              if (chartUpdateIntervalRef.current) {
                                clearInterval(chartUpdateIntervalRef.current)
                                chartUpdateIntervalRef.current = null
                              }
                              
                              // Subscribe to WebSocket chart updates
                              if (ws && ws.readyState === WebSocket.OPEN) {
                                // Subscribe to chart data via WebSocket
                                ws.send(JSON.stringify({
                                  type: 'subscribe_chart',
                                  payload: {
                                    token: position.token,
                                    timeframe: chartTimeframe
                                  }
                                }))
                                
                                console.log(`Subscribing to ${position.token} chart (${chartTimeframe})`)
                                // Eagerly fetch history via REST to display immediately
                                requestLiveChartData(position.token)
                              } else {
                                // Fallback to REST API if WebSocket not connected
                                requestLiveChartData(position.token)
                              }
                              
                              // Position selected - visual feedback
                            }}
                          >
                            <td className="px-3 py-2.5 text-xs font-medium">
                              <div className="flex items-center gap-2">
                                <span className="px-2 py-0.5 rounded-full bg-black/40 border border-white/10 text-gray-300">{position.tokenSymbol || position.token.substring(0, 6) + '...'}</span>
                                <a
                                  href={`https://dexscreener.com/solana/${position.token}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-gray-400 hover:text-blue-400 transition-colors"
                                  title={`View on DexScreener (Token: ${position.token.substring(0, 8)}...)`}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                  }}
                                >
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-xs text-right">
                              <span className="text-gray-300">
                                ${formatPrice(position.entryPrice)}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-xs text-right">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full transition-colors ${
                                priceFlash.get(position.token) === 'up' ? 'bg-green-500/10 text-green-400' : 
                                priceFlash.get(position.token) === 'down' ? 'bg-red-500/10 text-red-400' : 'bg-black/30 text-gray-300'
                              }`}>
                                ${formatPrice(position.currentPrice)}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-xs text-right">
                              {(() => {
                                const totalBought = position.initialTokenAmount || 
                                  (position.tokenAmount + (position.partialExits?.reduce((sum, exit) => sum + exit.amount, 0) || 0));
                                return totalBought.toFixed(2);
                              })()}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-right">
                              {(() => {
                                const totalBought = position.initialTokenAmount || 
                                  (position.tokenAmount + (position.partialExits?.reduce((sum, exit) => sum + exit.amount, 0) || 0));
                                const remainingPercent = totalBought > 0 ? (position.tokenAmount / totalBought * 100) : 100;
                                return `${position.tokenAmount.toFixed(2)} (${remainingPercent.toFixed(0)}%)`;
                              })()}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-right">
                              <div className={`inline-flex items-center px-2 py-0.5 rounded-full font-medium ${
                                (position.pnl || 0) >= 0 ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
                              }`}>
                                {(position.pnl || 0) >= 0 ? '+' : ''}{(position.pnl || 0).toFixed(4)}
                              </div>
                              <div className="text-[9px] opacity-80 mt-1">
                                {formatPercent(position.pnlPercent || 0)}
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex gap-1.5 justify-center">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 px-2.5 text-[10px] rounded-full border-white/10 bg-black/30 text-gray-300 hover:bg-black/50"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    sendCommand('partial_exit', { token: position.token, percentage: 50 })
                                  }}
                                >
                                  <Percent className="h-3 w-3 mr-1" />
                                  Exit 50%
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  className="h-6 px-2.5 text-[10px] rounded-full border-transparent bg-red-500/10 text-red-400 hover:bg-red-500/20"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    console.log('Closing position:', position.token)
                                    sendCommand('close_position', { token: position.token })
                                    // Closing position - visual feedback via flash animation
                                  }}
                                >
                                  <X className="h-3 w-3 mr-1" />
                                  Close
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                </table>
                {positions.size === 0 && (
                  <div className="flex items-center justify-center py-10">
                    <div className="text-center">
                      <Inbox className="mx-auto h-6 w-6 text-gray-600" />
                      <div className="mt-2 text-xs text-gray-500">No open positions</div>
                    </div>
                  </div>
                )}
              </ScrollArea>
            </TabsContent>
            
            <TabsContent value="orders" className="flex-1 mt-0 p-0 overflow-hidden">
              <ScrollArea className="h-full w-full bg-black">
                <div className="h-full flex items-center justify-center p-6">
                  <div className="text-center">
                    <Inbox className="mx-auto h-7 w-7 text-gray-600" />
                    <div className="mt-3 text-sm text-gray-300">All clear. No pending orders.</div>
                    <div className="mt-1 text-[11px] text-gray-500">Manual buys and sales will appear here while filling.</div>
                  </div>
                </div>
              </ScrollArea>
            </TabsContent>
            
            <TabsContent value="history" className="flex-1 mt-0 p-0 overflow-hidden">
              <ScrollArea className="h-full w-full bg-black">
                {history.length > 0 ? (
                  <table className="w-full">
                        <thead className="sticky top-0 z-10 bg-black">
                          <tr className="border-b border-white/10">
                            <th className="text-left text-[10px] text-gray-400 uppercase tracking-wider px-3 py-2.5">Token</th>
                            <th className="text-right text-[10px] text-gray-400 uppercase tracking-wider px-3 py-2.5">Entry</th>
                            <th className="text-right text-[10px] text-gray-400 uppercase tracking-wider px-3 py-2.5">Exit</th>
                            <th className="text-right text-[10px] text-gray-400 uppercase tracking-wider px-3 py-2.5">Amount</th>
                            <th className="text-right text-[10px] text-gray-400 uppercase tracking-wider px-3 py-2.5">P&L</th>
                            <th className="text-right text-[10px] text-gray-400 uppercase tracking-wider px-3 py-2.5">Duration</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/10">
                          {history.map((trade, idx) => (
                            <tr key={`${trade.token}-${idx}`}>
                              <td className="px-3 py-2.5 text-xs font-medium">
                                <span className="px-2 py-0.5 rounded-full bg-black/40 border border-white/10 text-gray-300">{trade.tokenSymbol || trade.token.substring(0, 6) + '...'}</span>
                              </td>
                              <td className="px-3 py-2.5 text-xs text-right">
                                ${formatPrice(trade.entryPrice)}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-right">
                                ${formatPrice(trade.exitPrice || trade.currentPrice)}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-right">
                                {trade.entryAmount.toFixed(3)} SOL
                              </td>
                              <td className="px-3 py-2.5 text-xs text-right">
                                <div className={`inline-flex items-center px-2 py-0.5 rounded-full font-medium ${
                                  (trade.pnl || 0) >= 0 ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
                                }`}>
                                  {(trade.pnl || 0) >= 0 ? '+' : ''}{(trade.pnl || 0).toFixed(4)}
                                </div>
                                <div className="text-[9px] opacity-80 mt-1">
                                  {formatPercent(trade.pnlPercent || 0)}
                                </div>
                              </td>
                              <td className="px-3 py-2.5 text-xs text-right text-gray-400">
                                {trade.exitTime && trade.entryTime ? 
                                  `${((trade.exitTime - trade.entryTime) / 60000).toFixed(0)}m` : 
                                  '-'
                                }
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                ) : (
                  <div className="h-full flex items-center justify-center p-6">
                    <div className="text-center">
                      <Clock className="mx-auto h-7 w-7 text-gray-600" />
                      <div className="mt-3 text-sm text-gray-300">No trade history yet</div>
                      <div className="mt-1 text-[11px] text-gray-500">Closed positions will appear here with P&L.</div>
                    </div>
                  </div>
                )}
              </ScrollArea>
            </TabsContent>

            <TabsContent value="control" className="flex-1 mt-0 p-0 overflow-hidden">
              <div className="h-full w-full bg-black p-4">
                <BotControl 
                  sendCommand={(command) => {
                    sendCommand(command.type, command.payload)
                  }}
                  isConnected={isConnected}
                  systemStatus={botControlData.status}
                  logs={botControlData.logs}
                  lastResponse={botControlData.lastResponse}
                />
              </div>
            </TabsContent>
          </Tabs>
        </Panel>
      </PanelGroup>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#12141a] border border-gray-800/50 w-96 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Trade Settings</h3>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                onClick={() => setShowSettings(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            
            <Separator />
            
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-[10px] text-gray-500 uppercase">Position Size (SOL)</Label>
                <Input
                  type="text"
                  className="h-8 bg-[#1a1c24] border-gray-800/50 text-xs"
                  placeholder="0.5"
                />
              </div>
              
              <div className="space-y-1">
                <Label className="text-[10px] text-gray-500 uppercase">Stop Loss %</Label>
                <Input
                  type="text"
                  className="h-8 bg-[#1a1c24] border-gray-800/50 text-xs"
                  placeholder="-20"
                />
              </div>
              
              <div className="space-y-1">
                <Label className="text-[10px] text-gray-500 uppercase">Take Profit %</Label>
                <Input
                  type="text"
                  className="h-8 bg-[#1a1c24] border-gray-800/50 text-xs"
                  placeholder="100"
                />
              </div>
            </div>
            
            <Separator />
            
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                onClick={() => setShowSettings(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="flex-1"
                onClick={() => {
                  // Save settings
                  setShowSettings(false)
                }}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
      
      <Toaster 
        position="top-right" 
        toastOptions={{
          style: {
            background: '#1a1c24',
            color: '#fff',
            border: '1px solid rgba(107, 114, 128, 0.3)'
          },
          className: 'my-toast',
        }}
      />
    </div>
  )
}