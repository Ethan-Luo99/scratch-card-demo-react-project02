# 前端刮刮卡组件设计方案

> 适用仓库：本文件所在仓库根目录（下文称"仓库根"，即包含 `package.json` 与 `src/` 的目录）。
> 目标：为"多卡、可刮开、刮到一半自动全开并提示中奖、刷新记住已刮开、手机/桌面一致、不掉帧、无断线与越界破口"的刮刮卡演示提供**无技术决策空白**的实现依据。
> 约束重申：不引入任何第三方库（仅使用 React 19 与浏览器原生 API）；本轮仅交付本文档，不改任何代码。

## 0. 仓库事实基线（证据引用）

本节所有结论均直接来自仓库现有文件，后续章节以 `【证据 N】` 回引。

| 编号 | 证据（文件:行号 + 片段） | 推出的结论 |
| --- | --- | --- |
| 证据 1 | `src/main.jsx:6` `createRoot(document.getElementById('root')).render(` 与 `src/main.jsx:7-9` 的 `<StrictMode>` 包裹 `<App />` | 开发环境下 effect 执行"挂载→清理→再挂载"两遍；canvas 初始化必须幂等、清理函数必须摘除全部监听器并释放资源（R1） |
| 证据 2 | `package.json:13-14` 为 `"react": "^19.2.8"`、`"react-dom": "^19.2.8"`；`package.json:16-25` 的 devDependencies 不含 `typescript`、`typescript-eslint` | 只能交付 `.jsx/.js`；TS 风格签名是契约文档，以 JSDoc 落地，禁止新增 TS 依赖 |
| 证据 3 | `eslint.config.js:13-14` 启用 `reactHooks.configs.flat.recommended` 与 `reactRefresh.configs.vite`；`eslint.config.js:10` 匹配 `**/*.{js,jsx}` | 必须满足 hooks 依赖规则；组件文件只能默认导出组件，hook/常量必须拆到独立文件，否则 `npm run lint` 报 react-refresh 错误 |
| 证据 4 | `package.json:5` `"type": "module"`；`package.json:7` `"dev": "vite"`、`:8` `"build": "vite build"`、`:9` `"lint": "eslint ."` | 代码示例一律 ESM；验收命令固定为 `npm run lint` / `npm run build` / `npm run preview` |
| 证据 5 | `index.html:6` `<meta name="viewport" content="width=device-width, initial-scale=1.0" />` | 手机视口基线已具备，触屏适配只需 CSS + Pointer Events，不改 viewport |
| 证据 6 | `src/index.css:57-60` `#root { width: 1126px; max-width: 100%; margin: 0 auto; }`；`src/App.css:67-70`、`src/index.css:28-30` 均以 `@media (max-width: 1024px)` 区分手机 | 卡片区桌面宽约 1126px、手机全宽；多卡必须用响应式 grid；canvas 必须支持运行时 resize |
| 证据 7 | `src/index.css:33` `@media (prefers-color-scheme: dark)`；`src/App.css:11` 使用 `&:hover {` 嵌套 | 卡片配色必须挂 CSS 变量以自动适配暗色；新样式可直接用原生嵌套，无需 PostCSS |
| 证据 8 | `README.md:12` `The React Compiler is not enabled on this template ...` | 无编译期 memo；引用稳定性必须显式 `useRef/useCallback` 实现 |
| 证据 9 | `vite.config.js:5-7` 仅 `plugins: [react()]`，无别名配置 | import 一律相对路径，静态资源参照 `src/App.jsx:38` 的 `/icons.svg#...` public 绝对路径写法 |
| 证据 10 | `src/App.jsx:7` `function App()`、`src/App.jsx:8` `const [count, setCount] = useState(0)`、`src/App.jsx:122` `export default App` | 以函数组件+默认导出接入；现有演示内容由实现阶段替换，无历史兼容负担 |
| 证据 11 | `.gitignore:10-12` 忽略 `node_modules`、`dist`、`dist-ssr` | `docs/` 会进版本库；构建产物不会，验收以本地构建为准 |

## 1. 文件与模块划分

实现阶段新增/修改的全部文件（路径相对仓库根）：

```
src/
├── main.jsx                    # 不修改（证据 1 的 StrictMode 已就位）
├── App.jsx                     # 修改：删除脚手架内容，挂载 <ScratchCardGrid />
├── App.css                     # 修改：删除脚手架样式（保留 #root 之外可重写）
└── scratch-card/
    ├── ScratchCardGrid.jsx     # 新增：多卡容器 + 中奖 toast 编排（默认导出组件）
    ├── ScratchCard.jsx         # 新增：单卡视图组件（默认导出组件）
    ├── scratchCards.css        # 新增：布局、卡片、涂层、toast 全部样式
    ├── useScratchCanvas.js     # 新增：核心 hook（canvas 生命周期/交互/检测/持久化联动）
    ├── scratchCanvasEngine.js  # 新增：纯函数（绘制、擦除、缩放、采样、坐标换算）
    ├── scratchStorage.js       # 新增：localStorage 读写、schema 校验、损坏兜底
    └── scratchCards.data.js    # 新增：演示卡片常量数据（id/奖品/是否中奖）
docs/
└── scratch-card-design.md      # 本文件
```

**职责边界（不得越界）**

- `useScratchCanvas.js` 是**唯一**直接触碰 `<canvas>`、`PointerEvent`、`ResizeObserver`、`devicePixelRatio`、`requestAnimationFrame`、定时器与离屏 canvas 的模块；对外只暴露第 2 节定义的句柄与回调。
- `scratchCanvasEngine.js` 是无 React 依赖的纯函数集合：画笔常量、CSS↔设备像素换算、涂层填充、对掩码的 `destination-out` 线段/圆点打洞、可见层用 `destination-in` 贴掩码合成、离屏掩码缩放、等距 alpha 采样。可脱离 React 单测。
- `ScratchCard.jsx` 只输出结构（奖品层、涂层 canvas、a11y 节点、状态文案），把 `ref` 与句柄全部交给 hook，不写绘制与统计逻辑。
- `ScratchCardGrid.jsx` 渲染卡片数组；React state 只保存**离散结果**（已揭示 id 集合、toast 队列）；高频进度不进 state。
- `scratchStorage.js` 为同步 API（localStorage 本身同步），负责序列化、schema 版本号、读写的 try/catch 与数据校验。
- `scratchCards.data.js` 仅导出常量数组，与组件文件物理分离。

**拆分理由（由证据直接推出）**

1. 证据 3 的 react-refresh 规则要求组件文件仅导出组件，因此 `useScratchCanvas` 与数据常量不能与 `ScratchCard.jsx` 同文件。
2. 证据 2 无 TS 工具链，全部文件为 `.jsx/.js`；第 2 节签名用 JSDoc（`@typedef/@param/@returns`）等价落地，`npm run lint`（证据 4）无需新增任何依赖。
3. 证据 8 表明没有 React Compiler，故句柄对象在 hook 内用 `useRef` 保存、对外用 `useCallback` 固定，避免子卡无谓重渲染。

