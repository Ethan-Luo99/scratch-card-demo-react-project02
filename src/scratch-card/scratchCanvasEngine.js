/**
 * 刮刮卡 canvas 引擎：无 React 依赖的纯函数集合。
 * 对应方案 2.1 固定常量与第 3 节渲染/坐标管线，可脱离 React 单测。
 */

/**
 * 固定数值常量（scratchCanvasEngine.js 导出，禁止调用方覆盖）
 * @typedef {Object} ScratchConstants
 * @property {number} REVEAL_THRESHOLD - 0.5，自动全开的刮开比例阈值
 * @property {number} ALPHA_CLEARED - 16，alpha < 16 计为"已擦除"
 * @property {number} BRUSH_RADIUS_CSS - 20，画笔半径（CSS px），直径 40px
 * @property {48} SAMPLE_GRID - 采样器固定 48 × 48 = 2304 个采样点
 * @property {number} SAMPLE_MIN_MS - 200，两次面积检测最小间隔
 * @property {2} MAX_DPR - devicePixelRatio 上限
 * @property {number} REVEAL_FADE_MS - 320，自动全开的淡出时长
 */

/** @type {number} 0.5，自动全开的刮开比例阈值 */
export const REVEAL_THRESHOLD = 0.5
/** @type {number} 16，alpha < 16 计为"已擦除" */
export const ALPHA_CLEARED = 16
/** @type {number} 20，画笔半径（CSS px），直径 40px */
export const BRUSH_RADIUS_CSS = 20
/** @type {48} 采样器固定 48 × 48 = 2304 个采样点 */
export const SAMPLE_GRID = 48
/** @type {number} 200，两次面积检测最小间隔 */
export const SAMPLE_MIN_MS = 200
/** @type {2} devicePixelRatio 上限 */
export const MAX_DPR = 2
/** @type {number} 320，自动全开的淡出时长 */
export const REVEAL_FADE_MS = 320

/** @typedef {{ x: number, y: number }} CssPoint */
/** @typedef {{ x: number, y: number, w: number, h: number }} CssRect */

/**
 * dpr = min(devicePixelRatio || 1, MAX_DPR)（方案 3.2 / R10）
 * @returns {number}
 */
export function getClampedDpr() {
  return Math.min(window.devicePixelRatio || 1, MAX_DPR)
}

/**
 * 按方案 3.2 设置可见 canvas：缓冲区 = round(css × dpr)，style = CSS 尺寸，
 * 上下文 setTransform(dpr,…)，此后绘制一律用 CSS 像素。
 * @param {HTMLCanvasElement} canvas
 * @param {number} cssW
 * @param {number} cssH
 * @param {number} dpr
 * @returns {CanvasRenderingContext2D}
 */
export function sizeCanvasToCss(canvas, cssW, cssH, dpr) {
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  canvas.style.width = `${cssW}px`
  canvas.style.height = `${cssH}px`
  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: false })
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

/**
 * 创建离屏保留掩码 canvas（纯 alpha 蒙版，设备像素坐标系，不做 setTransform）。
 * 掩码语义：不透明 = 涂层保留，透明 = 已刮穿。
 * @param {number} bufW
 * @param {number} bufH
 * @returns {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D }}
 */
export function createMask(bufW, bufH) {
  const canvas = document.createElement('canvas')
  canvas.width = bufW
  canvas.height = bufH
  const ctx = canvas.getContext('2d')
  return { canvas, ctx }
}

/**
 * 掩码全填黑（不透明 = 涂层保留）。
 * @param {CanvasRenderingContext2D} maskCtx
 * @param {number} bufW
 * @param {number} bufH
 */
export function fillMaskOpaque(maskCtx, bufW, bufH) {
  maskCtx.save()
  maskCtx.globalCompositeOperation = 'source-over'
  maskCtx.fillStyle = '#000'
  maskCtx.fillRect(0, 0, bufW, bufH)
  maskCtx.restore()
}

/**
 * 掩码整体清空（全透明 = 全部刮穿，水合全开用）。
 * @param {CanvasRenderingContext2D} maskCtx
 * @param {number} bufW
 * @param {number} bufH
 */
export function clearMask(maskCtx, bufW, bufH) {
  maskCtx.clearRect(0, 0, bufW, bufH)
}

/**
 * 整卡全帧合成（方案 3.3 第 5 步 / 3.6 第 4 步）：
 * 先 source-over 填涂层底色并绘制提示文字，再 destination-in 贴整幅掩码。
 * @param {CanvasRenderingContext2D} ctx 可见层上下文（已 setTransform(dpr,…)）
 * @param {HTMLCanvasElement} maskCanvas
 * @param {number} cssW
 * @param {number} cssH
 * @param {string} coatingColor
 * @param {string} coatingText 空串表示不绘制文字
 * @param {string} coatingTextColor
 */
