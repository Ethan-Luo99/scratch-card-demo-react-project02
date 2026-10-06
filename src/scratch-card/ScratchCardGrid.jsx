import { useCallback, useEffect, useRef, useState } from 'react'
import ScratchCard from './ScratchCard.jsx'
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
  // 挂载时同步 readRevealed（localStorage 同步 API，首渲染前可得，R11 无闪烁水合）；
  // 与当前卡片数据做交集，已不存在的孤儿 id 忽略不渲染（方案 5.4 第 6 步）。
  // 同一份读取同时得出"已揭示集合"与"揭示顺序"（按 ts 升序），撤销按顺序回滚。
  const [hydrate] = useState(() => {
    const stored = storage.readRevealed()
    const orderedIds = cards
      .filter((card) => stored[card.cardId])
      .sort((a, b) => stored[a.cardId].ts - stored[b.cardId].ts)
      .map((card) => card.cardId)
    return { ids: new Set(orderedIds), order: orderedIds }
  })
  const [revealedIds, setRevealedIds] = useState(hydrate.ids)
  /** 揭示顺序（最新在尾）：撤销时弹出末尾；ref 保存，渲染态仍以 revealedIds 为准 */
  const revealOrderRef = useRef([...hydrate.order])
  const [toastQueue, setToastQueue] = useState(/** @type {{ id: number, text: string }[]} */ ([]))
  const [resetKey, setResetKey] = useState(0)
  /** 单卡撤销重挂载计数：仅被撤销的卡片换 key，其余卡片的 canvas/状态不受影响 */
  const [undoSalts, setUndoSalts] = useState(/** @type {Record<string, number>} */ ({}))
  const toastSeqRef = useRef(0)

  /** @type {(cardId: string, prize: Prize) => void} */
  const handleReveal = useCallback(
    (cardId, prize) => {
      // storage 写入与 setState 在同一调用栈内同步完成（R9）
      storage.markRevealed(cardId)
      if (!revealOrderRef.current.includes(cardId)) revealOrderRef.current.push(cardId)
      setRevealedIds((prev) => {
        const next = new Set(prev)
        next.add(cardId)
        return next
      })
      toastSeqRef.current += 1
      const text = prize.isWinning ? `恭喜中奖：${prize.title}` : '谢谢参与'
      setToastQueue((prev) => [...prev, { id: toastSeqRef.current, text }])
    },
    [storage],
  )

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
    revealOrderRef.current = []
    setRevealedIds(new Set())
    setToastQueue([])
    // 通过 key 重挂载全部卡片，回到全新未刮状态
    setResetKey((key) => key + 1)
  }

  /**
   * 撤销最近一次揭示（自动全开或按钮全开均可）。离散事件，允许 setState；
   * 四状态源在同一事件内一致回滚：
   * ① storage 记录（共享实例 removeCard，幂等）；
   * ② Grid revealedIds 与揭示顺序 ref；
   * ③/④ 通过换 key 重挂载该卡：掩码/涂层重建为全不透明、指针监听重新挂载、
   *   hook 内部 revealed/ratio 随 initiallyRevealed=false 重新初始化。
   * storage 删除放在 setState updater 之外执行，StrictMode 双调用 updater 也不会双写。
   */
  const handleUndoLast = () => {
    const cardId = revealOrderRef.current.at(-1)
    if (!cardId) return
    revealOrderRef.current = revealOrderRef.current.slice(0, -1)
    storage.removeCard(cardId)
    setRevealedIds((prev) => {
      const next = new Set(prev)
      next.delete(cardId)
      return next
    })
    setUndoSalts((prev) => ({ ...prev, [cardId]: (prev[cardId] ?? 0) + 1 }))
  }

  return (
    <section className="scratch-section" aria-label="刮刮卡演示">
      <div className="scratch-toolbar">
        <button
          type="button"
          className="scratch-reset"
          onClick={handleUndoLast}
          disabled={revealedIds.size === 0}
        >
          撤销上一张
        </button>
        <button type="button" className="scratch-reset" onClick={handleResetAll}>
          重置全部卡片
        </button>
      </div>
      <div className="scratch-grid">
        {cards.map((card) => (
          <ScratchCard
            key={`${resetKey}:${card.cardId}:${undoSalts[card.cardId] ?? 0}`}
            cardId={card.cardId}
            prize={card.prize}
            initiallyRevealed={revealedIds.has(card.cardId)}
            storage={storage}
            onReveal={handleReveal}
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
