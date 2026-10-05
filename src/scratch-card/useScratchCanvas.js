/**
 * 核心 hook：唯一直接触碰 <canvas>、PointerEvent、ResizeObserver、
 * devicePixelRatio、requestAnimationFrame、定时器与离屏 canvas 的模块（方案 1）。
 * 主 effect 严格按方案 3.3 七步实现，依赖 [cardId, coatingColor, coatingText, initiallyRevealed]。
 */

import { useCallback, useEffect, useRef } from 'react'
import {
  BRUSH_RADIUS_CSS,
  REVEAL_FADE_MS,
  REVEAL_THRESHOLD,
  SAMPLE_MIN_MS,
  clearMask,
  compositeDirtyRect,
  createMask,
  createSampler,
  fillMaskOpaque,
  getClampedDpr,
  paintFullFrame,
  punchDot,
  punchSegment,
  remapMask,
  sampleClearedRatio,
  segmentDirtyRect,
  sizeCanvasToCss,
} from './scratchCanvasEngine.js'

/**
 * @typedef {Object} UseScratchCanvasOptions
 * @property {string} cardId - 卡片稳定唯一 id，用于持久化 key；仅允许 [a-zA-Z0-9_-]，长度 1~40
 * @property {boolean} initiallyRevealed - 初始是否已揭示；为 true 时首帧即渲染全透涂层（用于刷新后水合）
 * @property {string} coatingColor - 涂层底色；必须由组件从 CSS 变量读取后以字符串传入，引擎不读样式表
 * @property {string} coatingText - 涂层上的引导文案，例如"刮开查看奖品"；空串表示不绘制文字
 * @property {(ratio: number) => void} [onProgress] - 刮开比例每发生整数百分点变化时触发（节流后，≤100 次/张生命周期）
 * @property {() => void} [onReveal] - 比例首次达到 REVEAL_THRESHOLD 时触发一次（latch，只触发一次）
 * @property {() => void} [onScratchStart] - 指针首次按下时触发一次（卡片内），用于埋点/触感，不驱动渲染
 */

/**
 * @typedef {Object} ScratchCanvasHandle
 * @property {(canvas: HTMLCanvasElement | null) => void} canvasRef - 挂到涂层 <canvas> 元素的 ref 回调（React 19 ref callback 形式）
 * @property {(el: HTMLDivElement | null) => void} containerRef - 挂到卡片根容器（负责边界与 ResizeObserver）
 * @property {() => number} getRatio - 当前已擦除比例 [0,1]；读 ref 快照，不触发渲染
 * @property {() => boolean} isRevealed - 是否已揭示（含自动全开与水合全开）
 * @property {() => void} reveal - 立即全开（带动画）；幂等，重复调用无副作用。供键盘按钮调用
 * @property {() => void} reset - 重置为全新未刮状态并同步清除持久化记录；幂等
 */

const CARD_ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const FALLBACK_TEXT_COLOR = '#5a5466'

/**
 * @param {UseScratchCanvasOptions} options
 * @returns {ScratchCanvasHandle}
 */
