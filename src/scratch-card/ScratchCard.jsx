import { useState } from 'react'
import { useScratchCanvas } from './useScratchCanvas.js'

/**
 * @typedef {object} Prize
 * @property {string} title 奖品主文案，如"¥ 50 优惠券"
 * @property {string} subtitle 副文案，如"满 200 可用"；空串不渲染
 * @property {boolean} isWinning 是否中奖；仅决定 Grid 是否弹中奖提示，不改变刮擦行为
 */

/**
 * @typedef {object} ScratchCardProps
 * @property {string} cardId 同 useScratchCanvas.cardId，同一张卡全局唯一
 * @property {Prize} prize
 * @property {boolean} initiallyRevealed 由 Grid 持久化层读入的初始状态
 * @property {import('./scratchStorage.js').ScratchStorage} storage Grid 注入、多卡共享的同一存储实例
 * @property {(cardId: string, prize: Prize) => void} onReveal 自动全开时回调给 Grid
 */

const COATING_TEXT = '刮开查看奖品'

/**
 * 单卡视图组件（方案 2.2 / 3.1）：只输出结构（奖品层、涂层 canvas、a11y 节点、
 * 状态文案），ref 与句柄全部交给 useScratchCanvas，不写绘制与统计逻辑。
 * @param {ScratchCardProps} props
 */
export default function ScratchCard({ cardId, prize, initiallyRevealed, storage, onReveal }) {
  // initiallyRevealed 是"初始"水合输入（R11）：挂载后卡片自管状态，
  // 冻结首值避免揭示后 Grid 重渲染把 prop 翻成 true 触发 effect 重建、打断淡出动画
  const [hydratedRevealed] = useState(() => initiallyRevealed)
  // 涂层底色由组件从 CSS 变量读取一次后传入（方案 2.1 第 6 点 / 3.7）；
  // 变量定义在 :root，documentElement 与容器读取结果一致，且首渲染即可得、避免涂层闪色
  const [coatingColor] = useState(() => {
    const value = window
      .getComputedStyle(document.documentElement)
      .getPropertyValue('--scratch-coating')
      .trim()
    return value || '#c9c4d4'
  })

  const { canvasRef, containerRef, reveal } = useScratchCanvas({
    cardId,
    initiallyRevealed: hydratedRevealed,
    storage,
    coatingColor,
    coatingText: COATING_TEXT,
    onReveal: () => onReveal(cardId, prize),
    onScratchStart: () => {
      // 触感反馈，不驱动渲染
      if (typeof navigator.vibrate === 'function') navigator.vibrate(10)
    },
  })

  return (
    <div
      className="scratch-card"
      data-state={hydratedRevealed ? 'revealed' : 'sealed'}
      ref={containerRef}
    >
      <div className="scratch-card__prize">
        <span className="scratch-card__prize-title">{prize.title}</span>
        {prize.subtitle !== '' && (
          <span className="scratch-card__prize-subtitle">{prize.subtitle}</span>
        )}
      </div>
      <canvas className="scratch-card__coating" ref={canvasRef} aria-hidden="true" />
      <button type="button" className="scratch-card__reveal-btn" onClick={reveal}>
        刮开
      </button>
    </div>
  )
}
