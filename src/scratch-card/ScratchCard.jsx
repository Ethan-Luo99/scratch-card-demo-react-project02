import { useImperativeHandle, useState } from 'react'
import { useScratchCanvas } from './useScratchCanvas.js'

/**
 * @typedef {object} Prize
 * @property {string} title 奖品主文案，如"¥ 50 优惠券"
 * @property {string} subtitle 副文案，如"满 200 可用"；空串不渲染
 * @property {boolean} isWinning 是否中奖；仅决定 Grid 是否弹中奖提示，不改变刮擦行为
 */

/**
 * @typedef {object} ScratchCardApi 经 ref 暴露给 Grid 的命令式句柄（撤销用）
 * @property {() => void} reset 重置为全新未刮状态并同步清除持久化记录；幂等
 */

/**
 * @typedef {object} ScratchCardProps
 * @property {string} cardId 同 useScratchCanvas.cardId，同一张卡全局唯一
 * @property {Prize} prize
 * @property {boolean} initiallyRevealed 由 Grid 持久化层读入的初始状态
 * @property {(cardId: string, prize: Prize) => void} onReveal 自动全开时回调给 Grid
 * @property {import('./scratchStorage.js').ScratchStorage} storage Grid 注入的共享存储实例
 * @property {import('react').Ref<ScratchCardApi>} ref React 19 ref prop，暴露 ScratchCardApi
 */

const COATING_TEXT = '刮开查看奖品'

/**
 * 单卡视图组件（方案 2.2 / 3.1）：只输出结构（奖品层、涂层 canvas、a11y 节点、
 * 状态文案），ref 与句柄全部交给 useScratchCanvas，不写绘制与统计逻辑。
 * @param {ScratchCardProps} props
 */
export default function ScratchCard({ cardId, prize, initiallyRevealed, onReveal, storage, ref }) {
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

  const { canvasRef, containerRef, reveal, reset } = useScratchCanvas({
    cardId,
    initiallyRevealed: hydratedRevealed,
    coatingColor,
    coatingText: COATING_TEXT,
    storage,
    onReveal: () => onReveal(cardId, prize),
    onScratchStart: () => {
      // 触感反馈，不驱动渲染
      if (typeof navigator.vibrate === 'function') navigator.vibrate(10)
    },
  })

  // 撤销入口：Grid 经 ref 拿到 reset；reset 为 useCallback 固定引用，
  // 内部经 apiRef 派发到当前 effect 闭包，StrictMode 双挂载后始终指向存活实例
  useImperativeHandle(ref, () => ({ reset }), [reset])

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
