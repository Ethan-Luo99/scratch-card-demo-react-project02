/**
 * 撤销上一张：storage 回滚与 Grid revealedIds 语义的 node 级断言（无 npm 依赖）。
 * 运行：node scripts/scratch-storage-undo.test.mjs
 *
 * 断言以 localStorage stub 直接驱动 scratchStorage.js，并用与 ScratchCardGrid
 * 相同的纯函数式操作复现 revealedIds(Set)/揭示顺序 的回滚语义。
 */
import assert from 'node:assert/strict'

/**
 * 最小 localStorage stub：记录每次 setItem，供断言"无双写/写入次数"。
 * @returns {{ store: Map<string,string>, setCount: number, storage: Storage }}
 */
function createLocalStorageStub() {
  const store = new Map()
  const state = { setCount: 0 }
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      state.setCount += 1
      store.set(key, String(value))
    },
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  }
  return { store, get setCount() { return state.setCount }, storage }
}

/**
 * 绑定一份全新 stub 并动态导入存储模块（模块零 npm 依赖，可在 node 直接运行）。
 * @param {string} [namespace]
 */
async function createHarness(namespace) {
  const stub = createLocalStorageStub()
  globalThis.window = { localStorage: stub.storage }
  globalThis.localStorage = stub.storage
  const module = await import(
    `../src/scratch-card/scratchStorage.js?t=${Date.now()}-${Math.random()}`
  )
  return { storage: module.createScratchStorage(namespace), stub }
}

/**
 * 复现 Grid 侧离散状态机：revealedIds(Set) + 揭示顺序数组，
 * reveal/undo 的操作顺序与 ScratchCardGrid.handleReveal/handleUndoLast 一致。
 */
