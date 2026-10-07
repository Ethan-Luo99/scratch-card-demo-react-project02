import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  // 挂载时同步 readRevealState（localStorage 同步 API，首渲染前可得，R11 无闪烁水合）：
  // v1 裸记录在此被按 ts 升序迁移为 v2 并首次写回；正常 v2 幂等读取零写入
  const [initialState] = useState(() => storage.readRevealState())
  // 当前卡片数据的有效 id 集合：撤销/净化以此为准，已不存在的孤儿 id 跳过并清除
  const cardIds = useMemo(() => new Set(cards.map((card) => card.cardId)), [cards])
  // 与当前卡片数据做交集，已不存在的孤儿 id 忽略不渲染（方案 5.4 第 6 步）
  const [revealedIds, setRevealedIds] = useState(
    () =>
      new Set(
        cards.filter((card) => initialState.records[card.cardId]).map((card) => card.cardId),
      ),
  )
  // 撤销顺序栈：水合初值优先取 storage v2 持久化顺序（刷新后撤销立即可用）；
  // 与 revealedIds、storage 由同一批离散事件同步维护（揭示 push / 撤销 pop /
  // 重置 clear），不引入高频 setState
  const [history] = useState(() => {
    const validRecords = {}
    for (const card of cards) {
      if (initialState.records[card.cardId]) {
        validRecords[card.cardId] = initialState.records[card.cardId]
      }
    }
    return createRevealHistory(validRecords, initialState.order)
  })
  const [toastQueue, setToastQueue] = useState(/** @type {{ id: number, text: string }[]} */ ([]))
  const [resetKey, setResetKey] = useState(0)
  const toastSeqRef = useRef(0)
  /** @type {import('react').MutableRefObject<Map<string, import('./ScratchCard.jsx').ScratchCardApi>>} */
  const cardApisRef = useRef(new Map())

  // 水合净化：把持久化层中当前 cards 已不存在的孤儿记录/顺序项同步清掉（5.4 第 6 步）。
  // 幂等 + 内容不变不写盘：StrictMode 双挂载第二次调用、刷新重复进入均零额外写入。
  useEffect(() => {
    storage.pruneReveal(cardIds)
  }, [storage, cardIds])

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
   * 撤销最近一次揭示（自动全开/按钮全开同一路径，刷新后持久化顺序同样最近优先）。
   * storage.popReveal 是唯一撤销写入口：自栈顶跳过并清除孤儿后弹出有效 id，
   * 记录与持久化顺序在一次写回内同步回滚（恰好一次写入，无双写/串序窗口）。
   * 随后内存 history 同步弹出（正常路径与持久化结果相同），再让单卡 reset()
   * 复位涂层/掩码：该 reset 内部的 removeCard 删除的正是已不存在的记录，
   * 内容不变 → storage 不产生第二次写盘（空转撤销零写入）。
   */
  const handleUndo = useCallback(() => {
    const cardId = storage.popReveal(cardIds)
    if (cardId === null) {
      // 栈空（或尾部全为已被 popReveal 清掉的孤儿）：内存栈对齐持久化顺序，
      // 揭示记录与持久化顺序同时为空，撤销按钮即置灰
      const alive = storage.readRevealState().order.filter((id) => cardIds.has(id))
      history.clear()
      for (const id of alive) history.push(id)
      setRevealedIds((prev) => {
        const next = new Set(prev)
        for (const id of next) {
          if (!cardIds.has(id)) next.delete(id)
        }
        return next
      })
      return
    }
    history.pop()
    const api = cardApisRef.current.get(cardId)
    if (api) {
      api.reset() // 复位 canvas 涂层/掩码/监听；内部 removeCard 为内容不变的零写 no-op
    } else {
      storage.removeCard(cardId) // 兜底：卡片未挂载时同样内容不变，零写
    }
    setRevealedIds((prev) => {
      const next = new Set(prev)
      next.delete(cardId)
      return next
    })
  }, [storage, history, cardIds])

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
