/**
 * 刮刮卡引擎：无 React 依赖的纯函数集合。
 * 负责画笔常量、CSS↔设备像素换算、涂层填充、对掩码的 destination-out 打洞、
 * 可见层 destination-in 合成、离屏掩码缩放与等距 alpha 采样。
 * 对应方案第 2.1 节 ScratchConstants 与第 3 节渲染管线。
 */

/** 自动全开的刮开比例阈值 */
export const REVEAL_THRESHOLD = 0.5
/** alpha < 16 计为"已擦除" */
export const ALPHA_CLEARED = 16
/** 画笔半径（CSS px），直径 40px */
export const BRUSH_RADIUS_CSS = 20
/** 采样器固定 48 × 48 = 2304 个采样点 */
export const SAMPLE_GRID = 48
/** 两次面积检测最小间隔（ms） */
export const SAMPLE_MIN_MS = 200
/** devicePixelRatio 上限 */
export const MAX_DPR = 2
/** 自动全开的淡出时长（ms） */
export const REVEAL_FADE_MS = 320

/**
 * @typedef {object} CssPoint CSS 像素坐标
 * @property {number} x
 * @property {number} y
 */

/**
 * 钳制后的设备像素比：dpr = min(devicePixelRatio || 1, MAX_DPR)（方案 3.2 / R10）
 * @returns {number}
 */
export function getClampedDpr() {
  return Math.min(window.devicePixelRatio || 1, MAX_DPR)
}

/**
 * 缓冲区（后备存储）尺寸：bufW = round(cssW * dpr)（方案 3.2）
 * @param {number} cssW
 * @param {number} cssH
 * @param {number} dpr
 * @returns {{ bufW: number, bufH: number }}
 */
export function computeBufferSize(cssW, cssH, dpr) {
  return { bufW: Math.round(cssW * dpr), bufH: Math.round(cssH * dpr) }
}

/**
 * 创建离屏保留掩码 canvas（纯 alpha 蒙版，填充颜色无关，实现填黑）。
 * filled=true 时全不透明（涂层保留）；false 时保持全透明（已刮穿/水合全开）。
 * @param {number} bufW 设备像素宽
 * @param {number} bufH 设备像素高
 * @param {boolean} filled
 * @returns {HTMLCanvasElement}
 */
export function createMaskCanvas(bufW, bufH, filled) {
  const mask = document.createElement('canvas')
  mask.width = bufW
  mask.height = bufH
  if (filled) {
    const maskCtx = mask.getContext('2d')
    maskCtx.fillStyle = '#000'
    maskCtx.fillRect(0, 0, bufW, bufH)
  }
  return mask
}

/**
 * resize 掩码迁移（方案 3.6 第 3 步）：newMask 先以 source-over 铺全不透明黑，
 * 再以 destination-in 把旧掩码等比 drawImage 映射（孔洞保留为透明）。
 * 禁止改成 destination-out（会把保留区打穿、孔洞反转）。
 * @param {HTMLCanvasElement} oldMask
 * @param {number} bufW 新缓冲区宽（设备像素）
 * @param {number} bufH 新缓冲区高（设备像素）
 * @returns {HTMLCanvasElement}
 */
export function rescaleMask(oldMask, bufW, bufH) {
  const newMask = createMaskCanvas(bufW, bufH, true)
  const newMaskCtx = newMask.getContext('2d')
  newMaskCtx.globalCompositeOperation = 'destination-in'
  newMaskCtx.drawImage(oldMask, 0, 0, oldMask.width, oldMask.height, 0, 0, bufW, bufH)
  newMaskCtx.globalCompositeOperation = 'source-over'
  return newMask
}

/**
 * 整卡全帧合成（方案 3.3 第 5 步 / 3.4 第 3 点，首帧不加 clip）：
 * 先 source-over 填涂层底色并绘制提示文字，再 destination-in 贴整幅掩码。
 * 调用前 ctx 必须已 setTransform(dpr,…)，w/h 使用 CSS 像素。
 * @param {CanvasRenderingContext2D} ctx 可见层上下文（已 setTransform）
 * @param {number} cssW
 * @param {number} cssH
 * @param {HTMLCanvasElement} maskCanvas
 * @param {{ color: string, text: string, textColor: string }} coating
 */
