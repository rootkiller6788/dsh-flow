# dsh-flow

DeepSeek Harness 的**一张画布、两个图层**插件：一层看**团队**（agent-teams 的成员与任务 DAG），一层看**会话**（对话轮次构成的非线性工作区）。

画布是对话区顶部**一个**标签，和宿主自带的「对话」「轨迹」排在同一行（`conversation.view` slot，`order: 20`）：

```
[ 对话 ]   [ 轨迹 ]   [ 智能体画布 ]
```

两个图层在**同一个标签、同一个 iframe** 里：画布控制行最左边的 **转换** 按钮把这一层换成另一层（`[转换] [重置] [−] [100%] [＋]`，两层的控制行逐字相同，所以往哪边切都行）。**默认停在「智能体画布」图层**——标签叫什么就先给什么。

标签选择由宿主**按会话持久化**（`dsh.conversation.<sessionId>`），且存着的 id 找不到时会回落到「对话」——所以插件卸载不会把某个会话困在空白页里。画布页**自身不画任何导航**：没有「回到对话」按钮，也没有内嵌的切换条，因为换标签和回对话本来就是宿主标签行的职责；图层之间的切换则由画布自己的 **转换** 按钮负责。

画布页也**不画自己的品牌行**，页面上不出现插件名：智能体画布顶栏原先写着 `dsh-flow`、会话地图顶栏原先写着 `Synapse`，都已删除，现在各自的顶栏里只剩画布控制按钮（两边同为 44px、同为右对齐的同一组控件）。**画布叫什么只由宿主标签行决定，当前在哪一层只由控制行的 转换 决定。**

| 图层 | 路由 | 画的是什么 | 数据源 |
|---|---|---|---|
| **智能体画布** | `/dsh-flow/` | 多 agent 团队：外层是**成员**，放大到阈值后展开成**任务依赖 DAG**（两层语义缩放） | 只读轮询 `dsh-agent-teams` 的 `GET /plugins/dsh-agent-teams/state` |
| **会话地图** | `/dsh-flow/map/` | 对话轮次构成的**非线性工作区**（父/子分支树），可分支 / 继续 / 发消息 | 宿主 `sessions` + `workspaces` 服务，落盘到 `flow/workspaces.json` |

### 为什么不是两个标签

早先这两层是**两个平级标签**（`flow` / `flow-map`）。宿主只渲染当前激活的 View（`renderSlot(..., { only: active.id })`），所以两个标签必然是**两个文档、两套引擎**，标签行把一个画布读成了两个功能——这正是"拼接缝合"感的来源。

现在合成一个：标签只剩「智能体画布」，两层由一个 **转换** 按钮切换，`client.js` 把**同一个 iframe 的 `src` 指到另一层**。两套引擎因此仍是各自独立的文档（没有合并、没有重写），只是不再各占一个标签。**代价**：`src` 变更就是一次导航，所以每次 转换 都是一次重新加载（和过去切标签同价）。这是保留两套引擎的诚实成本。

会话地图的渲染层整体来自 `dsh-synapse`（本插件的前身参考），已并入同一插件：与智能体画布共用主题/语言桥，但各自独立画布引擎。并入后按用户要求**删掉了画布自带的那条侧边栏**（会话列表 / 新建按钮 / 工作区选择器）——**边栏是宿主的职责，画布只负责画布**，所以地图层现在只有一条 44px 顶栏：左边不放东西，右边是画布控制。**地图也不再有自己的会话页**（见「已知边界」）；渲染层内部仍叫 synapse（`/dsh-flow/map.js`）。

## 依赖

- **智能体画布图层**：必须已安装并启用 `@nanmicoder/dsh-agent-teams`，且至少拉起过一个团队。否则该层进入空态。
- **会话地图图层**：无额外依赖，直接用宿主会话。

## 架构

```
dsh-flow (纯 JS，无运行时依赖)
├── index.js            # 宿主侧：复用 DSH webServer，serve 两个页面 + 会话地图 API
├── client.js           # 客户端：一个 conversation.view 标签（内含两个图层）+ 主题/语言跟随 + 会话动作中继
├── app.js              # 【智能体画布图层】引擎 + 数据归一化 + 语义缩放 + 轮询
├── styles.css          # 【智能体画布图层】team / member / task 卡片样式
├── map.js              # 【会话地图图层】画布引擎 + 会话投影轮询
├── map.css             # 【会话地图图层】样式（含深色主题）
├── cordis.patch.yml    # 插入 dsh-flow 服务
└── package.json        # dsh.bundle.patch + dsh.client.inject
```

