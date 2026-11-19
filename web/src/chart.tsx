// Price chart (TradingView lightweight-charts): an area line of the curve price
// after each trade, in whole quote tokens per whole coin.
import { useEffect, useRef } from 'react'
import { createChart, ColorType, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import { fmtPrice } from './history.ts'

export function PriceChart({ points, up }: { points: { time: number; value: number }[]; up: boolean }) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!el.current) return
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8d8fa0', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: '#1a1b22' }, horzLines: { color: '#1a1b22' } },
      rightPriceScale: { borderColor: '#23242d' },
      timeScale: { borderColor: '#23242d', timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: '#40414e', labelBackgroundColor: '#1f2029' }, horzLine: { color: '#40414e', labelBackgroundColor: '#1f2029' } },
      handleScale: true,
      handleScroll: true,
    })
    chart.current = c
    return () => { c.remove(); chart.current = null }
  }, [])

  useEffect(() => {
    const c = chart.current
    if (!c) return
    const color = up ? '#3ddc97' : '#ff6b81'
    const s = c.addAreaSeries({
      lineColor: color,
      topColor: up ? '#3ddc9733' : '#ff6b8133',
      bottomColor: '#00000000',
      lineWidth: 2,
      priceFormat: { type: 'custom', minMove: 1e-12, formatter: fmtPrice },
    })
    // lightweight-charts needs strictly increasing times: keep the last price per second.
    const byTime = new Map<number, number>()
    for (const p of points) byTime.set(p.time, p.value)
    s.setData([...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as UTCTimestamp, value })))
    c.timeScale().fitContent()
    return () => { c.removeSeries(s) }
  }, [points, up])

  return <div className="chart" ref={el} />
}