## 2. 公共 API 设计

> 以下签名为 TypeScript 风格契约；仓库无 TS（证据 2），实现时在同名 `.js` 文件中用 JSDoc 逐字表达这些类型，不新增任何依赖与配置。

### 2.1 `useScratchCanvas` 完整签名

文件：`src/scratch-card/useScratchCanvas.js`

```ts
// —— 固定数值常量（scratchCanvasEngine.js 导出，禁止调用方覆盖）——
interface ScratchConstants {
  readonly REVEAL_THRESHOLD: number;   // 0.5，自动全开的刮开比例阈值
  readonly ALPHA_CLEARED: number;     // 16，alpha < 16 计为"已擦除"
  readonly BRUSH_RADIUS_CSS: number;  // 20，画笔半径（CSS px），直径 40px
  readonly SAMPLE_GRID: 48;           // 采样器固定 48 × 48 = 2304 个采样点
  readonly SAMPLE_MIN_MS: number;     // 200，两次面积检测最小间隔
  readonly MAX_DPR: 2;                // devicePixelRatio 上限
  readonly REVEAL_FADE_MS: 320;       // 自动全开的淡出时长
}

interface UseScratchCanvasOptions {
  /** 卡片稳定唯一 id，用于持久化 key；仅允许 [a-zA-Z0-9_-]，长度 1~40 */
  cardId: string;
  /** 初始是否已揭示；为 true 时首帧即渲染全透涂层（用于刷新后水合） */
  initiallyRevealed: boolean;
  /** 涂层底色；必须由组件从 CSS 变量读取后以字符串传入，引擎不读样式表 */
  coatingColor: string;
  /** 涂层上的引导文案，例如"刮开查看奖品"；空串表示不绘制文字 */
  coatingText: string;
  /** 刮开比例每发生整数百分点变化时触发（节流后，≤100 次/张生命周期） */
  onProgress?: (ratio: number) => void;
  /** 比例首次达到 REVEAL_THRESHOLD 时触发一次（latch，只触发一次） */
  onReveal?: () => void;
  /** 指针首次按下时触发一次（卡片内），用于埋点/触感，不驱动渲染 */
  onScratchStart?: () => void;
}

interface ScratchCanvasHandle {
  /** 挂到涂层 <canvas> 元素的 ref 回调（React 19 ref callback 形式） */
  canvasRef: (canvas: HTMLCanvasElement | null) => void;
  /** 挂到卡片根容器（负责边界与 ResizeObserver） */
  containerRef: (el: HTMLDivElement | null) => void;
  /** 当前已擦除比例 [0,1]；读 ref 快照，不触发渲染 */
  getRatio: () => number;
  /** 是否已揭示（含自动全开与水合全开） */
  isRevealed: () => boolean;
  /** 立即全开（带动画）；幂等，重复调用无副作用。供键盘按钮调用 */
  reveal: () => void;
  /** 重置为全新未刮状态并同步清除持久化记录；幂等 */
  reset: () => void;
}

export function useScratchCanvas(options: UseScratchCanvasOptions): ScratchCanvasHandle;
```

**每个 API 为什么这样设计**

1. `canvasRef` 与 `containerRef` 分开：DPR 与缓冲区尺寸取决于 canvas 自身，而 `ResizeObserver` 必须观察**容器**（canvas 由容器决定大小，观察自身会形成尺寸反馈环）。React 19 的 ref callback 可在卸载时以 `null` 调用，天然完成证据 1 要求的清理配对。
2. 句柄全部是**命令式函数**而非 state：高频指针路径读取 `getRatio()` 不经过 React 渲染管线（证据 8 无自动 memo，更要避免 state 风暴，详见 R2）。
3. `onProgress/onReveal/onScratchStart` 是回调而非 props 渲染prop：消费方（Grid）只在离散事件点更新一次 state；hook 内部用 `optionsRef`（`useRef` 持有最新回调）读取，保证这些 props 变化时**不重建** canvas effect（满足证据 3 的 exhaustive-deps：effect 依赖数组只含真正需要重建的输入）。
4. `initiallyRevealed` 与运行期揭示分离：水合在首次绘制涂层前决定"画不画涂层"，避免刷新后先闪完整涂层再变透明（R11）。
5. `cardId` 作为必填且限定字符集：持久化 key 由它拼接（第 5 节），字符白名单消除注入/越权读写其他 key 的面。
6. `coatingColor` 显式入参而非引擎内部 `getComputedStyle`：引擎保持纯函数；颜色由组件在 effect 重建点读取一次 CSS 变量（暗色切换若后续需要，可经该参数驱动 effect 重绘）。
7. `reveal/reset` 暴露为方法：满足无障碍——键盘用户通过卡片上的可见按钮触发同等结果（第 6 节 A11y 用例）。

### 2.2 组件 props

文件：`src/scratch-card/ScratchCard.jsx`（默认导出）

```ts
interface Prize {
  /** 奖品主文案，如"¥ 50 优惠券" */
  title: string;
  /** 副文案，如"满 200 可用"；空串不渲染 */
  subtitle: string;
  /** 是否中奖；仅决定 Grid 是否弹中奖提示，不改变刮擦行为 */
  isWinning: boolean;
}

interface ScratchCardProps {
  /** 同 useScratchCanvas.cardId，同一张卡全局唯一 */
  cardId: string;
  prize: Prize;
  /** 由 Grid 持久化层读入的初始状态 */
  initiallyRevealed: boolean;
  /** 自动全开时由本卡回调给 Grid（参数为 cardId） */
  onReveal: (cardId: string, prize: Prize) => void;
}
```

文件：`src/scratch-card/ScratchCardGrid.jsx`（默认导出）

```ts
interface ScratchCardGridProps {
  /** 默认取 scratchCards.data.js 的导出；允许传入以便后续接接口，当前演示不传 */
  cards?: ReadonlyArray<{ cardId: string; prize: Prize }>;
  /** 自定义存储命名空间后缀；默认 "v1"，与 storage schema 版本独立 */
  storageNamespace?: string;
}
```

**props 设计理由**

- 奖品数据与"是否已刮"分离：奖品是静态演示数据（`scratchCards.data.js`），已刮状态来自 `scratchStorage.js`，两条数据流在 Grid 汇合，单卡组件保持无状态、可任意顺序渲染多张。
- `onReveal(cardId, prize)` 把 `prize.isWinning` 的判定上交给 Grid：toast 文案（"恭喜中奖：…"与"谢谢参与"）只在一处编排，多卡互不串台。
- Grid **不**给单卡传 ratio：进度纯局部；Grid 的 React state 只有 `revealedIds: Set<string>` 与 toast 队列，把多卡场景的重渲染范围降到最小（R2）。

### 2.3 存储模块与数据模块 API

文件：`src/scratch-card/scratchStorage.js`

