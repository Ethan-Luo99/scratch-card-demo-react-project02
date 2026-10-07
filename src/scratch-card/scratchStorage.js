/**
 * 刮刮卡持久化（方案 2.3 / 第 5 节）：单 localStorage key 聚合 JSON。
 * 同步 API；负责序列化、schema 版本号、读写的 try/catch 与数据校验。
 * 存储不可用（SecurityError）或写失败（QuotaExceededError）时降级为
 * 内存态，本次会话内保持有效，不阻断揭示流程（5.3 / 5.4）。
 *
 * Schema v2：同一 key 的 payload 升级为
 *   { schema: 2, records: { cardId: { v: 1, ts } }, order: [cardId, ...] }
 * 其中 order 为揭示顺序（底→顶，栈顶=最近揭示），随 markRevealed /
 * removeCard / clearAll 与 records 同一次写回，保证两状态源不发散。
 * 读到旧 v1 扁平记录（{ cardId: { v: 1, ts } }）时按 ts 升序迁移为 v2
 * 并立即首次写回；v1 记录逐条校验保留，不丢失、不报错。
 */

/** 固定前缀 scratch-card: + 域 revealed + schema 版本 v1（方案 5.1），调用方不拼字符串 */
export const STORAGE_KEY_BASE = 'scratch-card:revealed:v1'

const CARD_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/
const SCHEMA_V2 = 2

/**
 * @typedef {object} StoredCardRecord
 * @property {1} v 记录 schema 版本，当前固定 1
 * @property {number} ts 揭示时间戳（Date.now()），v1 迁移时用于推导揭示顺序
 */

/**
 * @typedef {object} ScratchState 内部状态：记录表 + 揭示顺序（底→顶）
 * @property {Record<string, StoredCardRecord>} records
 * @property {string[]} order
 */

/**
 * @typedef {object} ScratchStorage
 * @property {() => Record<string, StoredCardRecord>} readRevealed 整体读取 + 校验
 * @property {() => string[]} readOrder 读取持久化揭示顺序（底→顶）；v1 数据读取时已迁移
 * @property {(cardId: string) => void} markRevealed 幂等；同时把 cardId 追加到顺序栈顶
 * @property {(cardId: string) => void} removeCard reset/撤销用：记录与顺序同步移除
 * @property {(cardId: string) => void} removeFromOrder 只从顺序中清除（孤儿 id 防御），不动记录
 * @property {() => void} clearAll 调试/演示复位：记录与顺序同清
 */

/**
 * @param {string} [namespace] 同页多套刮刮卡时追加后缀，
 *   格式 scratch-card:revealed:v1:<namespace>；缺省即 scratch-card:revealed:v1
 * @returns {ScratchStorage}
 */
