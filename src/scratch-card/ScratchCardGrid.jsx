import { useCallback, useEffect, useRef, useState } from 'react'
import ScratchCard from './ScratchCard.jsx'
import { createRevealHistory } from './scratchRevealHistory.js'
import { createScratchStorage } from './scratchStorage.js'
import { SCRATCH_CARDS } from './scratchCards.data.js'
import './scratchCards.css'

/** toast 自动消失时长（方案 R12：最多同时 1 条、1800ms） */
const TOAST_DURATION_MS = 1800

/**
 * @typedef {import('./ScratchCard.jsx').Prize} Prize
 */

/**
 * @typedef {object} ScratchCardGridProps
 * @property {ReadonlyArray<{ cardId: string, prize: Prize }>} [cards]
 *   默认取 scratchCards.data.js 的导出；允许传入以便后续接接口，当前演示不传
 * @property {string} [storageNamespace] 自定义存储命名空间后缀；默认 "v1"
 */

/**
 * 多卡容器 + 中奖 toast 编排（方案 2.2）。
 * React state 只保存离散结果（已揭示 id 集合、toast 队列）；高频进度不进 state（R2）。
 * @param {ScratchCardGridProps} props
 */
export default function ScratchCardGrid({ cards = SCRATCH_CARDS, storageNamespace }) {
  const [storage] = useState(() => createScratchStorage(storageNamespace))
  // 挂载时同步 readRevealed（localStorage 同步 API，首渲染前可得，R11 无闪烁水合）
  const [initialRecords] = useState(() => storage.readRevealed())
  // 与当前卡片数据做交集，已不存在的孤儿 id 忽略不渲染（方案 5.4 第 6 步）
  const [revealedIds, setRevealedIds] = useState(
    () => new Set(cards.filter((card) => initialRecords[card.cardId]).map((card) => card.cardId)),
  )
  // 撤销顺序栈：水合初值按 ts 升序（最近揭示在栈顶）；与 revealedIds 由同一批
  // 离散事件同步维护（揭示 push / 撤销 pop / 重置 clear），不引入高频 setState
  const [history] = useState(() => {
    const validRecords = {}
    for (const card of cards) {
      if (initialRecords[card.cardId]) validRecords[card.cardId] = initialRecords[card.cardId]
    }
    return createRevealHistory(validRecords)
  })
  const [toastQueue, setToastQueue] = useState(/** @type {{ id: number, text: string }[]} */ ([]))
  const [resetKey, setResetKey] = useState(0)
  const toastSeqRef = useRef(0)
  /** @type {import('react').MutableRefObject<Map<string, import('./ScratchCard.jsx').ScratchCardApi>>} */
  const cardApisRef = useRef(new Map())

  /** @type {(cardId: string, prize: Prize) => void} */
  const handleReveal = useCallback(
    (cardId, prize) => {
      // storage 写入与 setState 在同一调用栈内同步完成（R9）
      storage.markRevealed(cardId)
      history.push(cardId)
      setRevealedIds((prev) => {
        const next = new Set(prev)
        next.add(cardId)
        return next
      })
      toastSeqRef.current += 1
      const text = prize.isWinning ? `恭喜中奖：${prize.title}` : '谢谢参与'
      setToastQueue((prev) => [...prev, { id: toastSeqRef.current, text }])
    },
    [storage, history],
  )

  /**
   * 撤销最近一次揭示（自动全开/按钮全开同一路径，水合记录按 ts 倒序）。
   * 四个状态源严格一致回滚：revealedIds 在此删除；storage 记录、canvas 掩码与
   * 涂层、指针监听与 revealed/ratio 内部状态由单卡 reset() 一次完成——
   * reset 内部对共享 storage 恰好写入一次，Grid 不再重复写（不得双写）。
   */
  const handleUndo = useCallback(() => {
    const cardId = history.pop()
    if (cardId === null) return // 撤销到空：no-op
    const api = cardApisRef.current.get(cardId)
    if (api) {
      api.reset()
    } else {
      storage.removeCard(cardId) // 兜底：卡片未挂载时仍保证存储回滚
    }
    setRevealedIds((prev) => {
      const next = new Set(prev)
      next.delete(cardId)
      return next
    })
  }, [storage, history])

  const activeToast = toastQueue[0]
  useEffect(() => {
    if (!activeToast) return undefined
    const timer = window.setTimeout(() => {
      setToastQueue((prev) => prev.slice(1))
    }, TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [activeToast])

  const handleResetAll = () => {
    storage.clearAll()
    history.clear()
    setRevealedIds(new Set())
    setToastQueue([])
    // 通过 key 重挂载全部卡片，回到全新未刮状态
    setResetKey((key) => key + 1)
  }

  return (
    <section className="scratch-section" aria-label="刮刮卡演示">
      <div className="scratch-toolbar">
        <button
          type="button"
          className="scratch-undo"
          onClick={handleUndo}
          disabled={revealedIds.size === 0}
        >
          撤销
        </button>
        <button type="button" className="scratch-reset" onClick={handleResetAll}>
          重置全部卡片
        </button>
      </div>
      <div className="scratch-grid">
        {cards.map((card) => (
          <ScratchCard
            key={`${resetKey}:${card.cardId}`}
            ref={(api) => {
              // React 19 ref callback：卸载/重置重挂载时以 null 回调，保证句柄表不残留
              if (api === null) {
                cardApisRef.current.delete(card.cardId)
              } else {
                cardApisRef.current.set(card.cardId, api)
              }
            }}
            cardId={card.cardId}
            prize={card.prize}
            initiallyRevealed={revealedIds.has(card.cardId)}
            onReveal={handleReveal}
            storage={storage}
          />
        ))}
      </div>
      {activeToast && (
        <div className="scratch-toast" role="status">
          {activeToast.text}
        </div>
      )}
    </section>
  )
}
