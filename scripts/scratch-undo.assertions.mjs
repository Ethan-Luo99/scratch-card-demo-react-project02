/**
 * "撤销上一张" node 级断言（评审用）：
 *   node scripts/scratch-undo.assertions.mjs
 *
 * 直接 import 真实模块 src/scratch-card/scratchStorage.js 与
 * src/scratch-card/scratchRevealHistory.js，用 localStorage stub 验证
 * storage 回滚与 revealedIds 语义。GridSim 逐行镜像 ScratchCardGrid 的
 * 离散事件逻辑（reveal → markRevealed+push；undo → pop+removeCard+delete；
 * resetAll → clearAll+clear），其中 undo 的 removeCard 对应真实运行中
 * 单卡 reset() 内部对共享 storage 的那一次写入。
 */
import { createScratchStorage, STORAGE_KEY_BASE } from '../src/scratch-card/scratchStorage.js'
import { createRevealHistory } from '../src/scratch-card/scratchRevealHistory.js'

function createLocalStorageStub() {
  const map = new Map()
  const stub = {
    setItemCalls: 0,
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      stub.setItemCalls += 1
      map.set(key, String(value))
    },
    removeItem(key) {
      map.delete(key)
    },
    resetWriteCount() {
      stub.setItemCalls = 0
    },
  }
  return stub
}

const localStorageStub = createLocalStorageStub()
globalThis.window = { localStorage: localStorageStub }

const CARDS = ['demo-001', 'demo-002', 'demo-003']

/** 镜像 ScratchCardGrid：revealedIds / history / storage 三者的同步维护 */
function createGridSim(storage, cards) {
  const stored = storage.readRevealed()
  const revealedIds = new Set(cards.filter((id) => stored[id]))
  const validRecords = {}
  for (const id of cards) {
    if (stored[id]) validRecords[id] = stored[id]
  }
  const history = createRevealHistory(validRecords)
  return {
    revealedIds,
    history,
    reveal(cardId) {
      storage.markRevealed(cardId)
      history.push(cardId)
      revealedIds.add(cardId)
    },
    undo() {
      const cardId = history.pop()
      if (cardId === null) return false
      storage.removeCard(cardId) // 真实运行中为单卡 reset() 内部的那一次写入
      revealedIds.delete(cardId)
      return true
    },
    resetAll() {
      storage.clearAll()
      history.clear()
      revealedIds.clear()
    },
  }
}

let passed = 0
let failed = 0
function assert(condition, name) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}

// —— 1. 注入共享实例：自定义 namespace 的 key 被正确读写，默认 key 不受污染 ——
{
  const storage = createScratchStorage('grid-a')
  const grid = createGridSim(storage, CARDS)
  grid.reveal('demo-001')
  const namespacedKey = `${STORAGE_KEY_BASE}:grid-a`
  assert(
    localStorageStub.getItem(namespacedKey) !== null &&
      localStorageStub.getItem(STORAGE_KEY_BASE) === null,
    'A1 共享 storage 实例写自定义命名空间 key，默认 key 保持未写（reset 清错 key 隐患消除）',
  )
  grid.undo()
  assert(
    localStorageStub.getItem(namespacedKey) === '{}' && grid.revealedIds.size === 0,
    'A1b 撤销后同一命名空间 key 被回滚为空记录',
  )
}

// —— 2~5. 主流程：连续撤销、撤销到空、单写、撤销后再刮 ——
{
  localStorageStub.resetWriteCount()
  const storage = createScratchStorage()
  const grid = createGridSim(storage, CARDS)
  grid.reveal('demo-001')
  grid.reveal('demo-002')

  grid.undo() // 撤销最近揭示的 demo-002
  const stored = storage.readRevealed()
  assert(
    !stored['demo-002'] &&
      !!stored['demo-001'] &&
      !grid.revealedIds.has('demo-002') &&
      grid.revealedIds.has('demo-001'),
    'A2 撤销最近一次揭示：storage 与 revealedIds 同步移除该卡、其余卡保留',
  )

  localStorageStub.resetWriteCount()
  grid.undo() // 再撤销 demo-001
  assert(
    localStorageStub.setItemCalls === 1 &&
      Object.keys(storage.readRevealed()).length === 0 &&
      grid.revealedIds.size === 0,
    'A3 连续撤销到空：单次撤销恰好一次 storage 写入（不双写），两个状态源同时清空',
  )

  localStorageStub.resetWriteCount()
  const undoOnEmpty = grid.undo()
  assert(
    undoOnEmpty === false && localStorageStub.setItemCalls === 0,
    'A4 空栈撤销为 no-op：返回 false 且零 storage 写入',
  )

  grid.reveal('demo-003') // 撤销后立刻再刮（按钮/自动同一 reveal 路径）
  grid.undo()
  grid.reveal('demo-003') // 撤销后同一张卡再次揭示
  const record = storage.readRevealed()['demo-003']
  assert(
    !!record && record.v === 1 && Number.isFinite(record.ts) && grid.revealedIds.has('demo-003'),
    'A5 撤销后立刻再刮：记录可重新写入且 revealedIds 重新包含，无串状态',
  )
}

// —— 6. 水合顺序：ts 大者（最近揭示）优先被撤销 ——
{
  const storage = createScratchStorage()
  storage.markRevealed('demo-001')
  const records = storage.readRevealed()
  records['demo-002'] = { v: 1, ts: records['demo-001'].ts + 1000 }
  records['demo-003'] = { v: 1, ts: records['demo-001'].ts + 2000 }
  window.localStorage.setItem(STORAGE_KEY_BASE, JSON.stringify(records))
  const grid = createGridSim(storage, CARDS) // 重新水合
  const undoOrder = [grid.history.pop(), grid.history.pop(), grid.history.pop()]
  assert(
    undoOrder[0] === 'demo-003' && undoOrder[1] === 'demo-002' && undoOrder[2] === 'demo-001',
    'A6 水合后撤销顺序按 ts 倒序（最近揭示优先），与 revealedIds 初始集合一致',
  )
}

// —— 7. 命名空间隔离：另一套 grid 的记录不受本套撤销影响 ——
{
  const storageA = createScratchStorage('grid-a')
  const storageB = createScratchStorage('grid-b')
  storageB.markRevealed('demo-001')
  const gridA = createGridSim(storageA, CARDS)
  gridA.reveal('demo-001')
  gridA.undo()
  assert(
    !!storageB.readRevealed()['demo-001'] && Object.keys(storageA.readRevealed()).length === 0,
    'A7 撤销只回滚本命名空间记录，其他命名空间不串状态',
  )
}

// —— 8. 重置全部：clearAll 后三个状态源同时归零 ——
{
  const storage = createScratchStorage()
  const grid = createGridSim(storage, CARDS)
  grid.reveal('demo-001')
  grid.reveal('demo-002')
  grid.resetAll()
  assert(
    Object.keys(storage.readRevealed()).length === 0 &&
      grid.revealedIds.size === 0 &&
      grid.history.size === 0 &&
      grid.undo() === false,
    'A8 重置全部后 storage/revealedIds/历史栈同时归零，撤销为 no-op',
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
