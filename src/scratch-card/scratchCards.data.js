/**
 * 演示卡片常量数据（方案 2.3）。仅命名导出常量，文件内不允许出现组件/hook（证据 3）。
 */

/** @typedef {import('./ScratchCard.jsx').Prize} Prize */

/** @type {ReadonlyArray<{ cardId: string, prize: Prize }>} */
export const SCRATCH_CARDS = [
  { cardId: 'demo-001', prize: { title: '¥ 50 优惠券', subtitle: '满 200 可用', isWinning: true } },
  { cardId: 'demo-002', prize: { title: '谢谢参与', subtitle: '', isWinning: false } },
  { cardId: 'demo-003', prize: { title: '免单券', subtitle: '全场任意商品', isWinning: true } },
  { cardId: 'demo-004', prize: { title: '再接再厉', subtitle: '下次好运', isWinning: false } },
  { cardId: 'demo-005', prize: { title: '1000 积分', subtitle: '自动到账', isWinning: true } },
  { cardId: 'demo-006', prize: { title: '谢谢参与', subtitle: '感谢捧场', isWinning: false } },
]
