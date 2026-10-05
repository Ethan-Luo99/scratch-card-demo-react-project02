/**
 * 单卡视图组件（方案 2.2 / 3.1）。只输出结构（奖品层、涂层 canvas、a11y 节点、
 * 状态文案），ref 与句柄全部交给 useScratchCanvas，不写绘制与统计逻辑。
 */

import { useState } from 'react'
import { useScratchCanvas } from './useScratchCanvas.js'

const COATING_TEXT = '刮开查看奖品'
const FALLBACK_COATING_COLOR = '#c9c4d4'

// 组件从 CSS 变量读取涂层底色后传给 hook，引擎不读样式表（方案 2.1 第 6 点）
function readCoatingColor() {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--scratch-coating').trim()
  return value || FALLBACK_COATING_COLOR
}

/**
 * @typedef {Object} Prize
 * @property {string} title - 奖品主文案，如"¥ 50 优惠券"
 * @property {string} subtitle - 副文案，如"满 200 可用"；空串不渲染
 * @property {boolean} isWinning - 是否中奖；仅决定 Grid 是否弹中奖提示，不改变刮擦行为
 */

/**
 * @typedef {Object} ScratchCardProps
 * @property {string} cardId - 同 useScratchCanvas.cardId，同一张卡全局唯一
 * @property {Prize} prize
 * @property {boolean} initiallyRevealed - 由 Grid 持久化层读入的初始状态
 * @property {(cardId: string, prize: Prize) => void} onReveal - 自动全开时由本卡回调给 Grid（参数为 cardId）
 */

/** @param {ScratchCardProps} props */
export default function ScratchCard({ cardId, prize, initiallyRevealed, onReveal }) {
  const [coatingColor] = useState(readCoatingColor)
  const [revealed, setRevealed] = useState(initiallyRevealed)
  const [progressPct, setProgressPct] = useState(initiallyRevealed ? 100 : 0)

  const { canvasRef, containerRef, reveal } = useScratchCanvas({
    cardId,
    initiallyRevealed,
    coatingColor,
    coatingText: COATING_TEXT,
    onProgress: (ratio) => {
      setProgressPct(Math.floor(ratio * 100))
    },
    onReveal: () => {
      setRevealed(true)
      setProgressPct(100)
      onReveal(cardId, prize)
    },
  })

  return (
    <div
      className="scratch-card"
      data-state={initiallyRevealed ? 'revealed' : 'sealed'}
      ref={containerRef}
    >
      <div className="scratch-card__prize">
        <span className="scratch-card__prize-title">{prize.title}</span>
        {prize.subtitle !== '' && (
          <span className="scratch-card__prize-subtitle">{prize.subtitle}</span>
        )}
      </div>
      <canvas className="scratch-card__coating" ref={canvasRef} aria-hidden="true" />
      <span className="visually-hidden">
        {revealed ? `已刮开：${prize.title}` : `未刮开，已刮 ${progressPct}%`}
      </span>
      <button
        type="button"
        className="scratch-card__reveal-btn"
        disabled={revealed}
        onClick={reveal}
      >
        刮开
      </button>
    </div>
  )
}