function createGridStateModel() {
  return { revealedIds: new Set(), order: [] }
}
function modelReveal(model, id) {
  if (!model.order.includes(id)) model.order.push(id)
  model.revealedIds.add(id)
}
function modelUndo(model) {
  const id = model.order.pop()
  if (id) model.revealedIds.delete(id)
  return id
}

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok ${passed} - ${name}`)
}

const readJson = (stub, key = 'scratch-card:revealed:v1') =>
  JSON.parse(stub.store.get(key) ?? '{}')

// ① markRevealed 后 storage 单 key 含且仅含该卡记录（v=1 + 数值 ts）
{
  const { storage, stub } = await createHarness()
  storage.markRevealed('demo-001')
  const records = storage.readRevealed()
  check('markRevealed 后 readRevealed 含该卡且记录合法', () => {
    assert.deepEqual(Object.keys(records), ['demo-001'])
    assert.equal(records['demo-001'].v, 1)
    assert.equal(typeof records['demo-001'].ts, 'number')
    assert.ok(Number.isFinite(records['demo-001'].ts))
    assert.equal(stub.store.has('scratch-card:revealed:v1'), true)
  })
}

// ② 撤销：removeCard 精确删除最近一张，其余记录与 JSON key 内容原样保留
{
  const { storage, stub } = await createHarness()
  storage.markRevealed('demo-001')
  storage.markRevealed('demo-002')
  storage.removeCard('demo-002')
  check('removeCard 撤销最近一张，只删该卡、其余记录保留', () => {
    assert.deepEqual(Object.keys(storage.readRevealed()).sort(), ['demo-001'])
    assert.deepEqual(Object.keys(readJson(stub)), ['demo-001'])
  })
}

// ③ 连续撤销到空：再删/撤销空集合幂等，readRevealed() 返回 {}
{
  const { storage } = await createHarness()
  storage.markRevealed('demo-001')
  storage.markRevealed('demo-003')
  storage.removeCard('demo-003')
  storage.removeCard('demo-001')
  storage.removeCard('demo-001') // 撤销到空后再次撤销：不报错、不产生脏记录
  check('连续撤销至空后继续撤销保持空且幂等', () => {
    assert.deepEqual(storage.readRevealed(), {})
  })
}

// ④ 撤销后重新揭示同一张：记录重新出现（撤销后立刻再刮可再次落库）
{
  const { storage } = await createHarness()
  storage.markRevealed('demo-002')
  storage.removeCard('demo-002')
  storage.markRevealed('demo-002')
  check('撤销后重新揭示同卡，storage 重新出现该记录', () => {
    assert.deepEqual(Object.keys(storage.readRevealed()), ['demo-002'])
  })
}

// ⑤ StrictMode 双挂载语义：揭示后只读不写（模拟 StrictMode 重挂载），
//    setItem 次数不随挂载次数增加；幂等重复 markRevealed 不产生多余写入差异
{
  const { storage, stub } = await createHarness()
  storage.markRevealed('demo-001')
  const writesAfterReveal = stub.setCount
  storage.readRevealed() // StrictMode 第二次挂载的水合读取
  storage.readRevealed()
  storage.markRevealed('demo-001') // latch 已置位的同卡重复到达：记录仍唯一
  check('水合只读不写、重复揭示同卡不双写且记录唯一', () => {
    assert.equal(
      stub.setCount,
      writesAfterReveal + 1,
      '两次水合读取 0 次写入；重复 mark 仅整体重写一次、记录不重复',
    )
    assert.deepEqual(Object.keys(storage.readRevealed()), ['demo-001'])
  })
}

// ⑥ 自定义 namespace 隔离：注入同一 namespace 实例的撤销只命中带后缀的 key，
//    默认 key 不受影响（复现"Grid 传 storageNamespace 时 reset/undo 清错 key"隐患已消除）
{
  const { storage: nsStorage, stub } = await createHarness('promo-x')
  nsStorage.markRevealed('demo-001')
  nsStorage.removeCard('demo-001')
  const { storage: defaultStorage } = await createHarness(undefined)
  defaultStorage.markRevealed('demo-009')
  check('namespace 实例的撤销只作用于带后缀 key，默认 key 独立', () => {
    assert.deepEqual(Object.keys(nsStorage.readRevealed()), [])
    assert.deepEqual(readJson(stub, 'scratch-card:revealed:v1:promo-x'), {})
    assert.deepEqual(Object.keys(defaultStorage.readRevealed()), ['demo-009'])
  })
}

// ⑦ Grid revealedIds 语义：揭示/撤销镜像 storage，多卡交错后撤销顺序为"最近一张"
{
  const { storage } = await createHarness()
  const model = createGridStateModel()
  for (const id of ['demo-001', 'demo-002', 'demo-003']) {
    storage.markRevealed(id)
    modelReveal(model, id)
  }
  const undone1 = modelUndo(model)
  storage.removeCard(undone1)
  const undone2 = modelUndo(model)
  storage.removeCard(undone2)
  check('revealedIds 与 storage 同步回滚，撤销顺序为最近揭示优先', () => {
    assert.equal(undone1, 'demo-003')
    assert.equal(undone2, 'demo-002')
    assert.deepEqual([...model.revealedIds], ['demo-001'])
    assert.deepEqual([...model.order], ['demo-001'])
    assert.deepEqual(Object.keys(storage.readRevealed()), ['demo-001'])
  })
}

// ⑧ 撤销空栈为空操作：无卡可撤销时不调用 removeCard、Set 不被改写
{
  const { storage, stub } = await createHarness()
  const model = createGridStateModel()
  const undone = modelUndo(model)
  check('空栈撤销为 no-op：无 id、无 storage 写入、Set 仍为空', () => {
    assert.equal(undone, undefined)
    assert.equal(stub.setCount, 0)
    assert.deepEqual([...model.revealedIds], [])
    assert.equal(stub.store.has('scratch-card:revealed:v1'), false)
  })
}

console.log(`\n全部通过：${passed}/8 条断言`)
