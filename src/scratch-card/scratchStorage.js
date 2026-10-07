/**
 * 刮刮卡持久化（方案 2.3 / 第 5 节）：单 localStorage key 聚合 JSON。
 * 同步 API；负责序列化、schema 版本号、读写的 try/catch 与数据校验。
 * 存储不可用（SecurityError）或写失败（QuotaExceededError）时降级为
 * 内存态，本次会话内保持有效，不阻断揭示流程（5.3 / 5.4）。
 *
 * schema v2（撤销栈跨刷新存活）：
 *   { v: 2, records: { [cardId]: { v: 1, ts } }, order: string[] }
 * - records 与 v1 裸记录完全同构，v1 数据零丢失迁移；
 * - order 即揭示顺序栈（先揭示在底、最近揭示在顶），撤销自尾部弹出；
 * - 读到 v1 数据（顶层直接是 cardId → record 映射、无 order）时按 ts
 *   升序推导顺序迁移为 v2，并在首次读净化时写回；v1 数据不报错；
 * - 所有写路径均"内容不变不写盘"，StrictMode 双挂载/连续撤销不双写。
 */

/** 固定前缀 scratch-card: + 域 revealed + schema 版本 v1（方案 5.1），调用方不拼字符串 */
export const STORAGE_KEY_BASE = 'scratch-card:revealed:v1'

/** 当前 schema 版本：v2 = records + 揭示顺序 order；v1 裸记录读取时自动迁移 */
export const SCHEMA_VERSION = 2

const CARD_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/

/** 空状态的规范化序列化形态（损坏重置 / 内容比对共用） */
const EMPTY_STATE_RAW = JSON.stringify({ v: SCHEMA_VERSION, records: {}, order: [] })

/**
 * @typedef {object} StoredCardRecord
 * @property {1} v schema 版本，当前固定 1
 * @property {number} ts 揭示时间戳（Date.now()），用于调试与排序
 */

/**
 * @typedef {object} StoredRevealState
 * @property {2} v 存储 envelope schema 版本，当前固定 2
 * @property {Record<string, StoredCardRecord>} records 揭示记录（与 v1 单条同构）
 * @property {string[]} order 揭示顺序（栈底→栈顶），撤销从末尾弹出
 */

/**
 * @typedef {object} ScratchStorage
 * @property {() => Record<string, StoredCardRecord>} readRevealed 整体读取 + 校验
 * @property {() => StoredRevealState} readRevealState 读取 records + 持久化顺序（副本）
 * @property {(cardId: string) => void} markRevealed 幂等：补记录并入顺序栈顶
 * @property {(cardId: string) => void} removeCard reset/兜底用：删记录并摘除顺序
 * @property {(validCardIds: ReadonlySet<string>) => void} pruneReveal
 *   水合净化：剔除当前 cards 已不存在的孤儿记录与顺序项
 * @property {(validCardIds?: ReadonlySet<string> | null) => string | null} popReveal
 *   撤销原语：自栈顶跳过孤儿（同步清除其记录与顺序项），弹出首个有效 id 并一次写回；
 *   空栈返回 null 且零写入
 * @property {() => void} clearAll 调试/演示复位：记录与顺序同清
 */

/** @returns {StoredRevealState} */
function createEmptyState() {
  return { v: SCHEMA_VERSION, records: {}, order: [] }
}

/**
 * 单条记录校验（5.4 第 5 步）：值为对象、v===1、ts 为有限 number
 * @param {unknown} value
 * @returns {value is StoredCardRecord}
 */
function isValidRecord(value) {
  if (typeof value !== 'object' || value === null) return false
  const record = /** @type {Record<string, unknown>} */ (value)
  return record.v === 1 && typeof record.ts === 'number' && Number.isFinite(record.ts)
}

/** @param {Record<string, StoredCardRecord>} records */
function orderByTsAsc(records) {
  return Object.entries(records)
    .sort((a, b) => a[1].ts - b[1].ts)
    .map(([cardId]) => cardId)
}

/**
 * 解析 v2 envelope：非法结构整体重置；局部脏数据只丢脏条目（dirty=true 触发回写）。
 * @param {Record<string, unknown>} envelope
 * @returns {{ state: StoredRevealState, dirty: boolean } | null}
 */
