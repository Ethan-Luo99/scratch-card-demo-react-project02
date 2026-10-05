/**
 * localStorage 持久化（方案 2.3 / 第 5 节）。同步 API，单 key 聚合 JSON + schema 版本号。
 * key 规则：固定前缀 scratch-card: + 域 revealed + schema 版本 v1，由本模块内部拼接；
 * namespace 仅用于未来多套刮刮卡追加后缀 scratch-card:revealed:v1:<namespace>，
 * 默认命名空间 "v1" 即基础 key scratch-card:revealed:v1 本身，不再追加。
 */

import { SCRATCH_CARDS } from './scratchCards.data.js'

const STORAGE_KEY_BASE = 'scratch-card:revealed:v1'
const DEFAULT_NAMESPACE = 'v1'
const CARD_ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const SCHEMA_VERSION = 1

/**
 * @typedef {Object} StoredCardRecord
 * @property {1} v - schema 版本，当前固定 1
 * @property {number} ts - 揭示时间戳（Date.now()），用于调试与未来排序；不参与逻辑
 */

/**
 * @typedef {Object} ScratchStorage
 * @property {() => Record<string, StoredCardRecord>} readRevealed - 整体读取 + 校验
 * @property {(cardId: string) => void} markRevealed - 幂等
 * @property {(cardId: string) => void} removeCard - reset 用
 * @property {() => void} clearAll - 调试/演示复位
 */

/**
 * @param {string} [namespace] 自定义存储命名空间后缀；默认 "v1"，与 storage schema 版本独立
 * @returns {ScratchStorage}
 */
export function createScratchStorage(namespace) {
  const key = typeof namespace === 'string' && namespace !== '' && namespace !== DEFAULT_NAMESPACE
    ? `${STORAGE_KEY_BASE}:${namespace}`
    : STORAGE_KEY_BASE
  const validIds = new Set(SCRATCH_CARDS.map((card) => card.cardId))

  // 内存降级模式：禁用存储 / 写失败（QuotaExceededError）时，本次会话内只走内存（方案 5.4）
  let memoryOnly = false
  let memory = {}

  function writeRaw(record) {
    if (memoryOnly) {
      memory = { ...record }
      return
    }
    try {
      localStorage.setItem(key, JSON.stringify(record))
    } catch {
      // QuotaExceededError / SecurityError：降级为本次会话内有效，不阻断揭示
      memoryOnly = true
      memory = { ...record }
    }
  }

  function removeKey() {
    if (memoryOnly) {
      memory = {}
      return
    }
    try {
      localStorage.removeItem(key)
    } catch {
      // SecurityError：降级为内存模式
      memoryOnly = true
      memory = {}
    }
  }

  /** @returns {Record<string, StoredCardRecord>} 方案 5.4 的严格读取流程 */
  function readRaw() {
    if (memoryOnly) return { ...memory }
    let raw
    try {
      raw = localStorage.getItem(key)
    } catch {
      // SecurityError（禁用 cookie/隐私模式）：内存降级，后续读写只走内存
      memoryOnly = true
      memory = {}
      return {}
    }
    if (raw === null) return {}
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      removeKey()
      return {}
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      removeKey()
      return {}
    }
    /** @type {Record<string, StoredCardRecord>} */
    const clean = {}
    let dirty = false
    for (const [id, record] of Object.entries(parsed)) {
      const idOk = CARD_ID_RE.test(id) && validIds.has(id)
      const recOk = record !== null
        && typeof record === 'object'
        && record.v === SCHEMA_VERSION
        && typeof record.ts === 'number'
        && Number.isFinite(record.ts)
      if (idOk && recOk) {
        clean[id] = { v: SCHEMA_VERSION, ts: record.ts }
      } else {
        dirty = true
      }
    }
    if (dirty) writeRaw(clean)
    return clean
  }

  return {
    readRevealed() {
      return readRaw()
    },
    markRevealed(cardId) {
      if (!CARD_ID_RE.test(cardId)) return
      const all = readRaw()
      all[cardId] = { v: SCHEMA_VERSION, ts: Date.now() }
      writeRaw(all)
    },
    removeCard(cardId) {
      const all = readRaw()
      if (!(cardId in all)) return
      delete all[cardId]
      writeRaw(all)
    },
    clearAll() {
      removeKey()
    },
  }
}