### 一个标签、两个图层怎么来的

`client.js` 对 slot 只注册**一条**条目，宿主把 `slots.entries('conversation.view')` 直接投影成标签行（按 `order` 升序，宿主自己是 0 / 10）：

```js
const LAYERS = {
  team:    { src: '/dsh-flow/',     label: 'view.canvas' },   // 默认层，标签名就是它
  session: { src: '/dsh-flow/map/', label: 'view.map' },
}
let layer = 'team'   // 模块级状态，不是 React state：宿主只渲染激活 View，
                     // 切走/切回会卸载重挂，层级不该跟着丢
```

标签体是**一个 iframe**，除此之外什么都不渲染。iframe 在挂载时创建、卸载时移除：宿主一次只渲染当前 View，而 iframe 一旦离开文档，它的浏览上下文就销毁了——所以切走再切回来必然是一次重新加载，回来后落在**你离开时的那一层**。

**图层切换**：两层的控制行都有 `data-action="switch-layer"` 的 转换 按钮，点击 → `post('flow:switch-layer')` → `client.js` 翻转 `layer` 并执行 `showLayer()`：

```js
const showLayer = () => {
  const frame = frames.get(CANVAS)
  frame.parentElement?.classList.add('is-opening')   // 先藏住旧层的像素，换层不闪白
  frame.title = t(LAYERS[layer].label)
  frame.src = LAYERS[layer].src                      // 给活着的 iframe 赋 src = 导航
}
```

**按层分发的消息**：一个 frame 扛两层，所以"这条消息发给谁"只能由 `layer` 判断。会话地图那一侧的推送统一走 `sendSession(...)`，只在 `layer === 'session'` 时发出（而不是丢给一个会忽略它的画布层）；主题则是**谁在屏幕上就发给谁**，换层时 `onLoad` 会再同步一次，不会出现"换过去还没被告知主题"的页面。

### 两条独立的数据通路

- **智能体画布图层**：纯前端，1s 轮询 agent-teams 的 `/state`。宿主侧只 serve 静态文件，**无状态**。
  - 边永远从依赖关系现算：`task.dependencies` → 三次 bezier 边，不落盘。
  - 位置持久化：`localStorage`（key `dsh-flow:positions:v1`），只是视觉元数据，**永不确定节点身份**。真身是 agent-teams 的 `teamId` / member name / task id。
  - 两层语义缩放：`TASK_ZOOM_THRESHOLD = 1.5`。低于阈值只渲染 team + member；跨过阈值展开 task 节点与依赖边。
- **会话地图图层**：宿主侧 `WorkspaceStore` + 会话事件投影（去抖写盘，跨进程文件锁），API 挂在 `/dsh-flow/map-api/*`。画布只存视觉布局，**会话真身始终在 DSH**。会话同步（`/map-api/sessions/sync`）与图层无关地一直在跑，所以换层时数据是热的。

### 主题 / 语言

两个图层都跟随宿主，并且走**宿主自己的服务**、不做 DOM 嗅探——所以 `system` 偏好会被解析成真实的浅/深色，区域化的语言 id（`zh-CN`）也能正确归到中文：

- 深色主题：`ctx.theme.getTheme().active.colorScheme` 取初值 + `ctx.on('theme/change')` 跟随 → `postMessage('flow:theme')` → iframe 设 `data-theme="dark"`，CSS 变量切换。
- 语言：`ctx.locale.getSnapshot().active` 取初值 + `ctx.locale.subscribe()` 跟随 → 标签文案用 `ctx.locale.bind(NS)` 在注册时取（thunk，换语言不需要重新注册），画布内文案走 `postMessage('flow:locale')`。**会话地图图层内部文案目前仍是中文**（见已知边界）。

## 构建 / 验证

```bash
node --check dsh-flow/index.js && node --check dsh-flow/client.js \
  && node --check dsh-flow/app.js && node --check dsh-flow/map.js

dsh web
# 对话区顶部标签行点「智能体画布」，再用控制行最左边的「转换」换层
# 也可以直接打开 /dsh-flow/（智能体画布层）或 /dsh-flow/map/（会话地图层）
```

