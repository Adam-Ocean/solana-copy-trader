"use client"

import { useEffect, useRef, useState } from 'react'
import type { IChartApi, ISeriesApi, CandlestickData, Time } from 'lightweight-charts'

interface TradingChartProps {
  data?: Array<{ time: number; open: number | string; high: number | string; low: number | string; close: number | string }>
  entryPrice?: number
  avgExitPrice?: number
  currentPrice?: number
  onLoadMore?: () => void
}

type PriceLineHandle = ReturnType<NonNullable<ISeriesApi<'Candlestick'>['createPriceLine']>>

export default function TradingChart({ data = [], entryPrice, avgExitPrice, currentPrice }: TradingChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const entryLineRef = useRef<PriceLineHandle | null>(null)
  const exitLineRef = useRef<PriceLineHandle | null>(null)
  const [isChartReady, setIsChartReady] = useState(false)
  const hasUserInteractedRef = useRef(false)
  const isInitialLoadRef = useRef(true)

  // Initialize chart once
  useEffect(() => {
    if (!chartContainerRef.current || chartRef.current) return

    const initChart = async () => {
      try {
        console.log('Initializing chart...')
        
        // Dynamic import to avoid SSR issues
        const LightweightCharts = await import('lightweight-charts')
        
        // Create chart
        const chart = LightweightCharts.createChart(chartContainerRef.current!, {
          layout: {
            background: {
              type: LightweightCharts.ColorType.Solid,
              color: '#000000'
            },
            textColor: '#c7ced8',
          },
          grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
          },
          width: chartContainerRef.current!.clientWidth,
          height: chartContainerRef.current!.clientHeight || 500,
          timeScale: {
            borderColor: 'rgba(255, 255, 255, 0.1)',
            timeVisible: true,
            secondsVisible: true,  // Show seconds for 1s candles
            rightOffset: 12,  // Add 40px worth of candles padding on the right
            barSpacing: 10,   // Better spacing to prevent squishing
            minBarSpacing: 2,  // Minimum spacing between bars
            fixLeftEdge: false,  // Allow scrolling left
            fixRightEdge: false,  // Allow scrolling right
            lockVisibleTimeRangeOnResize: true,
            rightBarStaysOnScroll: false,  // Don't auto-scroll when new data comes
            shiftVisibleRangeOnNewBar: false  // Don't shift view when new bar appears
          },
          handleScroll: {
            mouseWheel: true,
            pressedMouseMove: true,
            horzTouchDrag: true,
            vertTouchDrag: false
          },
          handleScale: {
            axisPressedMouseMove: true,
            mouseWheel: true,
            pinch: true
          },
          rightPriceScale: {
            borderColor: 'rgba(255, 255, 255, 0.06)',
            autoScale: true,
            scaleMargins: {
              top: 0.1,
              bottom: 0.1,
            },
          },
          crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
          },
        })

        // Add candlestick series using v5 API
        console.log('Adding candlestick series...')
        const candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
          upColor: 'rgba(59,130,246,0.9)',        // blue-500 body
          downColor: 'rgba(239,68,68,0.9)',       // red-500 body
          borderUpColor: 'rgba(96,165,250,1)',    // blue-400 border
          borderDownColor: 'rgba(239,68,68,1)',   // red-500 border
          wickUpColor: 'rgba(147,197,253,0.9)',   // blue-300 wick
          wickDownColor: 'rgba(239,68,68,0.9)',   // red-500 wick
          priceFormat: {
            type: 'price',
            precision: 8,
            minMove: 0.00000001,
          },
        })
        console.log('Candlestick series created')

        chartRef.current = chart
        seriesRef.current = candleSeries
        
        // Track user interactions with the chart
        chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
          // If this change wasn't triggered by our code, it means the user interacted
          if (!isInitialLoadRef.current) {
            hasUserInteractedRef.current = true
          }
        })
        
        // Reset interaction flag when clicking on chart
        chart.subscribeCrosshairMove(() => {
          // User is interacting with the chart
          if (!isInitialLoadRef.current) {
            hasUserInteractedRef.current = true
          }
        })
        
        // Handle resize
        const handleResize = () => {
          if (chartContainerRef.current && chart) {
            chart.applyOptions({
              width: chartContainerRef.current.clientWidth,
              height: chartContainerRef.current.clientHeight || 500,
            })
          }
        }

        // Use ResizeObserver for container size changes
        const resizeObserver = new ResizeObserver(handleResize)
        resizeObserver.observe(chartContainerRef.current!)

        // Also listen to window resize as fallback
        window.addEventListener('resize', handleResize)

        setIsChartReady(true)
        console.log('Chart initialization complete')

        // Return cleanup function
        return () => {
          window.removeEventListener('resize', handleResize)
          resizeObserver.disconnect()
          chart.remove()
        }
      } catch (error) {
        console.error('Failed to initialize chart:', error)
      }
    }

    const cleanup = initChart()
    
    return () => {
      cleanup.then(cleanupFn => cleanupFn && cleanupFn())
    }
  }, [])

  // Update data whenever it changes
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) {
      console.log('Chart not ready for data update')
      return
    }

    if (data && data.length > 0) {
      console.log(`Updating chart with ${data.length} candles`)
      
      try {
        // Format data for TradingView - filter out invalid entries
        const formattedData: CandlestickData[] = data
          .filter((candle: { time: number; open: number | string; high: number | string; low: number | string; close: number | string }, index: number) => {
            // Validate candle has required fields and valid timestamp
            const t = candle && typeof candle.time === 'number' ? candle.time : NaN
            const o = parseFloat(String(candle.open))
            const h = parseFloat(String(candle.high))
            const l = parseFloat(String(candle.low))
            const c = parseFloat(String(candle.close))
            
            // Debug first candle that fails
            if (index === 0) {
              console.log('First candle validation:', {
                candle,
                t, o, h, l, c,
                isValidTime: Number.isFinite(t) && t > 0 && t < 1e12,
                isValidOHLC: Number.isFinite(o) && Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c)
              })
            }
            
            return (
              Number.isFinite(t) && t > 0 && t < 1e12 &&
              Number.isFinite(o) && Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c)
            )
          })
          .map(candle => ({
            time: (candle.time > 1e10 ? 
              Math.floor(candle.time / 1000) : candle.time) as Time,
            open: parseFloat(String(candle.open)),
            high: parseFloat(String(candle.high)),
            low: parseFloat(String(candle.low)),
            close: parseFloat(String(candle.close))
          }))
        
        // Sort by time and remove duplicates
        formattedData.sort((a, b) => (a.time as number) - (b.time as number))
        
        // Remove duplicate timestamps (keep the latest one)
        const uniqueData: CandlestickData[] = []
        const seenTimes = new Set<number>()
        
        for (let i = formattedData.length - 1; i >= 0; i--) {
          const time = formattedData[i].time as number
          if (!seenTimes.has(time)) {
            uniqueData.unshift(formattedData[i])
            seenTimes.add(time)
          }
        }
        
        console.log(`Chart data: ${uniqueData.length} unique candles from ${data.length} total`)
        
        // Only set data if we have valid candles
        if (uniqueData.length > 0) {
          seriesRef.current.setData(uniqueData)
          
          // Only auto-adjust visible range if user hasn't interacted with the chart
          // or if this is the initial load
          if (!hasUserInteractedRef.current || isInitialLoadRef.current) {
            // Set visible range based on data length
            // Show fewer candles initially to prevent them from appearing too large
            let visibleCandles = 50 // Default to show 50 candles
            
            // Adjust based on data length
            if (uniqueData.length < 20) {
              visibleCandles = uniqueData.length
            } else if (uniqueData.length < 50) {
              visibleCandles = 30
            } else if (uniqueData.length < 100) {
              visibleCandles = 50
            } else {
              visibleCandles = 80
            }
            
            const lastCandle = uniqueData[uniqueData.length - 1]
            const firstVisibleIndex = Math.max(0, uniqueData.length - visibleCandles)
            const firstVisibleCandle = uniqueData[firstVisibleIndex]
            
            if (firstVisibleCandle && lastCandle) {
              // Add more padding to the right for incoming candles
              const timeRange = (lastCandle.time as number) - (firstVisibleCandle.time as number)
              const padding = timeRange * 0.4 // 40% padding for more space on right (increased from 25%)
              
              // Use setTimeout to ensure chart is fully rendered before setting range
              setTimeout(() => {
                if (chartRef.current && (!hasUserInteractedRef.current || isInitialLoadRef.current)) {
                  chartRef.current.timeScale().setVisibleRange({
                    from: firstVisibleCandle.time as Time,
                    to: ((lastCandle.time as number) + padding) as Time
                  })
                  // Mark initial load as complete
                  isInitialLoadRef.current = false
                }
              }, 100)
            }
          }
        } else {
          console.warn('No valid candles to display after filtering')
          seriesRef.current.setData([])
        }
        
        console.log('Chart data updated successfully')
      } catch (error) {
        console.error('Error updating chart:', error)
      }
    } else {
      console.log('No data to display')
      if (seriesRef.current) {
        seriesRef.current.setData([])
      }
    }
  }, [data])

  // Update price lines when entry/exit prices change
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return

    // Remove existing lines
    if (entryLineRef.current) {
      seriesRef.current.removePriceLine(entryLineRef.current)
      entryLineRef.current = null
    }
    if (exitLineRef.current) {
      seriesRef.current.removePriceLine(exitLineRef.current)
      exitLineRef.current = null
    }

    // Add entry price line
    if (entryPrice && entryPrice > 0) {
      console.log('Adding entry price line at:', entryPrice)
      entryLineRef.current = seriesRef.current.createPriceLine({
        price: entryPrice,
        color: '#2962FF',
        lineWidth: 2,
        lineStyle: 2, // Dashed line
        axisLabelVisible: true,
        title: 'Entry',
      })
    }

    // Add average exit price line
    if (avgExitPrice && avgExitPrice > 0) {
      console.log('Adding avg exit price line at:', avgExitPrice)
      exitLineRef.current = seriesRef.current.createPriceLine({
        price: avgExitPrice,
        color: '#FFA726',
        lineWidth: 2,
        lineStyle: 2, // Dashed line
        axisLabelVisible: true,
        title: 'Avg Exit',
      })
    }
  }, [entryPrice, avgExitPrice, isChartReady])

  // Update the last candle when current price changes (real-time update)
  useEffect(() => {
    if (!seriesRef.current || !currentPrice || !data || data.length === 0) return

    try {
      // Get the last candle from our data
      const lastCandle = data[data.length - 1]
      if (!lastCandle || typeof lastCandle.time !== 'number' || !isFinite(Number(lastCandle.time))) {
        // No valid time on the last candle; skip update to avoid businessDay.year errors
        return
      }

      // Only update if price has actually changed significantly
      const priceDiff = Math.abs(currentPrice - parseFloat(String(lastCandle.close)))
      if (priceDiff < 0.00000001) return

      // Format the time properly
      const rawTime = lastCandle.time as number
      const candleTime = (rawTime > 1e10 ? Math.floor(rawTime / 1000) : rawTime) as Time

      // Create an updated last candle with the new price
      const updatedCandle: CandlestickData = {
        time: candleTime,
        open: parseFloat(String(lastCandle.open)),
        high: Math.max(parseFloat(String(lastCandle.high)), currentPrice),
        low: Math.min(parseFloat(String(lastCandle.low)), currentPrice),
        close: currentPrice
      }

      // Use try-catch for the update in case the time is invalid
      try {
        seriesRef.current.update(updatedCandle)
      } catch (updateError) {
        // If update fails, it might be because the candle doesn't exist yet
        // In that case, we can skip this update as new data will come soon
        console.debug('Skipping candle update:', updateError)
      }
    } catch (error) {
      console.error('Error updating real-time price:', error)
    }
  }, [currentPrice, data])

  return (
    <div ref={chartContainerRef} className="w-full h-full relative bg-black min-h-[500px]">
      {!isChartReady && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-gray-500 text-xs">Loading chart...</div>
        </div>
      )}
      {isChartReady && (!data || data.length === 0) && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-gray-500 text-xs">Select a token to view chart</div>
        </div>
      )}
    </div>
  )
}