/**
 * 核心 hook（方案 2.1 / 第 3 节）：canvas 生命周期、PointerEvent 交互、
 * ResizeObserver、devicePixelRatio、requestAnimationFrame、定时器与离屏 canvas
 * 全部只在此模块内直接触碰。对外只暴露句柄与回调；高频路径只写闭包变量
 * 与 ref，不经过 React 渲染管线（R2）。
 */
import { useCallback, useEffect, useRef } from 'react'
import {
  REVEAL_FADE_MS,
  REVEAL_THRESHOLD,
  SAMPLE_MIN_MS,
  computeBufferSize,
  createMaskCanvas,
  createSampler,
  eventToCssPoint,
  getClampedDpr,
  interpolatePoints,
  paintCoatingFrame,
  punchSegment,
  repaintDirtyRect,
  rescaleMask,
  sampleClearedRatio,
} from './scratchCanvasEngine.js'

/**
 * @typedef {import('./scratchStorage.js').ScratchStorage} ScratchStorage
 */

/**
 * @typedef {object} UseScratchCanvasOptions
 * @property {string} cardId 卡片稳定唯一 id，用于持久化 key；仅允许 [a-zA-Z0-9_-]，长度 1~40
 * @property {boolean} initiallyRevealed 初始是否已揭示；为 true 时首帧即渲染全透涂层（用于刷新后水合）
 * @property {string} coatingColor 涂层底色；必须由组件从 CSS 变量读取后以字符串传入，引擎不读样式表
 * @property {string} coatingText 涂层上的引导文案，例如"刮开查看奖品"；空串表示不绘制文字
 * @property {ScratchStorage} storage 由调用方注入并共享的存储实例；
 *   hook 不再自建，保证 reset()/撤销清除的 key 与 Grid 水合读取的 key 一致
 * @property {(ratio: number) => void} [onProgress] 刮开比例每发生整数百分点变化时触发（节流后，≤100 次/张生命周期）
 * @property {() => void} [onReveal] 比例首次达到 REVEAL_THRESHOLD 时触发一次（latch，只触发一次）
 * @property {() => void} [onScratchStart] 指针首次按下时触发一次（卡片内），用于埋点/触感，不驱动渲染
 */

/**
 * @typedef {object} ScratchCanvasHandle
 * @property {(canvas: HTMLCanvasElement | null) => void} canvasRef 挂到涂层 <canvas> 元素的 ref 回调（React 19 ref callback 形式）
 * @property {(el: HTMLDivElement | null) => void} containerRef 挂到卡片根容器（负责边界与 ResizeObserver）
 * @property {() => number} getRatio 当前已擦除比例 [0,1]；读 ref 快照，不触发渲染
 * @property {() => boolean} isRevealed 是否已揭示（含自动全开与水合全开）
 * @property {() => void} reveal 立即全开（带动画）；幂等，重复调用无副作用。供键盘按钮调用
 * @property {() => void} reset 重置为全新未刮状态并同步清除持久化记录；幂等
 */

const NOOP_API = { reveal: () => {}, reset: () => {} }

/**
 * @param {UseScratchCanvasOptions} options
 * @returns {ScratchCanvasHandle}
 */