```ts
interface StoredCardRecord {
  /** schema 版本，当前固定 1 */
  v: 1;
  /** 揭示时间戳（Date.now()），用于调试与未来排序；不参与逻辑 */
  ts: number;
}
interface ScratchStorage {
  readRevealed(): Record<string, StoredCardRecord>; // 整体读取 + 校验
  markRevealed(cardId: string): void;               // 幂等
  removeCard(cardId: string): void;                 // reset 用
  clearAll(): void;                                 // 调试/演示复位
}
export function createScratchStorage(namespace?: string): ScratchStorage;
```

文件：`src/scratch-card/scratchCards.data.js`

```ts
// 仅命名导出常量；文件内不允许出现组件/hook（证据 3）
export const SCRATCH_CARDS: ReadonlyArray<{ cardId: string; prize: Prize }>;
```

## 3. 核心渲染与坐标管线

### 3.1 分层结构（DOM）

```
<div class="scratch-card" data-state="sealed|revealed">      ← containerRef，position:relative
  <div  class="scratch-card__prize" aria-hidden="…">奖品文案</div>  ← 底层，普通 DOM
  <canvas class="scratch-card__coating" />                   ← canvasRef，绝对定位铺满
  <button class="scratch-card__reveal-btn" hidden?>刮开</button>  ← 键盘可达替代操作
</div>
```

- 奖品文字用 DOM 而不是画进 canvas：保证清晰度（无需随 DPR 光栅化文字）、可被读屏朗读、样式自动跟随暗色变量（证据 7）。
- canvas 只有**涂层一张**；"擦除"利用 2D 上下文的合成模式，不需要两张 canvas 叠加。
- 涂层内容用一张**离屏保留掩码 canvas**承载 alpha：掩码**不透明=涂层保留、透明=已刮穿**。可见 canvas 由"先填涂层底色/文字、再以 `destination-in` 贴该掩码"合成（保留处留下涂层、透明处被裁掉露出底层 DOM）。用户笔画只对掩码做 `destination-out` 打洞。这样 resize 时只需对掩码做一次缩放重采样（见 3.6 与 R6）。掩码自身是纯 alpha 蒙版，填充颜色无关（实现填黑）。

### 3.2 三种尺寸与 DPR 换算公式

记：

- CSS 像素尺寸：容器由布局测得 `rectW_css × rectH_css`（`getBoundingClientRect()`）。
- 设备像素比：`dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)`，`MAX_DPR = 2`（高 DPR 屏钳制理由见 R12/第 7 节）。
- canvas 缓冲区（后备存储）尺寸：`bufW = Math.round(rectW_css * dpr)`，`bufH = Math.round(rectH_css * dpr)`。
- canvas 元素 CSS 尺寸：`style.width = rectW_css + 'px'`，`style.height = rectH_css + 'px'`。
- 上下文变换：`ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`，此后所有绘制坐标一律用 **CSS 像素**。

事件坐标换算（PointerEvent，CSS 像素）：

```
x_css = event.clientX - rect.left
y_css = event.clientY - rect.top
rect   = canvas.getBoundingClientRect()   // 每次事件现取，不缓存（滚动/缩放会变）
```

CSS 像素 → 缓冲区设备像素（离屏掩码绘制时使用，掩码自身上下文不做 setTransform）：

```
x_dev = x_css * dpr
y_dev = y_css * dpr
brushRadius_dev = BRUSH_RADIUS_CSS * dpr
```

反向（采样时把缓冲区 alpha 映射回 CSS 概念不需要——采样直接在固定 48×48 采样器上做，见 3.5）。

**不变量**：① `canvas.width === bufW`、`canvas.height === bufH`；② 缓冲区宽高比与 CSS 宽高比必须一致（卡片用固定 `aspect-ratio: 16 / 9`，保证非等比缩放不发生，R6 的前提）；③ 任何绘制前必须已 `setTransform(dpr,…)`，禁止在可见 ctx 上用设备像素坐标。

### 3.3 初始化时序（effect 内，幂等）

`useScratchCanvas` 的主 effect 依赖 `[cardId, coatingColor, coatingText, initiallyRevealed]`（回调用 ref 读，不进依赖，满足证据 3）。每次执行严格按序：

1. 校验 `canvasRef`、`containerRef` 已挂载；取容器 `rect`，若宽或高为 0 则跳过本轮（`ResizeObserver` 触发后再来）。
2. `dpr = min(devicePixelRatio, 2)`；设置可见 canvas 的 `width/height` 与 style 尺寸；`getContext('2d', { alpha: true, desynchronized: false })`。
3. 创建同样尺寸的离屏掩码 canvas（纯 alpha 蒙版，初始全不透明=未刮）；`maskCtx.fillRect` 全填黑表示"涂层保留"，擦除用 `globalCompositeOperation='destination-out'`。
4. 水合判定：`initiallyRevealed === true` → 掩码整体 `clearRect`（全透明），容器 `data-state='revealed'`，涂层不接收指针事件；否则绘制完整涂层。
5. 合成首帧：整卡执行一次"先 `source-over` 填涂层底色并绘制提示文字，再 `destination-in` 贴整幅掩码"的全帧合成（见 3.4 第 3 点的合成顺序；首帧不加 clip）。密封态掩码全不透明，结果为完整涂层；水合全开态掩码全透明，结果为空（不产生涂层闪现）。
6. 注册：canvas 上 `pointerdown`；window 上 `pointermove/pointerup/pointercancel`（配合 setPointerCapture，见 R5）；容器上 `ResizeObserver`；`window.matchMedia('(resolution: …dppx)')` 不使用（DPR 变化必伴随布局变化，ResizeObserver 统一兜底）。
7. cleanup（证据 1 必需）：移除以上全部监听、`disconnect()` observer、`cancelAnimationFrame`、清掉采样定时器、`maskCanvas = null`、`ctx = null`。StrictMode 双调用后第二遍从第 1 步重新建立，任何一步重复执行结果都相同（幂等）。

### 3.4 从 pointer 事件到像素擦除的完整链路

1. **pointerdown**（仅 canvas，且 `data-state==='sealed'`）：`canvas.setPointerCapture(event.pointerId)`；记录 `isPointerDown=true`；把当前点写入 `lastPointRef`；调用 `scratchAt(x,y)` 画一个圆点（点一下也要有效）；触发一次 `onScratchStart`；`event` 不调用 `preventDefault`（点击语义保留，滚动由 `touch-action:none` 在 CSS 层解决，见 R8）。
2. **pointermove**（window 监听，仅在 `isPointerDown` 且未揭示时处理）：
   - `rect = canvas.getBoundingClientRect()`；算 `(x,y)`；
   - `inside = x>=0 && y<=rect.width …`（边界判定，越界不画，见 R5）；
   - 取合并事件：`const evs = event.getCoalescedEvents?.() ?? []`；若有则逐点连线（真实轨迹，见 R4），否则只用 `event` 自身一点；
   - 对相邻两点做距离判断：`gap > BRUSH_RADIUS_CSS` 时在两点间按 `ceil(gap / BRUSH_RADIUS_CSS)` 插值补点（兜底，见 R4）；
   - 每个有效点调用 `drawSegment(last, cur)`；
   - 调度面积检测（3.5 的时间门控）。
