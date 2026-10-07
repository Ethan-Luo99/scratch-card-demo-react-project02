/**
 * 撤销栈跨刷新持久化 node 级断言（评审用）：
 *   node scripts/scratch-undo.assertions.mjs
 *
 * 直接 import 真实模块 src/scratch-card/scratchStorage.js 与
 * src/scratch-card/scratchRevealHistory.js，用 localStorage stub 验证
 * v1→v2 迁移、持久化顺序撤销、孤儿跳过/清除、单次撤销恰好一次写入。
 * GridSim 逐行镜像 ScratchCardGrid 的离散事件逻辑：挂载 readRevealState
 * + pruneReveal 水合净化；reveal → markRevealed+push；undo →
 * popReveal（+单卡 reset 内部那次 removeCard，应为零写 no-op）+pop+delete；
 * resetAll → clearAll+clear。
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
    raw(key = STORAGE_KEY_BASE) {
      return map.has(key) ? JSON.parse(map.get(key)) : null
    },
    seed(key, value) {
      map.set(key, JSON.stringify(value))
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
const VALID_IDS = new Set(CARDS)

/** 镜像 ScratchCardGrid：水合净化 + revealedIds / history / storage 同步维护 */
function createGridSim(storage, cards = CARDS) {
  const valid = new Set(cards)
  const state = storage.readRevealState()
  storage.pruneReveal(valid) // 对应真实 Grid 挂载水合净化 effect
  const validRecords = Object.fromEntries(
    Object.entries(state.records).filter(([id]) => valid.has(id)),
  )
  const history = createRevealHistory(validRecords, state.order)
  const revealedIds = new Set(Object.keys(validRecords))
  return {
    revealedIds,
    history,
    reveal(cardId) {
      storage.markRevealed(cardId)
      history.push(cardId)
      revealedIds.add(cardId)
    },
    undo() {
      const cardId = storage.popReveal(valid)
      if (cardId === null) return null
      storage.removeCard(cardId) // 真实运行中为单卡 reset() 内部的那次 removeCard
      history.pop()
      revealedIds.delete(cardId)
      return cardId
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

// —— 1. v1 旧数据迁移后撤销顺序正确（指定必含用例）——
{
  localStorageStub.seed(STORAGE_KEY_BASE, {
    'demo-001': { v: 1, ts: 1000 },
    'demo-002': { v: 1, ts: 2000 },
    'demo-003': { v: 1, ts: 3000 },
  })
  const storage = createScratchStorage()
  localStorageStub.resetWriteCount()
  const state = storage.readRevealState() // 首次读到 v1：按 ts 升序迁移并写回
  const persisted = localStorageStub.raw()
  const migratedOnce =
    localStorageStub.setItemCalls === 1 &&
    persisted !== null &&
    persisted.v === 2 &&
    Array.isArray(persisted.order)
  const recordsKept =
    state.records['demo-001'].ts === 1000 &&
    state.records['demo-002'].ts === 2000 &&
    state.records['demo-003'].ts === 3000
  const orderAsc = state.order.join(',') === 'demo-001,demo-002,demo-003'
  storage.readRevealState() // StrictMode 双挂载第二次读取：内容不变不双写
  const noDoubleWrite = localStorageStub.setItemCalls === 1
  const grid = createGridSim(storage)
  const undoOrder = [grid.undo(), grid.undo(), grid.undo()]
  const undoCorrect =
    undoOrder.join(',') === 'demo-003,demo-002,demo-001' &&
    grid.history.size === 0 &&
    grid.revealedIds.size === 0 &&
    localStorageStub.raw().order.length === 0
  assert(
    migratedOnce && recordsKept && orderAsc && noDoubleWrite && undoCorrect,
    'v1 旧数据迁移后撤销顺序正确：首次读取自动升 v2 且仅写一次、三条 v1 记录零丢失、order 按 ts 升序、双挂载不双写、刷新后撤销按 003→002→001 最近优先',
  )
}

// —— 2. 孤儿 id 跳过（指定必含用例）——
{
  localStorageStub.seed(STORAGE_KEY_BASE, {
    v: 2,
    records: {
      'demo-001': { v: 1, ts: 1000 },
      'demo-002': { v: 1, ts: 2000 },
      'orphan-x': { v: 1, ts: 2500 },
      'orphan-y': { v: 1, ts: 3000 },
    },
    // 栈顶连续两张孤儿，下面才是有效卡；另有一个夹在中间的孤儿
    order: ['demo-001', 'orphan-x', 'demo-002', 'orphan-y'],
  })
  const storage = createScratchStorage()
  localStorageStub.resetWriteCount()
  const first = storage.popReveal(VALID_IDS) // 一次撤销：跳过栈顶 orphan-y → 弹出 demo-002
  const afterFirst = storage.readRevealState()
  const firstCorrect =
    first === 'demo-002' &&
    afterFirst.order.join(',') === 'demo-001,orphan-x' && // 沿途孤儿 orphan-y 已清除，中间的 orphan-x 留待下次
    afterFirst.records['orphan-y'] === undefined &&
    afterFirst.records['demo-002'] === undefined &&
    afterFirst.records['demo-001'] !== undefined &&
    afterFirst.records['orphan-x'] !== undefined &&
    localStorageStub.setItemCalls === 1 // 跳过孤儿 + 弹有效卡只合并为一次写回，不空转
  const second = storage.popReveal(VALID_IDS) // 再撤销：跳过夹在中间的 orphan-x，弹出 demo-001
  const afterSecond = storage.readRevealState()
  const allClean =
    firstCorrect &&
    second === 'demo-001' &&
    localStorageStub.setItemCalls === 2 &&
    afterSecond.order.length === 0 &&
    Object.keys(afterSecond.records).length === 0
  assert(
    allClean,
    '孤儿 id 跳过：撤销自栈顶跳过当前 cards 已不存在的 id 并同步清除其记录与顺序项，一次撤销只写一次、不空转、不误删 demo-001/demo-002 以外有效卡',
  )
}

// —— 3. 跨刷新撤销：v2 持久化顺序重建栈，撤销最近揭示优先 ——
{
  const storageA = createScratchStorage('fresh-a')
  let grid = createGridSim(storageA)
  grid.reveal('demo-001')
  grid.reveal('demo-002')
  grid.reveal('demo-003')
  const storageB = createScratchStorage('fresh-a') // 刷新后新实例读同一 key
  grid = createGridSim(storageB)
  const order = [grid.history.pop(), grid.history.pop(), grid.history.pop()]
  assert(
    order.join(',') === 'demo-003,demo-002,demo-001' &&
      grid.revealedIds.size === 3 &&
      localStorageStub.raw('scratch-card:revealed:v1:fresh-a').v === 2,
    '页面刷新后撤销按钮立即可用：新实例水合即得 3 张已揭示，内存栈与持久化 order 一致，最近揭示优先撤销',
  )
}

// —— 4. 连续快速撤销到空：记录与持久化顺序同时为空，每次恰好一次写入 ——
{
  const storage = createScratchStorage('fast-undo')
  const grid = createGridSim(storage)
  grid.reveal('demo-001')
  grid.reveal('demo-002')
  localStorageStub.resetWriteCount()
  grid.undo()
  grid.undo() // 连续快速撤销（同一 tick 内无 await，严格串行）
  const state = storage.readRevealState()
  assert(
    localStorageStub.setItemCalls === 2 &&
      Object.keys(state.records).length === 0 &&
      state.order.length === 0 &&
      grid.revealedIds.size === 0 &&
      grid.history.size === 0,
    '连续撤销到空：两次撤销各写一次（无额外双写、不串序），揭示记录与持久化顺序同时为空',
  )
}

// —— 5. 空栈撤销零写入 no-op ——
{
  const storage = createScratchStorage('empty-undo')
  const grid = createGridSim(storage)
  localStorageStub.resetWriteCount()
  const popped = grid.undo()
  assert(
    popped === null &&
      localStorageStub.setItemCalls === 0 &&
      localStorageStub.raw('scratch-card:revealed:v1:empty-undo') === null,
    '空栈撤销为 no-op：返回 null、零 storage 写入，无 key 也不凭空创建',
  )
}

// —— 6. 撤销后立刻再刮（含同一张卡）——
{
  const storage = createScratchStorage('redo')
  const grid = createGridSim(storage)
  grid.reveal('demo-003')
  grid.undo()
  grid.reveal('demo-003') // 同一张卡再次揭示
  grid.undo()
  grid.reveal('demo-003')
  const state = storage.readRevealState()
  const record = state.records['demo-003']
  assert(
    !!record &&
      record.v === 1 &&
      Number.isFinite(record.ts) &&
      state.order.join(',') === 'demo-003' &&
      grid.revealedIds.has('demo-003') &&
      grid.history.size === 1,
    '撤销后立刻再刮：记录与顺序项可重新写入且不重复入栈，无串状态',
  )
}

// —— 7. 重置全部：records 与持久化 order 同清 ——
{
  const storage = createScratchStorage('reset-all')
  const grid = createGridSim(storage)
  grid.reveal('demo-001')
  grid.reveal('demo-002')
  grid.resetAll()
  const state = storage.readRevealState()
  assert(
    Object.keys(state.records).length === 0 &&
      state.order.length === 0 &&
      grid.revealedIds.size === 0 &&
      grid.history.size === 0 &&
      grid.undo() === null,
    '重置全部后揭示记录与持久化顺序同时归零，再撤销为 no-op',
  )
}

// —— 8. 命名空间隔离：水合净化/撤销/迁移均不串他套 key ——
{
  localStorageStub.seed('scratch-card:revealed:v1:ns-a', {
    v: 2,
    records: { 'demo-001': { v: 1, ts: 1 }, gone: { v: 1, ts: 2 } },
    order: ['demo-001', 'gone'],
  })
  localStorageStub.seed('scratch-card:revealed:v1:ns-b', {
    'demo-002': { v: 1, ts: 9 },
  })
  const storageA = createScratchStorage('ns-a')
  const storageB = createScratchStorage('ns-b')
  const gridA = createGridSim(storageA) // 挂载净化 ns-a 的孤儿 gone
  const stateB = storageB.readRevealState() // ns-b 独立完成 v1→v2
  gridA.undo()
  const a = localStorageStub.raw('scratch-card:revealed:v1:ns-a')
  const b = localStorageStub.raw('scratch-card:revealed:v1:ns-b')
  assert(
    a.order.length === 0 &&
      a.records['demo-001'] === undefined &&
      a.records.gone === undefined &&
      b.v === 2 &&
      b.order.join(',') === 'demo-002' &&
      b.records['demo-002'].ts === 9,
    '命名空间隔离：本套净化/撤销只动本 key，他套 v1 迁移与记录不受影响',
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