export function createScratchStorage(namespace) {
  const key = namespace ? `${STORAGE_KEY_BASE}:${namespace}` : STORAGE_KEY_BASE
  /** 内存态：进入降级模式后作为唯一真相源，本次会话内有效 */
  let memoryState = /** @type {ScratchState | null} */ (null)

  /** @returns {ScratchState} */
  function emptyState() {
    return { records: {}, order: [] }
  }

  /**
   * @param {ScratchState} state
   * @returns {ScratchState}
   */
  function cloneState(state) {
    return { records: { ...state.records }, order: [...state.order] }
  }

  /**
   * @param {ScratchState} state
   * @returns {string}
   */
  function serialize(state) {
    return JSON.stringify({ schema: SCHEMA_V2, records: state.records, order: state.order })
  }

  /** @returns {string | null} */
  function safeGet() {
    try {
      return window.localStorage.getItem(key)
    } catch {
      // SecurityError（禁用 cookie/隐私模式）：进入内存降级模式（5.4 第 1 步）
      if (memoryState === null) memoryState = emptyState()
      return null
    }
  }

  /** @param {string} raw */
  function safeSet(raw) {
    try {
      window.localStorage.setItem(key, raw)
    } catch {
      // QuotaExceededError / SecurityError：只降级，内存态已先行更新（5.3）
      if (memoryState === null) memoryState = emptyState()
    }
  }

  function safeReset() {
    try {
      window.localStorage.removeItem(key)
      window.localStorage.setItem(key, serialize(emptyState()))
    } catch {
      if (memoryState === null) memoryState = emptyState()
    }
  }

  /**
   * 单条记录校验（5.4 第 5 步）：键名白名单、值为对象、v===1、ts 为有限 number
   * @param {unknown} value
   * @returns {value is StoredCardRecord}
   */
  function isValidRecord(value) {
    if (typeof value !== 'object' || value === null) return false
    const record = /** @type {Record<string, unknown>} */ (value)
    return record.v === 1 && typeof record.ts === 'number' && Number.isFinite(record.ts)
  }

  /**
   * 校验 v1 扁平记录表，逐条保留合法记录（5.4 第 5 步）
   * @param {Record<string, unknown>} rawRecords
   * @returns {{ records: Record<string, StoredCardRecord>, dirty: boolean }}
   */
  function sanitizeRecords(rawRecords) {
    /** @type {Record<string, StoredCardRecord>} */
    const records = {}
    let dirty = false
    for (const [id, value] of Object.entries(rawRecords)) {
      if (CARD_ID_PATTERN.test(id) && isValidRecord(value)) {
        records[id] = { v: 1, ts: value.ts }
      } else {
        dirty = true // 任一字段非法只丢弃该条，其余保留（5.4 第 5 步）
      }
    }
    return { records, dirty }
  }

  /**
   * v2 payload 校验与自愈：非法记录丢弃；顺序只保留"合法 id、记录存在、
   * 不重复"的项。order 字段整体缺失/非法时按 ts 升序重建；order 为合法
   * 数组时信任其内容——记录存在但不在顺序中是合法状态（孤儿 id 被
   * removeFromOrder 清除后即如此），不得补回。
   * @param {Record<string, unknown>} parsed
   * @returns {{ state: ScratchState, dirty: boolean } | null} records 字段整体非法时返回 null
   */
  function sanitizeV2(parsed) {
    const rawRecords = parsed.records
    if (typeof rawRecords !== 'object' || rawRecords === null || Array.isArray(rawRecords)) {
      return null
    }
    const { records, dirty: recordsDirty } = sanitizeRecords(
      /** @type {Record<string, unknown>} */ (rawRecords),
    )
    let dirty = recordsDirty
    /** @type {string[]} */
    const order = []
    const seen = new Set()
    if (Array.isArray(parsed.order)) {
      for (const entry of parsed.order) {
        if (
          typeof entry === 'string' &&
          CARD_ID_PATTERN.test(entry) &&
          records[entry] &&
          !seen.has(entry)
        ) {
          seen.add(entry)
          order.push(entry)
        } else {
          dirty = true
        }
      }
    } else {
      // order 字段整体缺失/非法：由记录按 ts 升序重建
      dirty = true
      order.push(...Object.keys(records).sort((a, b) => records[a].ts - records[b].ts))
    }
    return { state: { records, order }, dirty }
  }

  /**
   * v1 → v2 迁移：合法记录全量保留，揭示顺序按 ts 升序推导（ts 大者在栈顶，
   * 撤销时最近揭示优先）
   * @param {Record<string, unknown>} parsed
   * @returns {ScratchState}
   */
  function migrateV1(parsed) {
    const { records } = sanitizeRecords(parsed)
    const order = Object.keys(records).sort((a, b) => records[a].ts - records[b].ts)
    return { records, order }
  }

  /**
   * 整体写回；内存态先行更新，序列化/写入失败不改变已生效的内存状态（5.3）
   * @param {ScratchState} state
   */
  function writeState(state) {
    if (memoryState !== null) {
      memoryState = cloneState(state)
      return
    }
    safeSet(serialize(state))
    if (memoryState !== null) memoryState = cloneState(state) // 写失败降级：内存保留新状态
  }

  /**
   * 读取 + 校验 + 迁移（5.4）：v2 净化回写、v1 迁移后首次写回，
   * 损坏数据重置为空 v2；任何路径不抛异常
   * @returns {ScratchState}
   */
  function readState() {
    if (memoryState !== null) return cloneState(memoryState)
    const raw = safeGet()
    if (memoryState !== null) return cloneState(memoryState)
    if (raw === null) return emptyState() // 首次使用，正常路径（5.4 第 2 步）
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      safeReset() // 损坏 JSON：清除坏值并重置为合法空 v2（5.4 第 3 步）
      return emptyState()
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      safeReset() // 非纯对象：同上（5.4 第 4 步）
      return emptyState()
    }
    const plain = /** @type {Record<string, unknown>} */ (parsed)
    if (plain.schema === SCHEMA_V2) {
      const result = sanitizeV2(plain)
      if (result === null) {
        safeReset() // v2 骨架损坏：重置为空 v2，不报错
        return emptyState()
      }
      if (result.dirty) writeState(result.state) // 回写净化/自愈结果，失败静默
      return result.state
    }
    // 旧 v1 扁平记录：按 ts 升序迁移为 v2 并立即首次写回，原记录不丢失
    const migrated = migrateV1(plain)
    writeState(migrated)
    return migrated
  }

  /**
   * 读全量 → 改内存对象 → 整体序列化写回（5.4 第 7 步）：单次调用单次写入
   * @param {(state: ScratchState) => void} mutate
   */
  function modify(mutate) {
    const state = readState()
    mutate(state)
    writeState(state)
  }

  /** @returns {Record<string, StoredCardRecord>} */
  function readRevealed() {
    return readState().records
  }

  /** @returns {string[]} 持久化揭示顺序快照（底→顶） */
  function readOrder() {
    return readState().order
  }

  /** @param {string} cardId */
  function markRevealed(cardId) {
    if (!CARD_ID_PATTERN.test(cardId)) return
    modify((state) => {
      if (!state.records[cardId]) state.records[cardId] = { v: 1, ts: Date.now() } // 幂等
      if (!state.order.includes(cardId)) state.order.push(cardId) // 顺序去重，栈顶=最近
    })
  }

  /** @param {string} cardId */
  function removeCard(cardId) {
    modify((state) => {
      delete state.records[cardId]
      state.order = state.order.filter((id) => id !== cardId)
    })
  }

  /** @param {string} cardId */
  function removeFromOrder(cardId) {
    modify((state) => {
      state.order = state.order.filter((id) => id !== cardId)
    })
  }

  function clearAll() {
    modify((state) => {
      state.records = {}
      state.order = []
    })
  }

  return { readRevealed, readOrder, markRevealed, removeCard, removeFromOrder, clearAll }
}