function parseV2Envelope(envelope) {
  const recordsNode = envelope.records
  if (typeof recordsNode !== 'object' || recordsNode === null || Array.isArray(recordsNode)) {
    return null
  }
  /** @type {Record<string, StoredCardRecord>} */
  const records = {}
  for (const [id, value] of Object.entries(/** @type {Record<string, unknown>} */ (recordsNode))) {
    if (CARD_ID_PATTERN.test(id) && isValidRecord(value)) {
      records[id] = { v: 1, ts: value.ts }
    }
  }
  let dirty = Object.keys(records).length !== Object.keys(recordsNode).length

  /** @type {string[]} */
  let order
  const seen = new Set()
  if (Array.isArray(envelope.order)) {
    order = []
    for (const id of envelope.order) {
      if (typeof id === 'string' && CARD_ID_PATTERN.test(id) && records[id] !== undefined) {
        if (!seen.has(id)) {
          seen.add(id)
          order.push(id)
        }
      } else {
        dirty = true // 顺序项非法/重复/无记录：丢弃该顺序项
      }
    }
  } else {
    order = []
    if (envelope.order !== undefined) dirty = true
  }
  // 有记录但顺序缺失（旧版漏写/手改）：按 ts 升序补齐，保证每张卡都可被撤销
  for (const id of orderByTsAsc(records)) {
    if (!seen.has(id)) {
      seen.add(id)
      order.push(id)
      dirty = true
    }
  }
  return { state: { v: SCHEMA_VERSION, records, order }, dirty }
}

/**
 * v1 裸记录迁移：逐条沿用 v1 校验，顺序按 ts 升序推导（最近揭示在栈顶）。
 * @param {Record<string, unknown>} node
 * @returns {StoredRevealState}
 */
function migrateV1Records(node) {
  /** @type {Record<string, StoredCardRecord>} */
  const records = {}
  for (const [id, value] of Object.entries(node)) {
    if (CARD_ID_PATTERN.test(id) && isValidRecord(value)) {
      records[id] = { v: 1, ts: value.ts }
    }
  }
  return { v: SCHEMA_VERSION, records, order: orderByTsAsc(records) }
}

/**
 * @param {string} [namespace] 同页多套刮刮卡时追加后缀，
 *   格式 scratch-card:revealed:v1:<namespace>；缺省即 scratch-card:revealed:v1
 * @returns {ScratchStorage}
 */