export function useScratchCanvas(options) {
  const { cardId, initiallyRevealed, coatingColor, coatingText } = options

  // 回调经 ref 读取，props 变化不重建 canvas effect（方案 2.1 设计理由 3 / R2）
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })

  const canvasElRef = useRef(/** @type {HTMLCanvasElement | null} */ (null))
  const containerElRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  const ratioRef = useRef(initiallyRevealed ? 1 : 0)
  const revealedRef = useRef(initiallyRevealed)
  const apiRef = useRef(NOOP_API)

  const canvasRef = useCallback((canvas) => {
    canvasElRef.current = canvas
  }, [])
  const containerRef = useCallback((el) => {
    containerElRef.current = el
  }, [])
  const getRatio = useCallback(() => ratioRef.current, [])
  const isRevealed = useCallback(() => revealedRef.current, [])
  const reveal = useCallback(() => {
    apiRef.current.reveal()
  }, [])
  const reset = useCallback(() => {
    apiRef.current.reset()
  }, [])

  // 主 effect 严格按方案 3.3：依赖 [cardId, coatingColor, coatingText, initiallyRevealed]
  useEffect(() => {
    const canvas = canvasElRef.current
    const container = containerElRef.current
    if (!canvas || !container) return undefined

    // —— effect 闭包内的全部可变状态（高频路径只写这些，无 setState）——
    /** @type {CanvasRenderingContext2D | null} */
    let ctx = null
    /** @type {HTMLCanvasElement | null} 离屏保留掩码：不透明=涂层保留，透明=已刮穿 */
    let maskCanvas = null
    const sampler = createSampler()
    let dpr = 1
    let cssW = 0
    let cssH = 0
    let isPointerDown = false
    /** @type {number | null} */
    let activePointerId = null
    /** @type {{ x: number, y: number } | null} 上一卡内有效点；外部点不覆盖（R5） */
    let lastInsidePoint = null
    let lastWholePercent = initiallyRevealed ? 100 : -1
    let lastSampleAt = 0
    /** @type {number | null} 采样兜底定时器（3.3 第 7 步要求清理） */
    let sampleTimer = null
    /** @type {number | null} ResizeObserver 的 rAF 去重标记（3.6 第 6 点） */
    let resizeRaf = null
    /** @type {number | null} 揭示淡出 320ms 兜底定时器（R9） */
    let fadeTimer = null
    /** @type {(() => void) | null} transitionend 监听引用，cleanup 需摘除 */
    let fadeFinish = null
    let listenersAttached = false
    let scratchStartFired = initiallyRevealed
    let disposed = false

    revealedRef.current = initiallyRevealed
    ratioRef.current = initiallyRevealed ? 1 : 0

    // 涂层文字颜色：effect 重建点从容器 CSS 变量读取一次（引擎不读样式表，方案 3.7）
    const coatingTextColor =
      window.getComputedStyle(container).getPropertyValue('--scratch-coating-text').trim() ||
      '#5a5466'

    /**
     * 建立/重建缓冲区与掩码（方案 3.3 第 2~5 步与 3.6 共用）。
     * @param {boolean} fromResize true 时按 3.6 迁移旧掩码（destination-in）
     * @returns {boolean} 容器宽或高为 0 时返回 false，等 ResizeObserver 再来
     */
    const setupBuffers = (fromResize) => {
      const rect = container.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return false
      dpr = getClampedDpr()
      cssW = rect.width
      cssH = rect.height
      const { bufW, bufH } = computeBufferSize(cssW, cssH, dpr)

      const oldMask = fromResize ? maskCanvas : null
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
      canvas.width = bufW
      canvas.height = bufH
      ctx = canvas.getContext('2d', { alpha: true, desynchronized: false })
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      if (oldMask && oldMask.width > 0 && oldMask.height > 0) {
        // 方案 3.6 第 3 步：newMask 先铺全不透明，再以 destination-in 等比贴旧掩码
        maskCanvas = rescaleMask(oldMask, bufW, bufH)
      } else {
        // 方案 3.3 第 3~4 步：密封=全不透明；水合全开=全透明
        maskCanvas = createMaskCanvas(bufW, bufH, !revealedRef.current)
      }
      if (revealedRef.current) {
        maskCanvas.getContext('2d').clearRect(0, 0, bufW, bufH)
        container.dataset.state = 'revealed'
      } else {
        container.dataset.state = 'sealed'
      }
      // 方案 3.3 第 5 步：全帧合成（填涂层底色/文字 + destination-in 贴整幅掩码）
      paintCoatingFrame(ctx, cssW, cssH, maskCanvas, {
        color: coatingColor,
        text: coatingText,
        textColor: coatingTextColor,
      })
      return true
    }

    /** 达到阈值后的揭示 latch（方案 3.4 第 5 点 / R9：单向锁、先摘监听、双兜底） */
    const doReveal = () => {
      if (revealedRef.current || disposed || !ctx || !maskCanvas) return
      revealedRef.current = true
      ratioRef.current = 1
      isPointerDown = false
      activePointerId = null
      lastInsidePoint = null
      detachPointerListeners()

      const finish = () => {
        if (fadeTimer !== null) {
          window.clearTimeout(fadeTimer)
          fadeTimer = null
        }
        if (fadeFinish) {
          canvas.removeEventListener('transitionend', fadeFinish)
          fadeFinish = null
        }
        if (disposed) return
        if (ctx) {
          ctx.save()
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          ctx.restore()
        }
        if (maskCanvas) {
          maskCanvas.getContext('2d').clearRect(0, 0, maskCanvas.width, maskCanvas.height)
        }
        container.dataset.state = 'revealed'
      }

      // prefers-reduced-motion: reduce 时跳过 320ms 淡出，一次性进入 revealed，
      // 无闪烁、无残留半透明；其余环境维持 CSS opacity 淡出（方案 3.7 / 第 7 节取舍 7）
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        finish()
      } else {
        container.dataset.state = 'revealing' // CSS：opacity 320ms 淡出（方案 3.7）
        fadeFinish = finish
        canvas.addEventListener('transitionend', finish)
        fadeTimer = window.setTimeout(finish, REVEAL_FADE_MS)
      }
      // onReveal 只调用一次；Grid 在其中同步完成 storage 写入与 setState（R9）
      optionsRef.current.onReveal?.()
    }

    /**
     * 面积检测（方案 3.5）：固定 48×48 采样器 + 200ms 时间门控（带兜底定时器，
     * 保证停手后最多滞后 200ms）；结果只写 ref，整数百分点变化才调 onProgress。
     * @param {boolean} force true 时绕过时间门（pointerup / resize 补检）
     */
    const runDetection = (force) => {
      if (revealedRef.current || !ctx || !maskCanvas) return
      const now = performance.now()
      if (!force) {
        const elapsed = now - lastSampleAt
        if (elapsed < SAMPLE_MIN_MS) {
          if (sampleTimer === null) {
            sampleTimer = window.setTimeout(() => {
              sampleTimer = null
              runDetection(true)
            }, SAMPLE_MIN_MS - elapsed)
          }
          return
        }
      }
      lastSampleAt = now
      const ratio = sampleClearedRatio(maskCanvas, sampler)
      ratioRef.current = ratio
      const wholePercent = Math.floor(ratio * 100)
      if (wholePercent !== lastWholePercent) {
        lastWholePercent = wholePercent
        optionsRef.current.onProgress?.(ratio)
      }
      if (ratio >= REVEAL_THRESHOLD) doReveal()
    }

    /**
     * 掩码 destination-out 打洞 + 可见层脏矩形 destination-in 合成（方案 3.4 第 3 点）
     * @param {{ x: number, y: number } | null} from null 表示画圆点
     * @param {{ x: number, y: number }} to
     */
    const scratchStroke = (from, to) => {
      if (!ctx || !maskCanvas) return
      punchSegment(maskCanvas.getContext('2d'), dpr, from, to)
      repaintDirtyRect(ctx, maskCanvas, dpr, from, to, coatingColor)
    }

    /** @param {PointerEvent} event */
    const handlePointerDown = (event) => {
      if (revealedRef.current || isPointerDown) return
      if (event.pointerType === 'mouse' && event.button !== 0) return
      try {
        canvas.setPointerCapture(event.pointerId) // R5 ①：按下期间事件都派发到本 canvas
      } catch {
        // 指针已失效（极端时序），忽略即可
      }
      isPointerDown = true
      activePointerId = event.pointerId
      const rect = canvas.getBoundingClientRect()
      const point = eventToCssPoint(event, rect)
      lastInsidePoint = point
      scratchStroke(null, point) // 点一下也要有效：首点实心圆点
      if (!scratchStartFired) {
        scratchStartFired = true
        optionsRef.current.onScratchStart?.()
      }
    }

    /** @param {PointerEvent} event */
    const handlePointerMove = (event) => {
      // 高频路径：只写闭包变量与直接绘制，禁止任何 setState（R2）
      if (!isPointerDown || revealedRef.current) return
      if (activePointerId !== null && event.pointerId !== activePointerId) return
      const rect = canvas.getBoundingClientRect() // 每次事件现取，不缓存（3.2）
      // R4 两级策略：有合并事件严格按真实子点连线；为空用事件自身 + 插值兜底
      const coalesced =
        typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
      const events = coalesced.length > 0 ? coalesced : [event]
      for (const item of events) {
        const point = eventToCssPoint(item, rect)
        const inside =
          point.x >= 0 && point.x <= rect.width && point.y >= 0 && point.y <= rect.height
        if (!inside) {
          // R5 ③：外部点不 clamp、不绘制；回入时以圆点起笔，绝不连接跨边界两点
          lastInsidePoint = null
          continue
        }
        if (lastInsidePoint) {
          // R4 ②：相邻点距 > 20px 时按 ceil(gap/20) 线性插值兜底
          const steps = interpolatePoints(lastInsidePoint, point)
          let cursor = lastInsidePoint
          for (const step of steps) {
            scratchStroke(cursor, step)
            cursor = step
          }
        } else {
          scratchStroke(null, point)
        }
        lastInsidePoint = point
      }
      runDetection(false)
    }

    /** @param {PointerEvent} event */
    const handlePointerUp = (event) => {
      if (!isPointerDown) return
      if (activePointerId !== null && event.pointerId !== activePointerId) return
      isPointerDown = false
      activePointerId = null
      lastInsidePoint = null
      runDetection(true) // 抬手即判定，不被节流漏掉（3.5 第 4 点）
    }

    /** @param {PointerEvent} event */
    const handlePointerCancel = (event) => {
      if (!isPointerDown) return
      if (
        activePointerId !== null &&
        event.pointerId !== undefined &&
        event.pointerId !== activePointerId
      ) {
        return
      }
      isPointerDown = false
      activePointerId = null
      lastInsidePoint = null
      if (event.type === 'pointercancel') {
        try {
          canvas.releasePointerCapture(event.pointerId) // cancel 时显式释放（3.4 第 4 点）
        } catch {
          // 浏览器已自动释放
        }
      }
      runDetection(true) // pointercancel 当作抬手正常收尾（R8）
    }

    const attachPointerListeners = () => {
      if (listenersAttached) return
      listenersAttached = true
      canvas.addEventListener('pointerdown', handlePointerDown)
      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp)
      window.addEventListener('pointercancel', handlePointerCancel)
      canvas.addEventListener('lostpointercapture', handlePointerCancel)
    }

    const detachPointerListeners = () => {
      if (!listenersAttached) return
      listenersAttached = false
      canvas.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      canvas.removeEventListener('lostpointercapture', handlePointerCancel)
    }

    /** ResizeObserver：rAF 去重，每帧最多重建一次（方案 3.6 第 6 点 / R6） */
    const scheduleResize = () => {
      if (resizeRaf !== null) return
      resizeRaf = window.requestAnimationFrame(() => {
        resizeRaf = null
        if (disposed) return
        const rect = container.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return
        const nextDpr = getClampedDpr()
        const { bufW, bufH } = computeBufferSize(rect.width, rect.height, nextDpr)
        if (maskCanvas && bufW === canvas.width && bufH === canvas.height) return
        setupBuffers(true)
        if (!revealedRef.current) runDetection(true) // resize 后补检（3.6 第 5 步）
      })
    }

    /** 重置为全新未刮状态并同步清除持久化记录；幂等（方案 2.1） */
    const resetCard = () => {
      if (disposed) return
      if (fadeTimer !== null) {
        window.clearTimeout(fadeTimer)
        fadeTimer = null
      }
      if (fadeFinish) {
        canvas.removeEventListener('transitionend', fadeFinish)
        fadeFinish = null
      }
      revealedRef.current = false
      ratioRef.current = 0
      lastWholePercent = -1
      isPointerDown = false
      activePointerId = null
      lastInsidePoint = null
      // 存储实例由调用方注入共享（见 options.storage），reset 清除的 key
      // 与 Grid 水合读取的 key 必然一致；撤销路径复用本方法，单次调用单次写入
      optionsRef.current.storage.removeCard(cardId)
      maskCanvas = null
      setupBuffers(false)
      attachPointerListeners()
    }

    // —— 方案 3.3 第 4~6 步：初始化、注册监听 ——
    setupBuffers(false)
    if (!revealedRef.current) attachPointerListeners()
    const resizeObserver = new ResizeObserver(scheduleResize)
    resizeObserver.observe(container)
    apiRef.current = { reveal: doReveal, reset: resetCard }

    return () => {
      // 方案 3.3 第 7 步 / R1：摘除全部监听、disconnect、取消 rAF、清定时器、置空引用
      disposed = true
      detachPointerListeners()
      resizeObserver.disconnect()
      if (resizeRaf !== null) {
        window.cancelAnimationFrame(resizeRaf)
        resizeRaf = null
      }
      if (sampleTimer !== null) {
        window.clearTimeout(sampleTimer)
        sampleTimer = null
      }
      if (fadeTimer !== null) {
        window.clearTimeout(fadeTimer)
        fadeTimer = null
      }
      if (fadeFinish) {
        canvas.removeEventListener('transitionend', fadeFinish)
        fadeFinish = null
      }
      apiRef.current = NOOP_API
      maskCanvas = null
      ctx = null
    }
  }, [cardId, coatingColor, coatingText, initiallyRevealed])

  return { canvasRef, containerRef, getRatio, isRevealed, reveal, reset }
}