3. **drawSegment(a,b)**（引擎函数，同时操作掩码与可见层）：
   - 掩码：`maskCtx.globalCompositeOperation='destination-out'`；`lineCap='round'; lineJoin='round'`；`lineWidth = 2*BRUSH_RADIUS_CSS*dpr`；在掩码坐标系（设备像素）画 `a_dev→b_dev` 直线；首点或无 last 时画 arc 圆点。`destination-out` 使已有像素 alpha 被减去，反复涂画幂等、不会出现叠加色差。
   - 可见层：不在整卡重绘，只重绘"线段包围盒+1 设备像素"的脏矩形 `dirty`，保证每帧像素工作量只与笔画宽度相关、与卡片面积无关。该矩形内的合成顺序固定：① `ctx.save(); ctx.beginPath(); ctx.rect(dirty); ctx.clip();`（裁剪把所有后续操作限制在脏矩形内）；② `ctx.clearRect(dirty)`；③ `globalCompositeOperation='source-over'` 回填该矩形涂层底色（提示文字只在初始化整卡绘制一次，脏矩形内**不**重画文字，避免反复叠加产生毛边）；④ `globalCompositeOperation='destination-in'` 把掩码对应区域以设备像素 `drawImage(maskCanvas, dirtySrc, dirtyDst)` 贴上——`destination-in` 的结果 alpha = 已有涂层 alpha × 掩码 alpha，因此掩码不透明处保留涂层、掩码透明孔洞处被裁穿，语义恰好正确；⑤ `ctx.restore()`。注意掩码上下文以设备像素存储、不做 transform，而可见 ctx 已 `setTransform(dpr,…)` 使用 CSS 坐标；第 ④ 步通过给 `drawImage` 传显式源/目标设备像素矩形规避坐标空间不一致，禁止依赖隐式缩放。
4. **pointerup / pointercancel / lostpointercapture**：`isPointerDown=false`；立即执行一次面积检测（保证抬手即判定，不被节流漏掉）；释放 capture（浏览器随 up 自动释放，cancel 时显式 release）。
5. **达到阈值**：`ratio >= 0.5`（采样意义见 3.5/R7）→ latch：移除指针监听；给容器加 `data-state='revealing'`，canvas CSS `opacity:0; transition: opacity 320ms`；`transitionend`（或 320ms 兜底定时器）后 `clearRect` 整张并设 `data-state='revealed'`；调用一次 `onReveal()`。
6. **奖品提示**：Grid 的 `onReveal` 里 `storage.markRevealed(cardId)`（第 5 节），更新 `revealedIds`，按 `prize.isWinning` 推入 toast（中奖才写"恭喜中奖"；未中奖写"谢谢参与"，两者都算揭示完成）。

### 3.5 刮开面积统计：量化与采样策略（getImageData 预算）

**全缓冲区读取的像素预算（禁止方案，量化如下）**

- 标准卡片：桌面三列布局下容器内容宽 `(1126 − 页面边距 − grid gap) ≈ 344 CSS px`，卡片高 `344 × 9/16 = 194 CSS px`（证据 6 的 1126px 基线；手机全宽 360px 时约 328×185，量级相同）。
- dpr=2 时缓冲区：`bufW = 344×2 = 688`，`bufH = 194×2 = 388`，总像素 `688×388 ≈ 266,944`；`getImageData` 每像素 4 字节（RGBA），单次读出 `≈ 1.07 MB`。
- 高频 pointermove 在 60Hz 触屏上可达 60–120 次/秒（部分设备合并前更高）：若每次事件全量读，**每秒 60 × 1.07 MB ≈ 64 MB/s（120Hz 约 128 MB/s）**；每张卡 266,944 次/秒 ×60≈ **1,600 万次 alpha 判断/秒**，多卡页面按卡数倍增。且 `getImageData` 强制 GPU 纹理回读、会stall 渲染管线，是"上线掉帧"的直接来源（R3）。

**采用方案：固定 48×48 采样器 + 时间门控**

1. 维护一张固定 `48×48 = 2,304` 像素的离屏 `samplerCanvas`（与卡片尺寸、DPR 无关）。
2. 检测时：`sctx.clearRect`；以默认 `source-over` 执行 `sctx.drawImage(maskCanvas, 0,0, oldW, oldH, 0,0,48,48)`（GPU 缩放，非 JS 循环；掩码透明孔洞在采样器上仍透明）；`getImageData(0,0,48,48)` 仅读 `2,304×4 = 9,216 字节 ≈ 9 KB`。
3. 遍历 2,304 个 alpha，`alpha < ALPHA_CLEARED(16)` 计为已擦除；`ratio = cleared / 2304`。
4. 触发时机（二者取先到，非每事件）：
   - 时间门：距上次检测 ≥ `SAMPLE_MIN_MS = 200ms`（即 ≤5 次/秒）；
   - 手势结束：`pointerup/pointercancel` 后必做一次；
   - resize 完成后做一次（R6）。
5. 读量对比：9 KB × 5 次/秒 = **45 KB/s**，相对全量 64 MB/s 降低约 **1,400 倍**；JS 判断量 2,304×5 ≈ 1.15 万次/秒。单帧主线程增量 <0.3ms（量级估计），不威胁一帧 16.7ms 预算。
6. 网格间距校验：采样点在 CSS 空间间距 `344/48 ≈ 7.2px`、`194/48 ≈ 4px`，均小于画笔半径 20px（直径 40px），任何一笔至少覆盖 2×2 个采样点，不会漏检整笔。
7. 结果只写入 `ratioRef`；仅当 `Math.floor(ratio*100)` 变化时调 `onProgress`（≤100 次回调）；阈值判断用同一 ratio，避免双份口径。

### 3.6 resize 时已刮内容的保持（完整方案）

触发：`ResizeObserver` 回调（含手机旋转、分栏、DPR 导致的布局变化），contentRect 宽高变化或重新计算的 dpr 变化。

步骤（必须原子完成，中间不合成可见帧）：

1. 从**旧掩码**取出快照 `oldMask`（引用现有离屏 canvas；若旧尺寸为 0 则直接走初始化）。
2. 按 3.2 重算 `dpr/bufW/bufH`，更新可见 canvas 的 `width/height`（赋 width 会自动清空，这是预期的）与 style；新建同尺寸 `newMask`。
3. `newMask` 初始保持**全透明**（canvas 赋值 width/height 后默认全透明，不做填充）；先以 `source-over` 铺一层全不透明黑（表示"暂全部保留"），再设 `newMaskCtx.globalCompositeOperation='destination-in'`，把 `oldMask` **整体按比例缩放绘制**到 `newMask`：`drawImage(oldMask, 0,0, oldW, oldH, 0,0, newW, newH)`，随后恢复 `source-over`。
   - 关键：`destination-in` 的结果 alpha = newMask alpha × 被绘入 oldMask 的 alpha；oldMask 中被刮穿的透明区域使 newMask 对应位置相乘为 0（孔洞保留为透明），未刮处 oldMask 不透明、newMask 保持不透明。孔洞位置随卡片**线性等比映射** `x_new = x_old · newW/oldW`。这里**必须用 `destination-in`，不能用 `destination-out`**：后者会把不透明的"保留区"当成擦除源打穿，导致整张卡除原笔画外全部变透明（孔洞反转）。
   - 因为卡片 `aspect-ratio:16/9` 恒定，x/y 缩放比相同，孔洞不变形（3.2 不变量②）。
   - 画笔边缘经一次双线性缩放可能出现半透明环带，正好由 `ALPHA_CLEARED=16` 容差吸收（R7），不产生"复活的灰边"。