export function createScratchStorage(namespace) {
  const key = namespace ? `${STORAGE_KEY_BASE}:${namespace}` : STORAGE_KEY_BASE
  /** 内存态：进入降级模式后作为唯一真相源，本次会话内有效 */
  let memoryState = /** @type {StoredRevealState | null} */ (null)

  /** @returns {string | null} */
  function safeGet() {
    try {
      return window.localStorage.getItem(key)
    } catch {
      // SecurityError（禁用 cookie/隐私模式）：进入内存降级模式（5.4 第 1 步）
      if (memoryState === null) memoryState = createEmptyState()
      return null
    }
  }

  /** @param {string} raw */
  function safeSet(raw) {
    try {
      window.localStorage.setItem(key, raw)
    } catch {
      // QuotaExceededError / SecurityError：只降级，内存态已先行更新（5.3）
      if (memoryState === null) memoryState = createEmptyState()
    }
  }

  /** 损坏数据重置：删后立即写回空 envelope，保持 key 恒为合法 JSON */
  function safeReset() {
    try {
      window.localStorage.removeItem(key)
      window.localStorage.setItem(key, EMPTY_STATE_RAW)
    } catch {
      if (memoryState === null) memoryState = createEmptyState()
    }
  }

  /**
   * 读盘 + 校验/迁移（5.4 严格流程）：
   * 损坏 JSON / 非纯对象 / v2 结构非法 → 重置为空；v1 裸记录 → 按 ts 升序
   * 迁移为 v2；局部脏数据只丢脏条目。只要结果与盘上原文不同（含 v1→v2 首次
   * 迁移与净化）即在此同步写回一次（“首次写回”），后续幂等读取零写入。
   * @returns {StoredRevealState}
   */
  function loadState() {
    if (memoryState !== null) return memoryState
    const raw = safeGet()
    if (memoryState !== null) return memoryState
    if (raw === null) return createEmptyState() // 首次使用，正常路径（5.4 第 2 步）

    /** @type {unknown} */
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      safeReset() // 损坏 JSON：清除坏值并重置为合法 JSON（5.4 第 3 步）
      return createEmptyState()
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      safeReset() // 非纯对象：同上（5.4 第 4 步）
      return createEmptyState()
    }

    const node = /** @type {Record<string, unknown>} */ (parsed)
    let state
    if (node.v === SCHEMA_VERSION) {
      const result = parseV2Envelope(node)
      if (result === null) {
        safeReset()
        return createEmptyState()
      }
      state = result.state
      if (result.dirty) safeSet(JSON.stringify(state))
      return state
    }
    // v1（无 v 字段、顶层直接是 cardId → {v:1,ts}）及未知 schema 一律按 v1 迁移；
    // v1 记录逐条保留，只升 envelope，零丢失、不报错
    state = migrateV1Records(node)
    safeSet(JSON.stringify(state))
    return state
  }

  /**
   * 提交唯一入口：基于最新状态改内存对象 → 与“改前的盘上序列化形态”比对，
   * 内容不变直接返回（空栈撤销 / 幂等 mark / StrictMode 双挂载净化均零写入）；
   * 变化才整体序列化写回一次。内存降级态只更新内存。
   * @param {(state: StoredRevealState) => void} mutate
   */
  function commit(mutate) {
    const previous = loadState()
    const before = memoryState === null ? JSON.stringify(previous) : null
    const next = { v: SCHEMA_VERSION, records: { ...previous.records }, order: [...previous.order] }
    mutate(next)
    if (memoryState !== null) {
      memoryState = next
      return
    }
    const raw = JSON.stringify(next)
    if (raw !== before) safeSet(raw)
    if (memoryState !== null) memoryState = next // 写失败降级：内存保留新状态
  }

  /** @returns {Record<string, StoredCardRecord>} 记录副本（既有签名不变） */
  function readRevealed() {
    return { ...loadState().records }
  }

  /** @returns {StoredRevealState} records + order 的副本，供水合建栈 */
  function readRevealState() {
    const state = loadState()
    return { v: SCHEMA_VERSION, records: { ...state.records }, order: [...state.order] }
  }

  /**
   * 揭示写入（5.4 第 7 步）：幂等补记录；同卡已在栈中则只刷新 ts，
   * 不重复入栈；新卡追加到顺序栈顶（撤销最近优先）。
   * @param {string} cardId
   */
  function markRevealed(cardId) {
    if (!CARD_ID_PATTERN.test(cardId)) return
    commit((state) => {
      const existed = state.records[cardId] !== undefined
      state.records[cardId] = { v: 1, ts: Date.now() }
      if (!existed) state.order.push(cardId)
    })
  }

  /**
   * reset/兜底：删除单卡记录并把该 id 从顺序中摘除（任何位置至多一项）。
   * @param {string} cardId
   */
  function removeCard(cardId) {
    commit((state) => {
      delete state.records[cardId]
      state.order = state.order.filter((id) => id !== cardId)
    })
  }

  /**
   * 水合净化（孤儿防御，5.4 第 6 步）：当前 cards 已不存在的 id 同时从
   * records 与 order 剔除，不误删他卡；本来就干净则零写入（StrictMode
   * 双挂载第二次调用不产生第二次写盘）。
   * @param {ReadonlySet<string>} validCardIds
   */
  function pruneReveal(validCardIds) {
    commit((state) => {
      state.order = state.order.filter((id) => validCardIds.has(id))
      for (const id of Object.keys(state.records)) {
        if (!validCardIds.has(id)) delete state.records[id]
      }
    })
  }

  /**
   * 撤销原语：自栈顶遍历——无效 id（不在当前 cards 或记录已失）作为孤儿，
   * 同步从 order 弹出并删除其记录（不空转、不误删他卡）；首个有效 id 弹出、
   * 删记录并整体写回恰好一次；栈空/全孤儿均返回 null。
   * @param {ReadonlySet<string> | null} [validCardIds] 省略时只以 records 存在为准
   * @returns {string | null}
   */
  function popReveal(validCardIds = null) {
    let popped = null
    commit((state) => {
      const reachable = (cardId) =>
        state.records[cardId] !== undefined &&
        (validCardIds === null || validCardIds.has(cardId))
      while (state.order.length > 0) {
        const cardId = /** @type {string} */ (state.order.pop())
        if (!reachable(cardId)) {
          delete state.records[cardId] // 孤儿：记录与顺序项同清
          continue
        }
        delete state.records[cardId]
        popped = cardId
        return
      }
    })
    return popped
  }

  /** 重置全部：揭示记录与持久化顺序同时清空 */
  function clearAll() {
    commit((state) => {
      state.records = {}
      state.order = []
    })
  }

  return { readRevealed, readRevealState, markRevealed, removeCard, pruneReveal, popReveal, clearAll }
}