改动 `client.js` 后**必须重启宿主**：客户端 bundle 有 `rev` 哈希，重启才会重新打包。`app.js` / `map.js` / CSS 是每次请求现读（`cache-control: no-store`），改完刷新页面即可。

## 已知边界

- **智能体画布图层只读**：不发起 halt/plan/edit，写操作仍在原生对话里由 AgentTeams 工具完成。
- **转换 = 一次重载**：宿主一次只渲染当前 View，iframe 换 `src` 就是导航，旧层的浏览上下文销毁。会话地图的 JS 有 100KB+，每次换到它都有一次重载代价。（早先那版把两个画布塞进同一个标签、切显隐避免重载，代价是标签里多出一层「对话 / Flow 画布 / 会话地图」的嵌套导航（当时的旧名）——已废弃；再早先那版是两个平级标签，被这一版取代。）
- **画布页不带导航 chrome**：入口只有宿主标签行。标签只在**有会话**时出现（宿主对空白会话整个返回 null，标签行本身也不渲染）。若宿主 `slots` 服务缺失，标签不会注册，此时只能用上面的直链。
- **切到画布时隐藏宿主的原生对话框（含它的两个附件）**：宿主在「对话」标签底部常驻一个**会话级** composer（`conversation.composer` slot，对所有标签都在，切到画布时它仍显示在 iframe 下方）。插件从 `client.js` 里利用「宿主只渲染激活视图（`{ only: active.id }`）」这一点：我们的 iframe 一挂载就往 `<body>` 加 `dsh-flow-view-active` 类，用 scoped CSS 隐藏它，切回对话/轨迹即还原。宿主 composer 不归插件插槽管辖，没有干净开关直接不渲染，这是目前最可逆、只影响自己标签的做法。
  - 隐藏的是**整条** composer，不是那张输入框：`[data-composer-seat]` 里装着宿主拼出来的整条 slot 链——对话编辑器、`user-questions` 的追问面板、`subagent` 的只读 composer、附件区，所以它们都不会再冒到画布上。宿主另一形态（视图自带 `[data-conversation-composer-overlay]` 标记，轨迹层就是这么干的）也有一条同样的规则兜住。
  - **同一条规则还负责列宽拖拽手柄**：宿主把两个 `[data-width-handle]` 一直摆在对话列两侧（`position:absolute; top:0; bottom:0; cursor:col-resize`），只隐藏输入框的话它们会横在画布左右边缘上——在画布里拖一下，改的是**宿主对话列的宽度**。宿主自己遇到 overlay 形态的 composer 时也会隐藏它们（`.root:has([data-conversation-composer-overlay]) .widthHandle{display:none}`），这里用的是同一招，只是换成本插件挂载的判据。
  - 挂载用 **`useLayoutEffect`** 而不是 `useEffect`：隐藏靠的是那个 body 类，而被动 effect 跑在宿主**已经画完一帧之后**——每次切进画布，原生输入框都会先亮一帧。实测（无头 Chromium 按帧采样，`对话 → 智能体画布`）切过去后 **541 帧里 0 帧**画出原生输入框，第一帧就已经是隐藏态；切回「对话」`[data-composer-seat]` 恢复 `flex`、两个手柄恢复 `block`。
  - 已知的**邻居**（不是本插件的东西，也不归本插件管）：`@nanmicoder/dsh-agent-teams` 有一颗悬浮徽标（`.aYQbCq_badge{position:absolute;top:64px;right:18px}`，挂在铺满窗口的 overlay 层里），在原生「对话」里浮在空白处，到画布页正好压住控制行最右边的 **＋**（重叠约 11px）。要处理的话得在插件侧为它加一条 scoped 规则，或反馈给上游。
