/**
 * 刮刮卡持久化（方案 2.3 / 第 5 节）：单 localStorage key 聚合 JSON。
 * 同步 API；负责序列化、schema 版本号、读写的 try/catch 与数据校验。
 * 存储不可用（SecurityError）或写失败（QuotaExceededError）时降级为
 * 内存态，本次会话内保持有效，不阻断揭示流程（5.3 / 5.4）。
 */

/** 固定前缀 scratch-card: + 域 revealed + schema 版本 v1（方案 5.1），调用方不拼字符串 */
export const STORAGE_KEY_BASE = 'scratch-card:revealed:v1'

const CARD_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/

/**
 * @typedef {object} StoredCardRecord
 * @property {1} v schema 版本，当前固定 1
 * @property {number} ts 揭示时间戳（Date.now()），用于调试与未来排序；不参与逻辑
 */

/**
 * @typedef {object} ScratchStorage
 * @property {() => Record<string, StoredCardRecord>} readRevealed 整体读取 + 校验
 * @property {(cardId: string) => void} markRevealed 幂等
 * @property {(cardId: string) => void} removeCard reset 用
 * @property {() => void} clearAll 调试/演示复位
 */

/**
 * @param {string} [namespace] 同页多套刮刮卡时追加后缀，
 *   格式 scratch-card:revealed:v1:<namespace>；缺省即 scratch-card:revealed:v1
 * @returns {ScratchStorage}
 */
export function createScratchStorage(namespace) {
  const key = namespace ? `${STORAGE_KEY_BASE}:${namespace}` : STORAGE_KEY_BASE
  /** 内存态：进入降级模式后作为唯一真相源，本次会话内有效 */
  let memoryRecords = /** @type {Record<string, StoredCardRecord> | null} */ (null)

  /** @returns {string | null} */
  function safeGet() {
    try {
      return window.localStorage.getItem(key)
    } catch {
      // SecurityError（禁用 cookie/隐私模式）：进入内存降级模式（5.4 第 1 步）
      if (memoryRecords === null) memoryRecords = {}
      return null
    }
  }

  /** @param {string} raw */
  function safeSet(raw) {
    try {
      window.localStorage.setItem(key, raw)
    } catch {
      // QuotaExceededError / SecurityError：只降级，内存态已先行更新（5.3）
      if (memoryRecords === null) memoryRecords = {}
    }
  }

  function safeReset() {
    try {
      window.localStorage.removeItem(key)
      window.localStorage.setItem(key, '{}')
    } catch {
      if (memoryRecords === null) memoryRecords = {}
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

  /** @returns {Record<string, StoredCardRecord>} */
  function readRevealed() {
    if (memoryRecords !== null) return { ...memoryRecords }
    const raw = safeGet()
    if (memoryRecords !== null) return { ...memoryRecords }
    if (raw === null) return {} // 首次使用，正常路径（5.4 第 2 步）
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      safeReset() // 损坏 JSON：清除坏值并重置为合法 JSON（5.4 第 3 步）
      return {}
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      safeReset() // 非纯对象：同上（5.4 第 4 步）
      return {}
    }
    /** @type {Record<string, StoredCardRecord>} */
    const records = {}
    let dirty = false
    for (const [id, value] of Object.entries(/** @type {Record<string, unknown>} */ (parsed))) {
      if (CARD_ID_PATTERN.test(id) && isValidRecord(value)) {
        records[id] = { v: 1, ts: value.ts }
      } else {
        dirty = true // 任一字段非法只丢弃该条，其余保留（5.4 第 5 步）
      }
    }
    if (dirty) safeSet(JSON.stringify(records)) // 回写净化结果，失败静默
    return records
  }

  /**
   * 读全量 → 改内存对象 → 整体序列化写回（5.4 第 7 步）；
   * 内存态先行更新，序列化/写入失败不改变已生效的内存状态。
   * @param {(records: Record<string, StoredCardRecord>) => void} mutate
   */
  function modify(mutate) {
    const records = readRevealed()
    mutate(records)
    if (memoryRecords !== null) {
      memoryRecords = records
      return
    }
    try {
      safeSet(JSON.stringify(records))
    } catch {
      // JSON.stringify 失败（理论上不可达）：保持内存态不变
    }
    if (memoryRecords !== null) memoryRecords = records // 写失败降级：内存保留新状态
  }

  /** @param {string} cardId */
  function markRevealed(cardId) {
    if (!CARD_ID_PATTERN.test(cardId)) return
    modify((records) => {
      if (!records[cardId]) records[cardId] = { v: 1, ts: Date.now() } // 幂等
    })
  }

  /** @param {string} cardId */
  function removeCard(cardId) {
    modify((records) => {
      delete records[cardId]
    })
  }

  function clearAll() {
    modify((records) => {
      for (const id of Object.keys(records)) delete records[id]
    })
  }

  return { readRevealed, markRevealed, removeCard, clearAll }
}
