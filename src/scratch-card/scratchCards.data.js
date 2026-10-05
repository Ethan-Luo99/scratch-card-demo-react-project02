/**
 * 演示卡片常量数据（方案 2.3）：仅命名导出常量数组，
 * 文件内不允许出现组件/hook（证据 3 的 react-refresh 规则）。
 */

/**
 * @typedef {object} Prize
 * @property {string} title 奖品主文案，如"¥ 50 优惠券"
 * @property {string} subtitle 副文案，如"满 200 可用"；空串不渲染
 * @property {boolean} isWinning 是否中奖；仅决定 Grid 是否弹中奖提示
 */

/**
 * @typedef {object} ScratchCardDatum
 * @property {string} cardId 同一张卡全局唯一，仅允许 [a-zA-Z0-9_-]，长度 1~40
 * @property {Prize} prize
 */

/** @type {ReadonlyArray<ScratchCardDatum>} */
export const SCRATCH_CARDS = Object.freeze([
  Object.freeze({
    cardId: 'demo-001',
    prize: Object.freeze({ title: '¥ 50 优惠券', subtitle: '满 200 可用', isWinning: true }),
  }),
  Object.freeze({
    cardId: 'demo-002',
    prize: Object.freeze({ title: '谢谢参与', subtitle: '下次好运', isWinning: false }),
  }),
  Object.freeze({
    cardId: 'demo-003',
    prize: Object.freeze({ title: '¥ 10 话费', subtitle: '即时到账', isWinning: true }),
  }),
  Object.freeze({
    cardId: 'demo-004',
    prize: Object.freeze({ title: '¥ 200 免单券', subtitle: '全场通用', isWinning: true }),
  }),
  Object.freeze({
    cardId: 'demo-005',
    prize: Object.freeze({ title: '谢谢参与', subtitle: '下次好运', isWinning: false }),
  }),
  Object.freeze({
    cardId: 'demo-006',
    prize: Object.freeze({ title: '神秘小礼物', subtitle: '7 日内发出', isWinning: true }),
  }),
])