export function useScratchCanvas(options) {
  const { cardId, coatingColor, coatingText, initiallyRevealed } = options

  // 回调用 ref 读，不进 effect 依赖（方案 2.1 第 3 点）
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })

  const canvasElRef = useRef(null)
  const containerElRef = useRef(null)
  const stateRef = useRef({
    ctx: null,
    mask: null,
    maskCtx: null,
    samplerCtx: null,
    cssW: 0,
    cssH: 0,
    dpr: 1,
    bufW: 0,
    bufH: 0,
    isPointerDown: false,
    lastPoint: null,
    lastInside: false,
    revealed: false,
    ratio: 0,
    lastProgressPct: -1,
    lastSampleAt: 0,
    revealImpl: null,
    resetImpl: null,
  })

  const canvasRef = useCallback((canvas) => {
    canvasElRef.current = canvas
  }, [])
  const containerRef = useCallback((el) => {
    containerElRef.current = el
  }, [])

  useEffect(() => {
    if (!CARD_ID_RE.test(cardId)) return undefined
    const canvas = canvasElRef.current
    const container = containerElRef.current
    if (!canvas || !container) return undefined

    const st = stateRef.current
    let disposed = false
    let rafId = 0
    let revealTimer = 0
    let revealFinished = false
    let listenersAttached = false

    const textColor = (() => {
      const value = getComputedStyle(container).getPropertyValue('--scratch-coating-text').trim()
      return value || FALLBACK_TEXT_COLOR
    })()

    function paintFull() {
      if (!st.ctx || !st.mask) return
      paintFullFrame(st.ctx, st.mask, st.cssW, st.cssH, coatingColor, coatingText, textColor)
    }

    function drawDot(point) {
      punchDot(st.maskCtx, point, st.dpr)
      compositeDirtyRect(st.ctx, st.mask, segmentDirtyRect(point, point, st.dpr, st.cssW, st.cssH), st.dpr, coatingColor)
    }

    function drawLine(a, b) {
      punchSegment(st.maskCtx, a, b, st.dpr)
      compositeDirtyRect(st.ctx, st.mask, segmentDirtyRect(a, b, st.dpr, st.cssW, st.cssH), st.dpr, coatingColor)
    }

    function finishReveal() {
      if (revealFinished) return
      revealFinished = true
      if (revealTimer) {
        clearTimeout(revealTimer)
        revealTimer = 0
      }
      canvas.removeEventListener('transitionend', onTransitionEnd)
      if (disposed) return
      if (st.ctx) st.ctx.clearRect(0, 0, st.cssW, st.cssH)
      container.dataset.state = 'revealed'
      optionsRef.current.onReveal?.()
    }

    function onTransitionEnd(event) {
      if (event.propertyName === 'opacity') finishReveal()
    }

    // 方案 3.4 第 5 点 + R9：单向锁，先摘监听后做动画，transitionend 与 320ms 定时器双兜底
    function doReveal() {
      if (disposed || st.revealed) return
      st.revealed = true
      st.ratio = 1
      st.isPointerDown = false
      st.lastPoint = null
      detachPointerListeners()
      revealFinished = false
      canvas.addEventListener('transitionend', onTransitionEnd)
      revealTimer = window.setTimeout(finishReveal, REVEAL_FADE_MS)
      container.dataset.state = 'revealing'
    }

    // 方案 2.1 reset：画布侧重置为全新未刮状态；幂等
    function doReset() {
      if (disposed || !st.ctx || !st.maskCtx) return
      if (revealTimer) {
        clearTimeout(revealTimer)
        revealTimer = 0
      }
      canvas.removeEventListener('transitionend', onTransitionEnd)
      st.revealed = false
      st.ratio = 0
      st.lastProgressPct = -1
      st.isPointerDown = false
      st.lastPoint = null
      st.lastInside = false
      fillMaskOpaque(st.maskCtx, st.bufW, st.bufH)
      container.dataset.state = 'sealed'
      paintFull()
      attachPointerListeners()
    }

    // 方案 3.5：固定 48×48 采样器检测；onProgress 仅在整数百分点变化时触发；阈值单向 latch
    function sampleNow() {
      if (disposed || st.revealed || !st.mask || !st.samplerCtx) return
      st.lastSampleAt = performance.now()
      const ratio = sampleClearedRatio(st.samplerCtx, st.mask, st.bufW, st.bufH)
      st.ratio = ratio
      const pct = Math.floor(ratio * 100)
      if (pct !== st.lastProgressPct) {
        st.lastProgressPct = pct
        optionsRef.current.onProgress?.(ratio)
      }
      if (ratio >= REVEAL_THRESHOLD) doReveal()
    }

    // 时间门控：距上次检测 ≥ SAMPLE_MIN_MS(200) 才执行（≤5 次/秒）
    function scheduleSample() {
      if (st.revealed) return
      if (performance.now() - st.lastSampleAt < SAMPLE_MIN_MS) return
      sampleNow()
    }

    function onPointerDown(event) {
      if (st.revealed || !st.ctx) return
      if (container.dataset.state !== 'sealed') return
      if (!event.isPrimary) return
      if (event.pointerType === 'mouse' && event.button !== 0) return
      try {
        canvas.setPointerCapture(event.pointerId)
      } catch {
        // 极少数环境 capture 失败：window 级监听仍兜底（R5②）
      }
      st.isPointerDown = true
      const rect = canvas.getBoundingClientRect()
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      st.lastPoint = point
      st.lastInside = true
      drawDot(point)
      optionsRef.current.onScratchStart?.()
      scheduleSample()
    }

    function onPointerMove(event) {
      if (!st.isPointerDown || st.revealed || !st.ctx) return
      // rect 每次事件现取，不缓存（方案 3.2）
      const rect = canvas.getBoundingClientRect()
      const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
      const events = coalesced && coalesced.length > 0 ? coalesced : [event]
      for (const item of events) {
        const x = item.clientX - rect.left
        const y = item.clientY - rect.top
        const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height
        // 外部点不 clamp、不绘制（R5③）
        if (!inside) {
          st.lastInside = false
          continue
        }
        const current = { x, y }
        if (!st.lastPoint || !st.lastInside) {
          // 从外部回到内部：以内部点画圆点起笔，绝不连接跨边界两点（R5③）
          drawDot(current)
        } else {
          const gap = Math.hypot(current.x - st.lastPoint.x, current.y - st.lastPoint.y)
          if (gap > BRUSH_RADIUS_CSS) {
            // 超距兜底：按 ceil(gap/20) 线性插值补点（方案 3.4 / R4②）
            const steps = Math.ceil(gap / BRUSH_RADIUS_CSS)
            let prev = st.lastPoint
            for (let i = 1; i <= steps; i += 1) {
              const t = i / steps
              const point = {
                x: st.lastPoint.x + (current.x - st.lastPoint.x) * t,
                y: st.lastPoint.y + (current.y - st.lastPoint.y) * t,
              }
              drawLine(prev, point)
              prev = point
            }
          } else {
            drawLine(st.lastPoint, current)
          }
        }
        st.lastPoint = current
        st.lastInside = true
      }
      scheduleSample()
    }

    function endStroke(event) {
      if (!st.isPointerDown) return
      st.isPointerDown = false
      st.lastPoint = null
      st.lastInside = false
      if (event && event.type === 'pointercancel') {
        try {
          if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
        } catch {
          // capture 可能已被浏览器释放
        }
      }
      // 抬手必做一次面积检测，不被节流漏掉（方案 3.4 第 4 点）
      sampleNow()
    }

    function attachPointerListeners() {
      if (listenersAttached) return
      listenersAttached = true
      canvas.addEventListener('pointerdown', onPointerDown)
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', endStroke)
      window.addEventListener('pointercancel', endStroke)
      canvas.addEventListener('lostpointercapture', endStroke)
    }

    function detachPointerListeners() {
      if (!listenersAttached) return
      listenersAttached = false
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', endStroke)
      window.removeEventListener('pointercancel', endStroke)
      canvas.removeEventListener('lostpointercapture', endStroke)
    }

    // 方案 3.3 第 2~5 步：建缓冲、建掩码、水合判定、合成首帧
    function initBuffers(cssW, cssH) {
      const dpr = getClampedDpr()
      const bufW = Math.round(cssW * dpr)
      const bufH = Math.round(cssH * dpr)
      st.dpr = dpr
      st.bufW = bufW
      st.bufH = bufH
      st.cssW = cssW
      st.cssH = cssH
      st.ctx = sizeCanvasToCss(canvas, cssW, cssH, dpr)
      const mask = createMask(bufW, bufH)
      st.mask = mask.canvas
      st.maskCtx = mask.ctx
      if (initiallyRevealed || st.revealed) {
        clearMask(st.maskCtx, bufW, bufH)
        st.revealed = true
        st.ratio = 1
        container.dataset.state = 'revealed'
      } else {
        fillMaskOpaque(st.maskCtx, bufW, bufH)
        st.revealed = false
        st.ratio = 0
        st.lastProgressPct = -1
        container.dataset.state = 'sealed'
      }
      paintFull()
    }

    // 方案 3.6：resize 时以旧掩码为唯一真相源等比重映射，原子完成
    function handleResize() {
      const rect = container.getBoundingClientRect()
      const cssW = rect.width
      const cssH = rect.height
      if (cssW <= 0 || cssH <= 0) return
      if (!st.ctx) {
        initBuffers(cssW, cssH)
        return
      }
      const dpr = getClampedDpr()
      const bufW = Math.round(cssW * dpr)
      const bufH = Math.round(cssH * dpr)
      if (bufW === st.bufW && bufH === st.bufH) return
      const oldMask = st.mask
      st.dpr = dpr
      st.bufW = bufW
      st.bufH = bufH
      st.cssW = cssW
      st.cssH = cssH
      st.ctx = sizeCanvasToCss(canvas, cssW, cssH, dpr)
      const remapped = remapMask(oldMask, bufW, bufH)
      st.mask = remapped.canvas
      st.maskCtx = remapped.ctx
      paintFull()
      // resize 补检：若比例已 ≥0.5 则直接走揭示流程
      sampleNow()
    }

    const observer = new ResizeObserver(() => {
      // 同一帧内多次回调只取最后尺寸（方案 3.6 第 6 点）
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        handleResize()
      })
    })
    observer.observe(container)

    st.samplerCtx = createSampler()
    st.revealImpl = doReveal
    st.resetImpl = doReset
    handleResize()
    attachPointerListeners()

    // 方案 3.3 第 7 步 cleanup（证据 1 StrictMode 双挂载必需，幂等）
    return () => {
      disposed = true
      detachPointerListeners()
      observer.disconnect()
      if (rafId) cancelAnimationFrame(rafId)
      if (revealTimer) clearTimeout(revealTimer)
      canvas.removeEventListener('transitionend', onTransitionEnd)
      st.ctx = null
      st.mask = null
      st.maskCtx = null
      st.samplerCtx = null
      st.isPointerDown = false
      st.lastPoint = null
      st.revealImpl = null
      st.resetImpl = null
    }
  }, [cardId, coatingColor, coatingText, initiallyRevealed])

  const getRatio = useCallback(() => stateRef.current.ratio, [])
  const isRevealed = useCallback(() => stateRef.current.revealed, [])
  const reveal = useCallback(() => {
    stateRef.current.revealImpl?.()
  }, [])
  const reset = useCallback(() => {
    stateRef.current.resetImpl?.()
  }, [])

  return { canvasRef, containerRef, getRatio, isRevealed, reveal, reset }
}
