/**
 * 多卡容器 + 中奖 toast 编排（方案 2.2）。React state 只保存离散结果
 * （已揭示 id 集合、toast 队列）；高频进度不进 state（R2）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ScratchCard from './ScratchCard.jsx'
import { SCRATCH_CARDS } from './scratchCards.data.js'
import { createScratchStorage } from './scratchStorage.js'
import './scratchCards.css'

const TOAST_DURATION_MS = 1800

/** @typedef {import('./ScratchCard.jsx').Prize} Prize */

/**
 * @typedef {Object} ScratchCardGridProps
 * @property {ReadonlyArray<{ cardId: string, prize: Prize }>} [cards] - 默认取 scratchCards.data.js 的导出；允许传入以便后续接接口，当前演示不传
 * @property {string} [storageNamespace] - 自定义存储命名空间后缀；默认 "v1"，与 storage schema 版本独立
 */

/** @param {ScratchCardGridProps} props */
export default function ScratchCardGrid({ cards = SCRATCH_CARDS, storageNamespace = 'v1' }) {
  const storage = useMemo(() => createScratchStorage(storageNamespace), [storageNamespace])
  // 挂载时同步读 storage（localStorage 同步 API，首渲染前可得），initiallyRevealed 只表达水合态（R11）
  const [initialRevealedIds] = useState(() => new Set(Object.keys(storage.readRevealed())))
  const [revealedIds, setRevealedIds] = useState(() => new Set(initialRevealedIds))
  const [toasts, setToasts] = useState([])
  const toastSeqRef = useRef(0)

  // toast 队列：最多同时 1 条、1800ms 自动消失，最新入队依次展示（R12）
  useEffect(() => {
    if (toasts.length === 0) return undefined
    const timer = setTimeout(() => {
      setToasts((queue) => queue.slice(1))
    }, TOAST_DURATION_MS)
    return () => clearTimeout(timer)
  }, [toasts])

  const handleReveal = useCallback(
    (cardId, prize) => {
      // storage 写入与 setState 在同一个 onReveal 调用栈内同步完成（R9）
      storage.markRevealed(cardId)
      setRevealedIds((prev) => {
        if (prev.has(cardId)) return prev
        const next = new Set(prev)
        next.add(cardId)
        return next
      })
      const id = (toastSeqRef.current += 1)
      const text = prize.isWinning ? `恭喜中奖：${prize.title}` : '谢谢参与'
      setToasts((queue) => [...queue, { id, text }])
    },
    [storage],
  )

  return (
    <section className="scratch-grid-wrap">
      <p className="scratch-grid__status">
        已刮开 {revealedIds.size} / {cards.length} 张
      </p>
      <div className="scratch-grid">
        {cards.map((card) => (
          <ScratchCard
            key={card.cardId}
            cardId={card.cardId}
            prize={card.prize}
            initiallyRevealed={initialRevealedIds.has(card.cardId)}
            onReveal={handleReveal}
          />
        ))}
      </div>
      {toasts.length > 0 && (
        <div className="scratch-toast" role="status" aria-live="polite">
          {toasts[0].text}
        </div>
      )}
    </section>
  )
}