4. `setTransform(dpr,…)` 后整卡合成一帧 `paintCoating()`（尺寸变了，首帧允许整卡重绘，一次）。
5. 用 `newMask` 替换 `maskRef`；旧掩码等待 GC（不调用任何第三方库）；执行一次 3.5 面积检测，若 resize 后比例已 ≥0.5 则直接走揭示流程。
6. ResizeObserver 去抖：同一帧内多次回调只取最后尺寸（用 `requestAnimationFrame` 标记），避免拖拽窗口时反复分配缓冲区。

### 3.7 CSS 层（`scratchCards.css` 关键规则）

```css
.scratch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  padding: 24px 20px;            /* 贴合证据 6 的 ≤1024px 内边距习惯 */
}
.scratch-card { position: relative; aspect-ratio: 16 / 9; border-radius: 12px;
  overflow: hidden; border: 1px solid var(--border); background: var(--bg); }
.scratch-card__coating {
  position: absolute; inset: 0; width: 100%; height: 100%;
  touch-action: none;            /* 见 R8：吃掉滚动手势，且不阻断页面其余区域 */
  cursor: grab;
}
.scratch-card[data-state='revealed'] .scratch-card__coating {
  pointer-events: none; opacity: 1; /* 内容已 clearRect，保留元素仅为 a11y 状态稳定 */
}
.scratch-card[data-state='revealing'] .scratch-card__coating {
  opacity: 0; transition: opacity 320ms ease-out;
}
.scratch-card[data-state='revealed'] .scratch-card__coating { cursor: default; }
```

涂层底色与文字颜色使用新 CSS 变量并在证据 7 的暗色媒体查询中覆盖：`:root{ --scratch-coating:#c9c4d4; --scratch-coating-text:#5a5466; }` 与暗色下的对应值；组件通过 `getComputedStyle(container).getPropertyValue('--scratch-coating')` 在 effect 内读取后传给 hook（对应 2.1 的 `coatingColor`）。

## 4. 风险与对策矩阵

