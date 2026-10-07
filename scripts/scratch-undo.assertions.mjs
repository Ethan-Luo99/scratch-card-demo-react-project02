/**
 * "撤销上一张"（含跨刷新持久化）node 级断言（评审用）：
 *   node scripts/scratch-undo.assertions.mjs
 *
 * 直接 import 真实模块 src/scratch-card/scratchStorage.js 与
 * src/scratch-card/scratchRevealHistory.js，用 localStorage stub 验证
 * schema v2 持久化顺序、v1 迁移、孤儿防御与撤销一致性。GridSim 逐行镜像
 * ScratchCardGrid 的离散事件逻辑（reveal → markRevealed+push；undo →
 * 孤儿跳过循环 + pop + removeCard + delete；resetAll → clearAll+clear），
 * 其中 undo 的 removeCard 对应真实运行中单卡 reset() 内部对共享 storage
 * 的那一次写入。
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

/** 读取持久化 payload（schema v2 原生结构） */
function readRawPayload(key = STORAGE_KEY_BASE) {
  return JSON.parse(localStorageStub.getItem(key))
}

/** 镜像 ScratchCardGrid：revealedIds / history / storage 三者的同步维护 */
function createGridSim(storage, cards) {
  const stored = storage.readRevealed()
  const revealedIds = new Set(cards.filter((id) => stored[id]))
  const history = createRevealHistory(storage.readOrder())
  return {
    revealedIds,
    history,
    reveal(cardId) {
      storage.markRevealed(cardId)
      history.push(cardId)
      revealedIds.add(cardId)
    },
    undo() {
      const currentIds = new Set(cards)
      let cardId = history.pop()
      while (cardId !== null && !currentIds.has(cardId)) {
        storage.removeFromOrder(cardId) // 孤儿：只清持久化顺序，不动记录
        cardId = history.pop()
      }
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

// —— 1. v1 旧数据自动迁移：记录不丢失、顺序按 ts 升序、首次写回即为 v2 ——
{
  const v1 = {
    'demo-001': { v: 1, ts: 1000 },
    'demo-002': { v: 1, ts: 2000 },
    'demo-003': { v: 1, ts: 3000 },
  }
  window.localStorage.setItem(STORAGE_KEY_BASE, JSON.stringify(v1))
  const storage = createScratchStorage()
  const records = storage.readRevealed() // 首次读取即触发迁移 + 写回
  const order = storage.readOrder()
  const raw = readRawPayload()
  assert(
    records['demo-001'].ts === 1000 &&
      records['demo-002'].ts === 2000 &&
      records['demo-003'].ts === 3000 &&
      order.join(',') === 'demo-001,demo-002,demo-003' &&
      raw.schema === 2 &&
      raw.order.join(',') === 'demo-001,demo-002,demo-003',
    'A1 v1 旧数据迁移：记录全量保留，顺序按 ts 升序，首次写回为 schema v2',
  )
}

// —— 2. v1 旧数据迁移后撤销顺序正确（最近揭示优先），持久化顺序同步缩短 ——
{
  const v1 = {
    'demo-001': { v: 1, ts: 1000 },
    'demo-002': { v: 1, ts: 2000 },
    'demo-003': { v: 1, ts: 3000 },
  }
  window.localStorage.setItem(STORAGE_KEY_BASE, JSON.stringify(v1))
  const grid = createGridSim(createScratchStorage(), CARDS) // 迁移后水合
  const undo1 = grid.undo() && grid.revealedIds.has('demo-003') === false
  const orderAfter1 = readRawPayload().order.join(',')
  grid.undo()
  grid.undo()
  const raw = readRawPayload()
  assert(
    undo1 === true &&
      orderAfter1 === 'demo-001,demo-002' &&
      raw.schema === 2 &&
      raw.order.length === 0 &&
      Object.keys(raw.records).length === 0 &&
      grid.revealedIds.size === 0,
    'A2 v1 迁移后撤销顺序正确：demo-003→002→001 依次回滚，记录与持久化顺序同时为空',
  )
}

// —— 3. 孤儿 id 跳过：从持久化顺序清除、不空转、不误删他卡 ——
{
  const seeded = {
    schema: 2,
    records: {
      'demo-001': { v: 1, ts: 1000 },
      'demo-002': { v: 1, ts: 2000 },
      'ghost-1': { v: 1, ts: 3000 }, // 当前 cards 中已不存在
    },
    order: ['demo-001', 'demo-002', 'ghost-1'],
  }
  window.localStorage.setItem(STORAGE_KEY_BASE, JSON.stringify(seeded))
  const grid = createGridSim(createScratchStorage(), CARDS)
  const undone = grid.undo() // 栈顶 ghost-1 应被跳过，实际撤销 demo-002
  const raw = readRawPayload()
  assert(
    undone === true &&
      !grid.revealedIds.has('demo-002') &&
      grid.revealedIds.has('demo-001') &&
      raw.order.join(',') === 'demo-001' &&
      !!raw.records['demo-001'] &&
      !!raw.records['ghost-1'] && // 孤儿只清顺序，记录不动
      !raw.records['demo-002'],
    'A3 孤儿 id 跳过：ghost-1 从持久化顺序清除，实际撤销 demo-002，他卡不误删',
  )
}

// —— 4. 跨刷新存活：重建 storage + Grid（模拟刷新）后撤销立即可用、最近优先 ——
{
  window.localStorage.removeItem(STORAGE_KEY_BASE)
  const grid1 = createGridSim(createScratchStorage(), CARDS)
  grid1.reveal('demo-001')
  grid1.reveal('demo-002')
  grid1.reveal('demo-003')
  // 模拟页面刷新：全新 storage 实例 + 全新 Grid，同一份 localStorage
  const grid2 = createGridSim(createScratchStorage(), CARDS)
  const ready = grid2.revealedIds.size === 3 && grid2.history.size === 3
  grid2.undo()
  const raw = readRawPayload()
  assert(
    ready === true &&
      !grid2.revealedIds.has('demo-003') &&
      grid2.revealedIds.has('demo-002') &&
      raw.order.join(',') === 'demo-001,demo-002',
    'A4 刷新后撤销立即可用：水合 3 张已揭示，首次撤销回滚最近揭示的 demo-003',
  )
}

// —— 5. 撤销到空：记录与持久化顺序同时为空；空栈撤销 no-op 零写入 ——
{
  window.localStorage.removeItem(STORAGE_KEY_BASE)
  const storage = createScratchStorage()
  const grid = createGridSim(storage, CARDS)
  grid.reveal('demo-001')
  grid.reveal('demo-002')
  grid.undo()
  grid.undo()
  const raw = readRawPayload()
  const emptied =
    raw.schema === 2 &&
    raw.order.length === 0 &&
    Object.keys(raw.records).length === 0 &&
    grid.revealedIds.size === 0 &&
    grid.history.size === 0
  localStorageStub.resetWriteCount()
  const undoOnEmpty = grid.undo()
  assert(
    emptied === true && undoOnEmpty === false && localStorageStub.setItemCalls === 0,
    'A5 撤销到空：记录与持久化顺序同时为空；空栈撤销 no-op 且零 storage 写入',
  )
}

// —— 6. 重置全部：记录、持久化顺序、历史栈、revealedIds 四者同清 ——
{
  window.localStorage.removeItem(STORAGE_KEY_BASE)
  const storage = createScratchStorage()
  const grid = createGridSim(storage, CARDS)
  grid.reveal('demo-001')
  grid.reveal('demo-002')
  grid.resetAll()
  const raw = readRawPayload()
  assert(
    raw.order.length === 0 &&
      Object.keys(raw.records).length === 0 &&
      grid.revealedIds.size === 0 &&
      grid.history.size === 0 &&
      grid.undo() === false,
    'A6 重置全部：storage 记录/持久化顺序/history/revealedIds 同时归零',
  )
}

// —— 7. 单次撤销恰好一次写回（不双写）；连续快速撤销不串序；撤销后再揭示顺序正确 ——
{
  window.localStorage.removeItem(STORAGE_KEY_BASE)
  const storage = createScratchStorage()
  const grid = createGridSim(storage, CARDS)
  grid.reveal('demo-001')
  grid.reveal('demo-002')
  grid.reveal('demo-003')
  localStorageStub.resetWriteCount()
  grid.undo() // 撤销 demo-003
  const singleWrite = localStorageStub.setItemCalls === 1
  grid.undo() // 连续快速撤销 demo-002
  grid.undo() // 连续快速撤销 demo-001
  const emptiedInOrder =
    grid.revealedIds.size === 0 && readRawPayload().order.length === 0
  grid.reveal('demo-002') // 撤销后再揭示：重新入栈顶
  grid.reveal('demo-001')
  const raw = readRawPayload()
  assert(
    singleWrite === true &&
      emptiedInOrder === true &&
      raw.order.join(',') === 'demo-002,demo-001' &&
      grid.history.toArray().join(',') === 'demo-002,demo-001',
    'A7 单次撤销单次写回、连续撤销不串序、撤销后再揭示顺序仍最近优先',
  )
}

// —— 8. 命名空间隔离：本套撤销不影响其他命名空间的记录与顺序 ——
{
  window.localStorage.removeItem(STORAGE_KEY_BASE)
  window.localStorage.removeItem(`${STORAGE_KEY_BASE}:grid-a`)
  window.localStorage.removeItem(`${STORAGE_KEY_BASE}:grid-b`)
  const storageA = createScratchStorage('grid-a')
  const storageB = createScratchStorage('grid-b')
  storageB.markRevealed('demo-001')
  storageB.markRevealed('demo-002')
  const gridA = createGridSim(storageA, CARDS)
  gridA.reveal('demo-001')
  gridA.undo()
  const rawB = readRawPayload(`${STORAGE_KEY_BASE}:grid-b`)
  assert(
    Object.keys(storageA.readRevealed()).length === 0 &&
      storageA.readOrder().length === 0 &&
      rawB.order.join(',') === 'demo-001,demo-002' &&
      !!rawB.records['demo-001'] &&
      localStorageStub.getItem(STORAGE_KEY_BASE) === null,
    'A8 命名空间隔离：撤销只回滚本命名空间，其他命名空间与默认 key 不串状态',
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