- **会话地图图层不重复宿主已有的东西**：**没有自己的侧边栏**——会话列表、切换会话、新建会话、工作区选择器宿主全都有，画布只画图，多一条侧边栏只会和宿主那条打架。相应地：
  - 画布**顶栏右侧只有四个按钮加一个比例标签**：**转换** / **重置** / 缩小 / 缩放比例 / 放大——和智能体画布**逐字相同**（同样的 `canvas-controls` 容器、同样的顺序、同样只用文字 `转换` `重置` `−` `＋` 不带图标、同样 100% 起算的 `.zoom-label`），且**和画布一样始终渲染**（空画布时也在），**没有新建**。**转换**是唯一的"换层"入口（放在最左：它离开这一层，其余控件都作用在这一层）；**重置**是唯一的"回到初始状态"入口：它同时做三件事——清掉拖拽留下的卡片坐标（恢复自动布局）、重置相机、缩放回 100%。原来的**整理**（= 重新布局）和**定位**（= 对准当前会话）两个按钮已删掉：前者是重置的一半，后者早就由换会话时的自动对焦覆盖了（`flow:current-session` → `focusActiveCard`）。「新建会话」只在**空画布**时出现一次（画布中央那个大按钮），一旦画布上有卡片就交给宿主——新建会话是宿主的职责。
  - 工作区**自动跟随** DSH 当前会话所在的工作区（在 DSH 原生界面换工作区，画布跟着换），不需要再选一次。
  - **没有自己的会话页**：地图只有画布这一个视图（`state.mode`、`.detail-view`、详情页的消息列表和底部「继续当前会话… / 发送」输入框都已删除）。**地图负责画图，对话归宿主**——所以卡片上的**详情/标题**和 **DSH** 按钮、检查器里的**在 DSH 中打开**，走的都是同一个动作：`flow:open-session`，即切回宿主的「对话」标签并锚定到那一轮（`ctx.sessions.open()` + `openView('chat')`）。想继续追问、想看完整过程记录、想创建分支，都在原生对话里做。
  - 右侧的**卡片检查器**保留：点卡片（非按钮区域）打开，只读地展开这一轮的提问/回答/工具调用，底部给出「继续追问 / 创建分支 / 在 DSH 中打开」。继续追问与创建分支会在画布上开一张草稿卡，输入仍发生在画布上（这是地图唯一的写入口）。
- **两个图层共用一套外观规格**：会话地图的顶栏与控制行是**照着智能体画布抄的**——同样的 44px 顶栏、下边框、按钮高度/内距/字号/圆角、缩放比例的 46px 定宽，以及同一套背景色（浅色 `#f5f7fa` 画布 + `#fff` 面板，深色 `#151517` 画布 + `#1b1b1c` 面板）。**目前是两份重复的 CSS 值**（`styles.css` 与 `map.css` 各一份），真正的去重要把相机层抽成共用模块——见文档末尾。删掉地图的会话页时，`.detail-view` / `.message-*` / `.compare-*` 三族样式也一并清掉了，`map.css` 从 389 行降到 283 行。
- **会话地图图层只有一个视图**：`render()` 不再按 `state.mode` 分叉（那个 mode 变量本身也删了），相机/卡片是唯一的渲染路径；已经没有任何 `.message-*` DOM，也没有 `show-thread` / `show-canvas` 这两个动作。
- **会话地图图层内部未国际化**：标签名会跟随宿主中/英，会话地图内部文案暂为中文。
- 位置存 localStorage，多浏览器 / 清缓存会丢视觉布局（不影响真实状态）。
- 智能体画布图层硬依赖 agent-teams 已安装并起过团队；无团队时为空态。
- 会话地图图层的 `workspaces.json` 只支持单实例写入（有跨进程锁 + 警告，双开仍可能互相覆盖）。
- **画布引擎有两份拷贝**：`app.js` 与 `map.js` 各自带一套相机/缩放/平移/视口裁剪/bezier/位置持久化（`app.js` 当年就是从 `dsh-synapse` 复制魔改的，`map.js` 也是那套）。所以两边很容易漂——本轮统一的是**外观**与**入口**（一个标签、两个图层），引擎本身还没合并。要合并数据层是更后面的事：会话地图的节点身份是 DSH 会话（持久），智能体画布的节点是 agent-teams 的 team/member/task（**临时**，团队归档或宿主重启即消失，只靠 1s 轮询 `/state`，没有自己的存储），硬并成一张图就得选一套身份体系。可行的终局是「成员会话出现在会话树里该在的位置」，agent 画布退化成会话地图的一个图层。

## 许可证

MIT © 2026 rootkiller6788 —— 见 [LICENSE](LICENSE)。