| # | 风险（触发条件） | 根因（精确到 API / React 机制） | 对策（本方案的唯一选择） |
| --- | --- | --- | --- |
| R1 | `npm run dev` 启动后初次进入页面（开发态），涂层重复初始化、事件绑定两份、偶发"刮不动/双倍擦除" | `src/main.jsx:7` 的 `<StrictMode>`（证据 1）使 effect 挂载序列变为 mount→cleanup→mount：若 cleanup 不摘监听/不释放 canvas 状态，第二次挂载会叠加监听器；若初始化非幂等（如先随机化再绘制），两遍结果不一致 | 主 effect 严格按 3.3 七步实现；cleanup 必须移除 window/canvas 全部指针监听、`ResizeObserver.disconnect()`、`cancelAnimationFrame`、清空采样定时器并置空 ctx/mask 引用；所有初始化只依赖 `[cardId, coatingColor, coatingText, initiallyRevealed]` 与可重新测量的布局，不使用任何随机数/时间戳参与绘制（揭示时间戳只写 storage 不画像素）；水合状态每遍都从 `initiallyRevealed` 重新判定 |
| R2 | 手指滑动过程中画面卡顿、React DevTools 显示每帧大量重渲染，多卡时其他卡也跟着 render | `pointermove` 每秒触发 60–120 次；若在回调中 `setState(ratio)`，React 19 仍需对 fiber 调度重渲染（证据 8 表明无 React Compiler 帮你跳过子树），与 canvas 同步绘制争抢同一帧 16.7ms；state 更新还会使 `ScratchCardGrid` 重渲染并牵连同级卡片 | 高频路径只写 `useRef`（`ratioRef/isPointerDownRef/lastPointRef`）与直接 canvas 绘制；React state 仅保存离散结果 `revealedIds:Set` 与 toast；`onProgress` 仅在整数百分点变化时触发且消费方只做轻量文本；回调用 `optionsRef` 读取，props 变化不重建 effect |
| R3 | 边刮边卡，尤其高 DPR 安卓机；多张卡同时存在时掉帧明显 | `CanvasRenderingContext2D.getImageData()` 是同步调用，强制把 GPU 合成结果回读到 CPU 内存并 stall 渲染管线。按 3.5 量化：344×194 CSS 卡在 dpr=2 下缓冲区 688×388≈26.7 万像素、单次约 1.07MB；60Hz 全量读 = 64MB/s 与 1,600 万次/秒 alpha 判断 | 采用 3.5 固定 48×48 采样器（每次 9KB）+ 200ms 时间门（≤5 次/秒）+ pointerup/resize 补检；读量降至 45KB/s（约 1/1,400）；检测与绘制解耦，绘制永远不等检测 |
| R4 | 快速甩动一笔后，划痕是一串断开的圆点/缺口（"刮不中的断线"） | 浏览器在一帧内合并多个指针位移，事件只派发合成后的 `pointermove`；两点间距离可能超过画笔直径，只在事件点画圆点/短线就留缝。`PointerEvent.getCoalescedEvents()` 返回帧内真实子点，但并非所有环境/所有帧都能提供（首帧、某些鼠标驱动、降级场景为空） | 两级策略，顺序固定：①有 `getCoalescedEvents()` 且数组非空时严格按合并点逐段画线（保真实轨迹，不人为补点）；②为空或相邻有效点间距 `> BRUSH_RADIUS_CSS(20px)` 时，按 `ceil(gap/20)` 在两点间线性插值补点，再统一 `lineCap/lineJoin='round'` 连画。**取合并事件为准、插值只做兜底**（取舍见第 7 节）；pointerdown 首点画实心圆点 |
| R5 | 手指在卡内按下、滑出卡片外（甚至滑到相邻卡片上）再滑回来，卡片边缘/外侧出现不该有的擦除破口，或相邻卡被误刮 | 没有 pointer capture 时，指针离开元素后目标元素改变（elementFromPoint 落到相邻卡或 document），move 事件派发到别的元素；若把"外点"clamp 到边缘再画，就会在边界产生越界擦除；滑回时 lastPoint 仍停在外部旧坐标，一条跨越卡片的连线把整行打穿 | ①pointerdown 即 `canvas.setPointerCapture(pointerId)`，保证按下期间所有 move/up 都派发到本 canvas；②window 级监听 move/up 作为 capture 的双保险；③每点先做矩形包含判定，**外部点不 clamp、不绘制，只更新 lastPoint 前先标记上一有效点**；从外部回到内部时以"内部点画圆点"起笔，绝不连接跨边界两点；④up/cancel/lostpointercapture 统一复位 `isPointerDown`；⑤每卡独立 canvas、独立 hook 实例，capture 不共享 |
| R6 | 手机旋转横竖屏、桌面拖窗、分栏宽度变化后，已刮区域错位、被涂层盖住，或卡片变花 | 给 `canvas.width/height` 赋新值会**自动清空**整个缓冲区；若直接重绘涂层，旧孔洞全部丢失；若把旧缓冲区分块搬运，DPR 变化时坐标系失配产生错位；ResizeObserver 在一次布局变化中可能连续回调多次，重复分配造成抖动 | 采用 3.6 完整方案：以离屏**保留掩码 canvas**（不透明=留涂层）为唯一真相源，resize 时先保存旧掩码→按新 CSS 尺寸与（可能变化的）dpr 重建缓冲→新掩码先铺全不透明、再以 **`destination-in`** 把旧掩码等比 `drawImage` 映射（`x'=x·newW/oldW`，16:9 固定宽高比保证不变形；禁止用 `destination-out`，否则保留区被打穿、孔洞反转）→按 3.4 的"填涂层+destination-in 贴掩码"整卡合成首帧→替换掩码引用并补一次面积检测；ResizeObserver 回调经 rAF 去重，每帧最多重建一次；揭示后的卡无需重建内容（掩码已全空，重绘即全透） |
| R7 | 明明没刮到一半却提前全开，或刮了约一半不开 | 擦除不是硬 alpha：`destination-out` 边缘与一次缩放（R6）会留下 0–255 的半透明像素；若用 `alpha===0` 判定，边缘大量"看起来已刮掉"的像素不计数→比例偏小、晚开；若用 `alpha<255` 判定，抗锯齿灰边全计入→比例偏大、早开。48×48 采样相对真实面积存在网格量化误差 | 判定口径唯一：`alpha < 16`（ALPHA_CLEARED）计为已擦除——该值在"视觉完全见底"区间内（涂层 alpha 从 255 被扣到 ≤15 时肉眼已透），且能吸收一次双线性缩放产生的灰边；采样固定 48 格、间距小于画笔直径（3.5 第 6 点），量化偏差 ≤2 个百分点；阈值 `ratio≥0.50` 单向 latch（越过即开、不回退），验收口径写为真实刮面 48%–52% 区间内触发（第 6 节 T13）；检测只在采样器上做，肉眼判定与计数口径同一来源 |
| R8 | 手机上手指刮卡时页面跟着上下滚动/下拉刷新，划痕中断；双击缩放干扰 | 触屏默认手势（滚动、缩放手势、over-scroll 刷新）在浏览器层面劫持触摸序列，使 `pointermove` 被取消或派发 `pointercancel`；用 `event.preventDefault()` 不可靠（passive listener 下被忽略）且会误伤页面其余滚动 | CSS 层解决，只作用于涂层：`.scratch-card__coating { touch-action: none; }`（3.7），浏览器据此不发起滚动/缩放手势，也不产生被动监听冲突；卡片容器与页面其余区域保持默认可滚动；同时监听 `pointercancel` 当作抬手正常收尾（补检测+复位），杜绝手势打断后状态卡死；不使用 preventDefault 方案 |
| R9 | 揭示动画/提示在快速来回刮、StrictMode 重挂载、resize 竞态下重复触发或漏触发 | 阈值在 0.5 附近抖动时若无锁，回调可多次执行；`onReveal` 引发 Grid setState 与本卡 effect cleanup（因父树重渲染期间发生卸载）可能交叉；异步 transitionend 在元素已卸载时永不触发 | `revealedRef` 单向锁：首次 `ratio>=0.5` 立即置位并移除本卡全部指针监听，之后任何检测/事件短路；`onReveal` 只调用一次；淡出同时挂 `transitionend` 与 320ms `setTimeout` 双兜底，cleanup 中两者都清；先摘监听后做动画，保证动画期间输入无效；storage 写入与 setState 在同一个 `onReveal` 调用栈内同步完成 |
| R10 | 某些高 DPR/低端机上涂层模糊、或 dpr=3 时缓冲区过大反而卡顿 | canvas 只设 CSS 尺寸不设后备尺寸时按 1:1 像素光栅化，dpr=2/3 屏上涂层与文字发虚；反之无上限按 dpr=3 建缓冲，344×194 卡变成 1032×582≈60 万像素，绘制与回读成本再涨 2.25 倍 | `dpr=min(devicePixelRatio||1, 2)` 统一钳制（3.2）：dpr=2 下涂层清晰（演示卡片无 1px 级细节），缓冲上限 688×388；奖品文案本就是 DOM（3.1）不受钳制影响始终锐利；dpr 变化经 R6 的 resize 流程收敛，不单独监听 |
| R11 | 刷新后已刮卡先完整闪现涂层再变透明（闪烁），或未刮卡的刮开进度意外保留 | 若首帧先画完整涂层、effect 内再异步读取 storage 改透明，会产生一帧以上闪烁；若把每笔进度都持久化，写入频率高且半截进度语义不清 | 首帧绘制**之前**完成水合判定：Grid 挂载时同步 `storage.readRevealed()`（localStorage 同步 API，首渲染前可得），把 `initiallyRevealed` 作为初始 props 传入；effect 第 4 步据此直接建立全透掩码、不画涂层（3.3）；只持久化"已揭示"这一终态，不保存中间进度（取舍见第 7 节）；`reveal()/reset()` 与持久化记录一一对应 |
| R12 | 多卡同页、暗色模式、键盘用户、toast 堆叠等工程性问题 | 多实例共用单例状态会串卡；暗色下硬编码灰涂层对比度失真；纯 canvas 无键盘入口；多个 onReveal 同帧到达时 toast 覆盖 | 每卡独立 hook 实例与独立掩码/采样器，共享的只有引擎纯函数与常量；涂层色/文字色走 CSS 变量并在暗色媒体查询覆盖（3.7，证据 7）；每卡提供视觉上可见的"刮开"按钮调用同一路径的 `reveal()`，canvas 设 `aria-hidden`、奖品层正常可读屏；Grid 用 toast 队列（最多同时 1 条、1800ms 自动消失，最新入队），中奖/未中奖文案不同；所有句柄 `useCallback` 固定引用（证据 8） |

## 5. 持久化设计

### 5.1 key 命名与存储结构

- **单 key 聚合存储**（不是每张卡一个 key）：
  - 实际 key：`scratch-card:revealed:v1`
  - 规则拆解：固定前缀 `scratch-card:` + 域 `revealed` + schema 版本 `v1`。`scratchStorage.js` 内部用常量拼接，调用方不拼字符串。
  - 2.3 的 `storageNamespace` 仅用于同一页面未来出现多套刮刮卡时追加后缀，格式 `scratch-card:revealed:v1:<namespace>`；当前演示固定 `v1`。
