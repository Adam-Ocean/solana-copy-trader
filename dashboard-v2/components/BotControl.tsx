'use client'

import { useState, useEffect } from 'react'
import { Play, Square, RotateCcw, FileText, Wifi, WifiOff } from 'lucide-react'

interface BotControlProps {
  sendCommand: (command: { type: string; payload: Record<string, unknown>; timestamp: number }) => void
  isConnected: boolean
  systemStatus?: Record<string, unknown>
  logs?: string[]
  lastResponse?: { success: boolean; message: string; command?: string }
}

interface SystemStatus {
  isRunning: boolean
  status: string
  cpu?: number
  memory?: number
  uptime?: number
  restarts?: number
  mode?: 'paper' | 'live'
  activePositions?: number
  connectedWallets?: number
}

export default function BotControl({ sendCommand, isConnected, systemStatus: propStatus, logs: propLogs, lastResponse }: BotControlProps) {
  const [status, setStatus] = useState<SystemStatus>({
    isRunning: false,
    status: 'unknown'
  })
  const [loading, setLoading] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [logs, setLogs] = useState<string[]>([])

  // Update status when prop changes
  useEffect(() => {
    if (propStatus) {
      setStatus({
        isRunning: propStatus.isRunning as boolean || false,
        status: propStatus.status as string || 'unknown',
        cpu: propStatus.cpu as number,
        memory: propStatus.memory as number,
        uptime: propStatus.uptime as number,
        restarts: propStatus.restarts as number,
        mode: propStatus.mode as 'paper' | 'live',
        activePositions: propStatus.activePositions as number,
        connectedWallets: propStatus.connectedWallets as number
      })
    }
  }, [propStatus])

  // Update logs when prop changes
  useEffect(() => {
    if (propLogs) {
      setLogs(propLogs)
    }
  }, [propLogs])

  // Handle response messages
  useEffect(() => {
    if (lastResponse && lastResponse.success) {
      setLoading(null)
    }
  }, [lastResponse])

  useEffect(() => {
    if (isConnected) {
      // Request initial status only once
      const timer = setTimeout(() => {
        sendCommand({
          type: 'get_status',
          payload: {},
          timestamp: Date.now()
        })
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [isConnected]) // Remove sendCommand from dependencies

  const handleBotAction = async (action: 'start_bot' | 'stop_bot' | 'restart_bot') => {
    setLoading(action)
    sendCommand({
      type: action,
      payload: {},
      timestamp: Date.now()
    })
    
    // Clear loading after 3 seconds
    setTimeout(() => setLoading(null), 3000)
  }

  const toggleLogs = () => {
    if (!showLogs) {
      sendCommand({
        type: 'get_logs',
        payload: {},
        timestamp: Date.now()
      })
    }
    setShowLogs(!showLogs)
  }

  const setTradingMode = (mode: 'paper' | 'live') => {
    sendCommand({
      type: 'set_trading_mode',
      payload: { mode },
      timestamp: Date.now()
    })
  }


  const formatUptime = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)
    
    if (days > 0) return `${days}d ${hours % 24}h`
    if (hours > 0) return `${hours}h ${minutes % 60}m`
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`
    return `${seconds}s`
  }

  const formatMemory = (bytes: number) => {
    const mb = bytes / (1024 * 1024)
    return `${mb.toFixed(1)} MB`
  }

  return (
    <div className="bg-gray-900 rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Bot Control</h2>
        <div className="flex items-center gap-2">
          {isConnected ? (
            <Wifi className="h-4 w-4 text-green-500" />
          ) : (
            <WifiOff className="h-4 w-4 text-red-500" />
          )}
          <span className={`text-xs ${isConnected ? 'text-green-500' : 'text-red-500'}`}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      {/* Status Display */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-gray-800 rounded p-3">
          <div className="text-xs text-gray-400">Status</div>
          <div className={`font-semibold ${
            status.isRunning ? 'text-green-500' : 'text-red-500'
          }`}>
            {status.status.toUpperCase()}
          </div>
        </div>
        
        <div className="bg-gray-800 rounded p-3">
          <div className="text-xs text-gray-400">Mode</div>
          <div className="font-semibold text-white">
            {status.mode?.toUpperCase() || 'N/A'}
          </div>
        </div>
        
        <div className="bg-gray-800 rounded p-3">
          <div className="text-xs text-gray-400">Positions</div>
          <div className="font-semibold text-white">
            {status.activePositions || 0}
          </div>
        </div>
        
        <div className="bg-gray-800 rounded p-3">
          <div className="text-xs text-gray-400">Wallets</div>
          <div className="font-semibold text-white">
            {status.connectedWallets || 0}
          </div>
        </div>

        {status.uptime !== undefined && (
          <div className="bg-gray-800 rounded p-3">
            <div className="text-xs text-gray-400">Uptime</div>
            <div className="font-semibold text-white">
              {formatUptime(status.uptime)}
            </div>
          </div>
        )}

        {status.cpu !== undefined && (
          <div className="bg-gray-800 rounded p-3">
            <div className="text-xs text-gray-400">CPU</div>
            <div className="font-semibold text-white">
              {status.cpu.toFixed(1)}%
            </div>
          </div>
        )}

        {status.memory !== undefined && (
          <div className="bg-gray-800 rounded p-3">
            <div className="text-xs text-gray-400">Memory</div>
            <div className="font-semibold text-white">
              {formatMemory(status.memory)}
            </div>
          </div>
        )}

        {status.restarts !== undefined && (
          <div className="bg-gray-800 rounded p-3">
            <div className="text-xs text-gray-400">Restarts</div>
            <div className="font-semibold text-white">
              {status.restarts}
            </div>
          </div>
        )}
      </div>

      {/* Control Buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => handleBotAction('start_bot')}
          disabled={!isConnected || status.isRunning || loading !== null}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:opacity-50 rounded text-white transition-colors"
        >
          <Play className="h-4 w-4" />
          {loading === 'start_bot' ? 'Starting...' : 'Start'}
        </button>

        <button
          onClick={() => handleBotAction('stop_bot')}
          disabled={!isConnected || !status.isRunning || loading !== null}
          className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 disabled:opacity-50 rounded text-white transition-colors"
        >
          <Square className="h-4 w-4" />
          {loading === 'stop_bot' ? 'Stopping...' : 'Stop'}
        </button>

        <button
          onClick={() => handleBotAction('restart_bot')}
          disabled={!isConnected || !status.isRunning || loading !== null}
          className="flex items-center gap-2 px-4 py-2 bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-700 disabled:opacity-50 rounded text-white transition-colors"
        >
          <RotateCcw className="h-4 w-4" />
          {loading === 'restart_bot' ? 'Restarting...' : 'Restart'}
        </button>

        <button
          onClick={toggleLogs}
          disabled={!isConnected}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:opacity-50 rounded text-white transition-colors"
        >
          <FileText className="h-4 w-4" />
          {showLogs ? 'Hide Logs' : 'Show Logs'}
        </button>
      </div>

      {/* Trading Mode Toggle */}
      <div className="flex items-center gap-4">
        <span className="text-sm text-gray-400">Trading Mode:</span>
        <div className="flex gap-2">
          <button
            onClick={() => setTradingMode('paper')}
            disabled={!isConnected}
            className={`px-3 py-1 rounded text-sm transition-colors ${
              status.mode === 'paper'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            } disabled:opacity-50`}
          >
            Paper
          </button>
          <button
            onClick={() => setTradingMode('live')}
            disabled={!isConnected}
            className={`px-3 py-1 rounded text-sm transition-colors ${
              status.mode === 'live'
                ? 'bg-green-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            } disabled:opacity-50`}
          >
            Live
          </button>
        </div>
      </div>

      {/* Logs Viewer */}
      {showLogs && (
        <div className="mt-4">
          <div className="bg-black rounded p-3 max-h-64 overflow-y-auto">
            <div className="font-mono text-xs text-gray-300 whitespace-pre-wrap">
              {logs.length > 0 ? (
                logs.map((log, i) => (
                  <div key={i} className="hover:bg-gray-900 px-1">
                    {log}
                  </div>
                ))
              ) : (
                <div className="text-gray-500">No logs available</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}