export function paintCoatingFrame(ctx, cssW, cssH, maskCanvas, coating) {
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, cssW, cssH)
  ctx.fillStyle = coating.color
  ctx.fillRect(0, 0, cssW, cssH)
  if (coating.text !== '') {
    ctx.fillStyle = coating.textColor
    ctx.font = `500 ${Math.max(13, Math.round(cssH * 0.1))}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(coating.text, cssW / 2, cssH / 2)
  }
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(maskCanvas, 0, 0, maskCanvas.width, maskCanvas.height, 0, 0, cssW, cssH)
  ctx.globalCompositeOperation = 'source-over'
}

/**
 * 对掩码打洞（方案 3.4 第 3 点）：destination-out 线段/圆点。
 * 掩码上下文不做 setTransform，坐标在此换算为设备像素。
 * from 为 null 或 from===to 时画 arc 实心圆点（pointerdown 首点）。
 * @param {CanvasRenderingContext2D} maskCtx
 * @param {number} dpr
 * @param {CssPoint | null} from CSS 像素起点
 * @param {CssPoint} to CSS 像素终点
 */
export function punchSegment(maskCtx, dpr, from, to) {
  const radiusDev = BRUSH_RADIUS_CSS * dpr
  maskCtx.globalCompositeOperation = 'destination-out'
  maskCtx.fillStyle = '#000'
  maskCtx.strokeStyle = '#000'
  maskCtx.lineCap = 'round'
  maskCtx.lineJoin = 'round'
  maskCtx.lineWidth = 2 * radiusDev
  if (!from || (from.x === to.x && from.y === to.y)) {
    maskCtx.beginPath()
    maskCtx.arc(to.x * dpr, to.y * dpr, radiusDev, 0, Math.PI * 2)
    maskCtx.fill()
  } else {
    maskCtx.beginPath()
    maskCtx.moveTo(from.x * dpr, from.y * dpr)
    maskCtx.lineTo(to.x * dpr, to.y * dpr)
    maskCtx.stroke()
  }
  maskCtx.globalCompositeOperation = 'source-over'
}

/**
 * 可见层脏矩形重绘（方案 3.4 第 3 点）：只重绘"线段包围盒 + 1 设备像素"。
 * 顺序固定：clip → clearRect → source-over 回填涂层底色（不重画文字）→
 * destination-in 以显式源/目标矩形贴掩码对应区域 → restore。
 * @param {CanvasRenderingContext2D} ctx 可见层上下文（已 setTransform）
 * @param {HTMLCanvasElement} maskCanvas
 * @param {number} dpr
 * @param {CssPoint | null} from
 * @param {CssPoint} to
 * @param {string} coatingColor
 */
export function repaintDirtyRect(ctx, maskCanvas, dpr, from, to, coatingColor) {
  const cssW = ctx.canvas.width / dpr
  const cssH = ctx.canvas.height / dpr
  const pad = BRUSH_RADIUS_CSS + 1 / dpr
  const ax = from ? from.x : to.x
  const ay = from ? from.y : to.y
  const x0 = Math.max(0, Math.min(ax, to.x) - pad)
  const y0 = Math.max(0, Math.min(ay, to.y) - pad)
  const x1 = Math.min(cssW, Math.max(ax, to.x) + pad)
  const y1 = Math.min(cssH, Math.max(ay, to.y) + pad)
  const dw = x1 - x0
  const dh = y1 - y0
  if (dw <= 0 || dh <= 0) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(x0, y0, dw, dh)
  ctx.clip()
  ctx.clearRect(x0, y0, dw, dh)
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = coatingColor
  ctx.fillRect(x0, y0, dw, dh)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(maskCanvas, x0 * dpr, y0 * dpr, dw * dpr, dh * dpr, x0, y0, dw, dh)
  ctx.restore()
}

/**
 * 创建固定 48×48 采样器 canvas（方案 3.5）
 * @returns {HTMLCanvasElement}
 */
export function createSampler() {
  const sampler = document.createElement('canvas')
  sampler.width = SAMPLE_GRID
  sampler.height = SAMPLE_GRID
  return sampler
}

/**
 * 等距 alpha 采样（方案 3.5）：掩码整体 GPU 缩放到 48×48 后读 9,216 字节，
 * alpha < ALPHA_CLEARED(16) 计为已擦除，返回 [0,1] 比例。
 * @param {HTMLCanvasElement} maskCanvas
 * @param {HTMLCanvasElement} samplerCanvas
 * @returns {number}
 */
export function sampleClearedRatio(maskCanvas, samplerCanvas) {
  const samplerCtx = samplerCanvas.getContext('2d')
  samplerCtx.clearRect(0, 0, SAMPLE_GRID, SAMPLE_GRID)
  samplerCtx.drawImage(maskCanvas, 0, 0, maskCanvas.width, maskCanvas.height, 0, 0, SAMPLE_GRID, SAMPLE_GRID)
  const data = samplerCtx.getImageData(0, 0, SAMPLE_GRID, SAMPLE_GRID).data
  const total = SAMPLE_GRID * SAMPLE_GRID
  let cleared = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < ALPHA_CLEARED) cleared += 1
  }
  return cleared / total
}

/**
 * PointerEvent → CSS 像素坐标（方案 3.2）：rect 每次事件现取，不缓存。
 * @param {{ clientX: number, clientY: number }} event
 * @param {{ left: number, top: number }} rect
 * @returns {CssPoint}
 */
export function eventToCssPoint(event, rect) {
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

/**
 * 超距线性插值兜底（方案 3.4 第 2 点 / R4）：gap > BRUSH_RADIUS_CSS 时
 * 按 ceil(gap / BRUSH_RADIUS_CSS) 在两点间补点；否则原样返回终点。
 * @param {CssPoint} from
 * @param {CssPoint} to
 * @returns {CssPoint[]}
 */
export function interpolatePoints(from, to) {
  const gap = Math.hypot(to.x - from.x, to.y - from.y)
  if (gap <= BRUSH_RADIUS_CSS) return [to]
  const steps = Math.ceil(gap / BRUSH_RADIUS_CSS)
  const points = []
  for (let i = 1; i <= steps; i += 1) {
    points.push({
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    })
  }
  return points
}