- value（JSON）：

```json
{
  "demo-001": { "v": 1, "ts": 1727337600000 },
  "demo-002": { "v": 1, "ts": 1727337612345 }
}
```

顶层对象的键就是 `cardId`（字符集白名单 `[A-Za-z0-9_-]{1,40}`，与数据文件中的 id 同源校验），值为 `StoredCardRecord`。

### 5.2 存储内容与不存的内容

- **存**：仅"已揭示（自动全开或按钮全开）"这一终态 + 记录版本号 `v=1` + 时间戳 `ts`。中奖与否不存——奖品结果由静态数据 `scratchCards.data.js` 决定，持久化只表达"这张卡开过"。
- **不存**：刮开比例、涂层位图、笔迹坐标、toast 状态。理由：①终态之外的半截进度在产品语义上无意义（第 7 节取舍 D）；②位图 base64 每张约数十至数百 KB，多卡会迅速逼近 localStorage 容量且同步写入阻塞主线程。
- 写入时机唯一：`onReveal` 触发、单向锁置位的同一调用栈内 `markRevealed` 同步写入一次。

### 5.3 容量估算

- 单条记录 JSON 形态 `\"demo-001\":{\"v\":1,\"ts\":1727337600000}`，id 取 8 字符时约 40 字节；含顶层括号与逗号分摊，**每张卡 ≈ 40–45 字节**。
- 演示 6 张卡：< 0.3 KB；即使 50 张卡：约 2.2 KB。相对 localStorage 常见 5 MB/源配额可忽略，不存在容量风险；`markRevealed` 仍要捕获 `QuotaExceededError`（隐私模式/配额被占满时写失败只降级为"本次会话内有效"，不阻断揭示动画与提示）。

### 5.4 损坏数据兜底（readRevealed 的严格流程）

1. `localStorage.getItem(key)` 包 `try/catch`（`SecurityError`：禁用 cookie/隐私模式；直接返回 `{}` 并把模块标记为内存降级模式，后续读写只走内存 Map）。
2. 值为 `null` → 返回 `{}`（首次使用，正常路径）。
3. `JSON.parse` 抛错 → 视为损坏：`localStorage.removeItem(key)` 清除坏值并返回 `{}`（清除动作同样 try/catch）。
4. 解析结果不是纯对象（数组/null/原始值）→ 同上清除并返回 `{}`。
5. 逐字段校验：键名匹配 `^[A-Za-z0-9_-]{1,40}$`、值为对象、`v===1`、`typeof ts==='number'` 且有限；任一不满足**只丢弃该条**，其余保留（过滤后若与原文不同则回写一份净化结果，回写失败静默）。
6. 与当前数据文件做交集：`SCRATCH_CARDS` 中已不存在的 id 视为孤儿记录忽略不渲染（可在净化回写时顺手删除）。
7. 所有写操作（`markRevealed/removeCard/clearAll`）为"读全量→改内存对象→整体序列化写回"，序列化失败不改变已生效的内存状态。

## 6. 测试与验收计划

环境：`npm install` 后用 `npm run lint`、`npm run build`、`npm run preview`（证据 4）在桌面 Chrome/Safari 与移动端 Safari/Chrome 各执行一次。步骤均为人工可执行；"风险"列对应第 4 节编号。

| # | 原始需求条目 | 步骤 | 预期结果 | 风险 |
| --- | --- | --- | --- | --- |
| T1 | 涂层可刮开 | `npm run dev` 打开首页；鼠标在任一卡涂层上按下并拖动一段距离 | 轨迹处涂层被真实擦除，底层奖品文字清晰露出；松开停止；点按（单击不拖）也留下一个直径约 40px 的圆形擦除点 | R2,R3 |
| T2 | 刮到一半自动全开 | 持续刮擦，目测刮开面积接近一半（可反复轻刮控制速度） | 刮开面积处于约一半（真实刮面 48%–52% 区间）时，涂层在 320ms 内淡出全开，无需再刮；自动揭示后指针在原涂层区操作不再产生擦除 | R7,R9 |
| T3 | 提示中奖（与未中奖文案区分） | 对 `isWinning:true` 与 `false` 的卡各触发一次 T2 | 中奖卡弹出"恭喜中奖：<奖品标题>"；未中奖卡弹出"谢谢参与"；toast 最多同时 1 条、1800ms 消失；多卡连刮时 toast 依次排队不叠加 | R12 |
| T4 | 手机可用 | 手机浏览器（iOS Safari、Android Chrome）打开页面，单指刮卡 | 跟随手指擦除，页面**不**滚动、不触发下拉刷新/双击缩放；横竖屏切换后已刮区域仍正确（结合 T8）；涂层与奖品文字不模糊 | R8,R10 |
| T5 | 桌面可用 | 桌面 Chrome、Safari 鼠标快速甩划多笔 | 笔画连续无圆点断线，无肉眼可见卡顿（60fps 主观流畅）；打开性能面板录制，刮擦期间无长任务（单帧主线程绘制增量小、检测每秒 ≤5 次） | R3,R4 |
| T6 | 刷新后记住已刮开 | 刮开 2 张卡（含一张中奖一张未中奖）→ 整页刷新（F5）两次；再关闭标签页重新打开 | 已刮卡**首屏即全开**（无完整涂层闪现），未刮卡保持完整涂层；DevTools Application 面板可见 `scratch-card:revealed:v1`，value 为 5.1 的 JSON | R11 |
| T7 | 页面上不止一张卡 | 检查页面卡片数量并对不同卡片交错操作；在 A 卡按下不松手滑过 B 卡再回到 A | 卡片按 grid 多列/自适应排列（桌面多列、≤1024px 折行）；B 卡不被误刮；A 卡边缘外与回划连线上无越界破口；各卡揭示互不影响 | R5,R12 |
| T8 | resize 保持已刮内容 | 桌面拖放窗口宽度跨越 1024px 断点；手机切换横竖屏；DevTools 设备工具栏切换 dpr（1×/2×/3×） | 每次变化后卡片不重置：旧孔洞按比例映射到新尺寸、不变形、不复活灰边；尺寸稳定后继续刮与揭示功能正常；若变化前已过阈值则变化后直接全开 | R6,R10 |
| T9 | 不掉帧（量化） | DevTools Performance 录制 10 秒快速刮擦（单卡与页面 6 卡各一次） | 无掉帧导致的肉眼卡顿；单次面积检测读取 ≤9,216 字节、每秒 ≤5 次（可在引擎临时打点验证后移除打点）；无每 pointermove 触发的 React 提交（Profiler 中 Grid 不随移动重渲染） | R2,R3 |
| T10 | 无断线 | 以最快速度从卡片一侧甩到另一侧，连续 10 次 | 每笔均为连续实线；直径 40px 路径上无可见缺口/串珠 | R4 |
| T11 | 无越界破口 | 卡内按下→滑出卡片 200px 以上（滑到相邻卡与页面空白处）→不松手滑回继续刮→松开，重复 5 次；再做"按下后直接滑出松开" | 卡片边界外无任何擦除；相邻卡涂层完好；滑回后从回入点继续，不出现横穿卡片的直线；状态正常复位，再次按下仍可刮 | R5 |
| T12 | StrictMode 双挂载正确 | `npm run dev`（StrictMode 因证据 1 生效）下反复进出页面、HMR 保存触发重挂载；生产构建 `npm run build && npm run preview` 再验一遍 | 两种模式下均无重复监听症状（擦除速度不翻倍、无"一次移动两笔"）、无泄露报错；水合状态一致；开发与生产行为一致 | R1 |
| T13 | 阈值边界不误判 | 用尺/辅助线按约 30%、45%、48%、52%、60% 面积各刮一张（可借助模板控制刮面），每次刮完抬手等待 1 秒 | 30%/45% 不开；48%–52% 区间内必然全开（单次越过即开，再继续刮不重复弹 toast）；60% 必开；阈值触发仅一次 | R7,R9 |
| T14 | localStorage 兜底 | DevTools 中把 key 改为非法 JSON（如 `abc{`）刷新；改为 `{"x":1}` 刷新；删除该 key 刷新；浏览器设为阻止第三方/站点存储后刮卡 | 坏数据下页面正常渲染、所有卡为未刮且 key 被重置为合法 JSON；`{"x":1}` 被净化为空；无 key 正常初始化；禁存储时刮卡/全开/提示本次会话内正常，控制台无未捕获异常 | 5.4 |
| T15 | 无障碍与键盘 | Tab 聚焦到卡片的"刮开"按钮，Enter；再对未聚焦 canvas 用读屏器检查 | 按钮调用与刮擦同一路径全开并写持久化；奖品文案可被读屏朗读，canvas 对读屏隐藏；刷新后全开状态保持 | R11,R12 |
| T16 | 静态质量 | 执行 `npm run lint` 与 `npm run build` | lint 0 error（含 react-hooks 与 react-refresh 规则，证据 3）；build 成功；bundle 不新增任何第三方依赖（`package.json` 依赖项与证据 2 完全一致） | 全局 |
| T17 | 暗色模式 | 系统切换深色外观后刷新并刮卡 | 涂层、卡片底、边框随证据 7 的 CSS 变量呈现暗色版本，文字对比清晰，擦除效果一致 | R12 |

