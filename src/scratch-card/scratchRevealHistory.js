/**
 * 揭示顺序栈（Grid 工具栏“撤销”的语义核心）：纯数据模块，无 React/DOM 依赖，
 * 可用 node 直接单测。水合初值优先取 storage v2 的持久化顺序 order
 * （刷新后撤销栈跨刷新存活，最近揭示的在栈顶）；未提供 order 时退回按
 * records 的 ts 升序建栈（v1 迁移兜底）。揭示 push、撤销 pop、重置 clear；
 * 与 Grid 的 revealedIds、storage 由同一批事件同步维护。
 */

/**
 * @typedef {object} RevealHistory
 * @property {(cardId: string) => void} push 揭示入栈（自动全开与按钮全开同一路径）
 * @property {() => string | null} pop 弹出最近揭示的 cardId；空栈返回 null
 * @property {() => void} clear 重置全部时清空
 * @property {number} size 当前栈深（只读）
 * @property {() => string[]} toArray 栈快照（底→顶），测试/调试用
 */

/**
 * @param {Record<string, { v: 1, ts: number }>} [initialRecords]
 *   水合记录（须已与当前卡片数据做过交集）；用于校验 order 合法性与 ts 兜底
 * @param {string[]} [initialOrder] storage v2 持久化顺序（底→顶）；
 *   缺省或非数组时退回按 ts 升序建栈，ts 大者优先被撤销
 * @returns {RevealHistory}
 */
export function createRevealHistory(initialRecords = {}, initialOrder) {
  /** @type {string[]} */
  let order
  if (Array.isArray(initialOrder)) {
    // 以持久化顺序为准；只保留“记录存在且未重复”的项，顺序项失主不进内存栈
    const seen = new Set()
    order = []
    for (const cardId of initialOrder) {
      if (typeof cardId === 'string' && initialRecords[cardId] !== undefined && !seen.has(cardId)) {
        seen.add(cardId)
        order.push(cardId)
      }
    }
  } else {
    order = Object.entries(initialRecords)
      .sort((a, b) => a[1].ts - b[1].ts)
      .map(([cardId]) => cardId)
  }
  return {
    push(cardId) {
      order.push(cardId)
    },
    pop() {
      return order.length > 0 ? order.pop() : null
    },
    clear() {
      order = []
    },
    get size() {
      return order.length
    },
    toArray() {
      return [...order]
    },
  }
}