export function paintFullFrame(ctx, maskCanvas, cssW, cssH, coatingColor, coatingText, coatingTextColor) {
  ctx.save()
  ctx.clearRect(0, 0, cssW, cssH)
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = coatingColor
  ctx.fillRect(0, 0, cssW, cssH)
  if (coatingText) {
    ctx.fillStyle = coatingTextColor
    ctx.font = `600 ${Math.max(14, Math.round(cssH * 0.11))}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(coatingText, cssW / 2, cssH / 2)
  }
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(maskCanvas, 0, 0, maskCanvas.width, maskCanvas.height, 0, 0, cssW, cssH)
  ctx.restore()
}

/**
 * 对掩码做 destination-out 线段打洞（方案 3.4 第 3 点）。
 * 坐标以 CSS 像素传入，内部换算为设备像素；反复涂画幂等、不叠加色差。
 * @param {CanvasRenderingContext2D} maskCtx
 * @param {CssPoint} a
 * @param {CssPoint} b
 * @param {number} dpr
 */
export function punchSegment(maskCtx, a, b, dpr) {
  maskCtx.save()
  maskCtx.globalCompositeOperation = 'destination-out'
  maskCtx.strokeStyle = '#000'
  maskCtx.lineCap = 'round'
  maskCtx.lineJoin = 'round'
  maskCtx.lineWidth = 2 * BRUSH_RADIUS_CSS * dpr
  maskCtx.beginPath()
  maskCtx.moveTo(a.x * dpr, a.y * dpr)
  maskCtx.lineTo(b.x * dpr, b.y * dpr)
  maskCtx.stroke()
  maskCtx.restore()
}

/**
 * 对掩码做 destination-out 圆点打洞（pointerdown 首点 / 界外回入起笔）。
 * @param {CanvasRenderingContext2D} maskCtx
 * @param {CssPoint} p
 * @param {number} dpr
 */
export function punchDot(maskCtx, p, dpr) {
  maskCtx.save()
  maskCtx.globalCompositeOperation = 'destination-out'
  maskCtx.fillStyle = '#000'
  maskCtx.beginPath()
  maskCtx.arc(p.x * dpr, p.y * dpr, BRUSH_RADIUS_CSS * dpr, 0, Math.PI * 2)
  maskCtx.fill()
  maskCtx.restore()
}

/**
 * 线段脏矩形（CSS 像素）：笔画包围盒（含画笔半径）+ 1 设备像素，裁剪到卡片内。
 * @param {CssPoint} a
 * @param {CssPoint} b
 * @param {number} dpr
 * @param {number} cssW
 * @param {number} cssH
 * @returns {CssRect}
 */
export function segmentDirtyRect(a, b, dpr, cssW, cssH) {
  const pad = BRUSH_RADIUS_CSS + 1 / dpr
  const x0 = Math.max(0, Math.min(a.x, b.x) - pad)
  const y0 = Math.max(0, Math.min(a.y, b.y) - pad)
  const x1 = Math.min(cssW, Math.max(a.x, b.x) + pad)
  const y1 = Math.min(cssH, Math.max(a.y, b.y) + pad)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * 可见层脏矩形合成（方案 3.4 第 3 点，顺序固定）：
 * ① clip 到脏矩形 ② clearRect ③ source-over 回填涂层底色（不重画文字）
 * ④ destination-in 以显式设备像素源矩形贴掩码 ⑤ restore。
 * @param {CanvasRenderingContext2D} ctx 可见层上下文（已 setTransform(dpr,…)）
 * @param {HTMLCanvasElement} maskCanvas
 * @param {CssRect} dirty CSS 像素脏矩形
 * @param {number} dpr
 * @param {string} coatingColor
 */
export function compositeDirtyRect(ctx, maskCanvas, dirty, dpr, coatingColor) {
  if (dirty.w <= 0 || dirty.h <= 0) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(dirty.x, dirty.y, dirty.w, dirty.h)
  ctx.clip()
  ctx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h)
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = coatingColor
  ctx.fillRect(dirty.x, dirty.y, dirty.w, dirty.h)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(
    maskCanvas,
    dirty.x * dpr, dirty.y * dpr, dirty.w * dpr, dirty.h * dpr,
    dirty.x, dirty.y, dirty.w, dirty.h,
  )
  ctx.restore()
}

/**
 * 离屏掩码缩放（方案 3.6 第 3 步）：newMask 先以 source-over 铺全不透明，
 * 再以 destination-in 把旧掩码整体等比 drawImage 映射（孔洞保留为透明）。
 * 禁止改为 destination-out（会把保留区打穿、孔洞反转）。
 * @param {HTMLCanvasElement} oldMaskCanvas
 * @param {number} bufW 新缓冲区宽（设备像素）
 * @param {number} bufH 新缓冲区高（设备像素）
 * @returns {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D }}
 */
export function remapMask(oldMaskCanvas, bufW, bufH) {
  const canvas = document.createElement('canvas')
  canvas.width = bufW
  canvas.height = bufH
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, bufW, bufH)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(oldMaskCanvas, 0, 0, oldMaskCanvas.width, oldMaskCanvas.height, 0, 0, bufW, bufH)
  ctx.globalCompositeOperation = 'source-over'
  return { canvas, ctx }
}

/**
 * 创建固定 48×48 采样器（方案 3.5，与卡片尺寸、DPR 无关）。
 * @returns {CanvasRenderingContext2D}
 */
export function createSampler() {
  const canvas = document.createElement('canvas')
  canvas.width = SAMPLE_GRID
  canvas.height = SAMPLE_GRID
  return canvas.getContext('2d', { willReadFrequently: true })
}

/**
 * 等距 alpha 采样：掩码 GPU 缩放到 48×48 后读 9216 字节，
 * alpha < ALPHA_CLEARED(16) 计为已擦除，返回比例 [0,1]（方案 3.5 / R7）。
 * @param {CanvasRenderingContext2D} samplerCtx
 * @param {HTMLCanvasElement} maskCanvas
 * @param {number} bufW
 * @param {number} bufH
 * @returns {number}
 */
export function sampleClearedRatio(samplerCtx, maskCanvas, bufW, bufH) {
  samplerCtx.clearRect(0, 0, SAMPLE_GRID, SAMPLE_GRID)
  samplerCtx.drawImage(maskCanvas, 0, 0, bufW, bufH, 0, 0, SAMPLE_GRID, SAMPLE_GRID)
  const data = samplerCtx.getImageData(0, 0, SAMPLE_GRID, SAMPLE_GRID).data
  let cleared = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < ALPHA_CLEARED) cleared += 1
  }
  return cleared / (SAMPLE_GRID * SAMPLE_GRID)
}