## 7. 未决问题清单（已拍板的二选一取舍）

以下均为"选 A 弃 B"的明确取舍，不存在两者兼得的表述：

1. **A（采用）：保持纯 `.jsx/.js` + JSDoc 表达类型；B（放弃）：引入 TypeScript。** 理由：证据 2 的 devDependencies 没有 TS/typescript-eslint，证据 4 的验收脚本只有 vite/eslint；为一个演示组件新增构建链与配置违反"不留技术决策空白"之外的最小变更原则。代价是类型错误只能靠评审与 JSDoc 约束，不享受编译期检查。
2. **A（采用）：单张可见 canvas + 离屏 alpha 掩码，脏矩形合成；B（放弃）：双可见 canvas 叠层（底图/擦除层）或全屏整卡重绘。** 理由：双叠层在 resize 时仍需同步两张缓冲且层级遮挡容易在半透明边缘露馅；整卡重绘把每帧成本拉到 O(卡片面积)，直接违背不掉帧目标。代价是引擎多维护一张离屏缓冲（约 1.07MB 内存/卡，可接受）。
3. **A（采用）：`getCoalescedEvents()` 为准、超距线性插值仅作空合并时的兜底；B（放弃）：无视合并事件只做插值，或每帧固定密集插值。** 理由：合并点是浏览器给出的真实轨迹，插值是几何猜测，密集插值会在曲线处产生锯齿并浪费绘制；只用事件点又会断线（R4）。代价是兜底分支仍需测试覆盖。
4. **A（采用）：只持久化"已揭示"终态，刷新后未刮完的卡回到完整涂层；B（放弃）：持久化笔迹/比例/位图实现半截续刮。** 理由：产品原话是"刷新后记住已刮开"，终态即可满足；位图存储每张数十至数百 KB 且同步写阻塞主线程，半截续刮还引入 resize/版本兼容复杂度。代价是用户刷新会丢失未过半的进度。
5. **A（采用）：高频路径完全同步直接绘制，不引入 rAF 批量合帧；B（放弃）：把事件坐标入队、rAF 统一绘制。** 理由：单次线段擦除是很小的 GPU 指令，同步绘制延迟最低且实现可证明无断线；rAF 批处理需要自己维护点队列，反而可能在一帧多点时丢首点。代价是极端高频事件（>帧率）下同帧多次小绘制，经实测预算可接受（R3 量化）。
6. **A（采用）：`dpr` 上限钳制为 2；B（放弃）：完全跟随 `devicePixelRatio`（含 3）。** 理由：3× 缓冲像素量是 2× 的 2.25 倍，涂层为纯色+大字，2× 与 3× 肉眼无差异；奖品文字是 DOM 不经过该缓冲。代价是 dpr=3 设备上若未来把精细图案画入涂层会略软（当前没有这种内容）。
7. **A（采用）：自动全开用 CSS `opacity` 320ms 淡出后 `clearRect`；B（放弃）：JS 逐帧动画降低涂层 alpha 或立即清空。** 理由：CSS 过渡走合成线程不占主线程；立即清空突兀、逐帧 JS 动画与 R2 的掉帧风险同源。代价：动画期（320ms）已摘除输入，用户在此窗口的额外刮擦无效（产品可接受，且更确定）。
8. **A（采用）：面积检测用固定 48×48 采样器 + 200ms 节流 + pointerup/resize 补检；B（放弃）：全缓冲 `getImageData` 每事件检测，或仅在 pointerup 检测。** 理由：前者 45KB/s、后者 64MB/s（R3）；仅抬手检测会让"刮到一半停住"不触发全开，违背需求。代价：阈值触发在时间上最多滞后约 200ms（<一帧动画的感知量级），面积上有 ≤2 个百分点网格误差（R7 已用容差与验收区间吸收）。
9. **A（采用）：`touch-action: none` 只加在涂层 canvas 上；B（放弃）：在容器/页面级禁用触摸滚动，或在 JS 里 `preventDefault`。** 理由：页面其他区域必须保持可滚动；passive 监听下 preventDefault 无效且语义混乱。代价是涂层区域内的滚动完全由刮擦接管（正是预期）。
10. **A（采用）：单 localStorage key 聚合 JSON + 版本号；B（放弃）：每卡一个 key 或存 IndexedDB。** 理由：单 key 读写一次即可水合整页、容量可估算（5.3）；IndexedDB 异步导致首帧水合必须加 loading 态，与 R11 的无闪烁目标冲突。代价：写入是全量重写，但 50 张卡仅约 2.2KB，成本可忽略。

---
