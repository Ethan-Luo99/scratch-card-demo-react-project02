/**
 * 揭示顺序栈（Grid 工具栏"撤销"的语义核心）：纯数据模块，无 React/DOM 依赖，
 * 可用 node 直接单测。水合初值取 storage 持久化的揭示顺序（底→顶，栈顶=
 * 最近揭示），刷新后撤销立即可用且顺序不丢；揭示 push、撤销 pop、重置 clear；
 * 与 Grid 的 revealedIds 由同一批离散事件同步维护。
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
 * @param {string[]} [initialOrder]
 *   水合顺序（底→顶），直接取 scratchStorage.readOrder() 的持久化结果；
 *   不与当前卡片数据做交集——已不存在的孤儿 id 留在栈中，由 Grid 在撤销时
 *   跳过并同步清除出持久化顺序（孤儿防御）
 * @returns {RevealHistory}
 */
export function createRevealHistory(initialOrder = []) {
  let order = initialOrder.filter((cardId) => typeof cardId === 'string')
  return {
    push(cardId) {
      // 去重后入栈顶：与 storage.markRevealed 的顺序去重保持一致，
      // 同一卡在栈中至多出现一次，撤销不会弹出重复 id
      order = order.filter((id) => id !== cardId)
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
