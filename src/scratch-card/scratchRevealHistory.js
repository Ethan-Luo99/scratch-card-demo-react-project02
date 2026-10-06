/**
 * 揭示顺序栈（Grid 工具栏"撤销"的语义核心）：纯数据模块，无 React/DOM 依赖，
 * 可用 node 直接单测。水合初值取 storage 记录按 ts 升序（最近揭示的在栈顶），
 * 揭示 push、撤销 pop、重置 clear；与 Grid 的 revealedIds 由同一批事件同步维护。
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
 *   水合记录（须已与当前卡片数据做过交集）；按 ts 升序建栈，ts 大者优先被撤销
 * @returns {RevealHistory}
 */
export function createRevealHistory(initialRecords = {}) {
  let order = Object.entries(initialRecords)
    .sort((a, b) => a[1].ts - b[1].ts)
    .map(([cardId]) => cardId)
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
