# dsh-flow

给 DeepSeek Harness 加一个**智能体画布**标签。标签里是一张无限画布，画布里有**两个可互换的图层**：一层看**团队**（agent-teams 的成员与任务依赖 DAG），一层看**会话**（对话轮次构成的非线性工作区）。

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.19.0-3c873a?style=flat-square" alt="Node.js >= 22.19.0">
  <img src="https://img.shields.io/badge/DSH-web%20profile-5B4CF0?style=flat-square" alt="DSH web profile">
</p>

## 快速开始

需要支持 profile 插件机制的 DeepSeek Harness、Node.js `>= 22.19.0`，以及 `web` profile。

```sh
dsh plugin --profile web add github:rootkiller6788/dsh-flow
dsh web
```

> 本插件**未发布到 npm**：`dsh-flow` 这个名字在 registry 上属于另一个项目，请不要用 `dsh plugin add dsh-flow`。

启动后，对话区顶部的标签行会多出一个标签，点进去即可：

```
[ 对话 ]   [ 轨迹 ]   [ 智能体画布 ]
```

也可以直接打开 `/dsh-flow/`（团队图层）或 `/dsh-flow/map/`（会话地图图层）。

### 依赖

| 图层 | 依赖 |
| --- | --- |
| **智能体画布** | 必须已安装并启用 [`@nanmicoder/dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams)，且至少拉起过一个团队，否则该层为空态 |
| **会话地图** | 无额外依赖，直接用宿主会话 |

## 两张画布

两个图层在**同一个标签、同一个 iframe**里，由画布控制行最左边的 **转换** 按钮换层：

```
[ 转换 ]  [ 重置 ]  [ − ]  [ 100% ]  [ ＋ ]
```

两层的控制行逐字相同，所以往哪边切都行。**默认停在「智能体画布」图层**——标签叫什么就先给什么。

| 图层 | 路由 | 画的是什么 | 数据源 |
| --- | --- | --- | --- |
| **智能体画布** | `/dsh-flow/` | 多 agent 团队：外层是**成员**，放大到阈值后展开成**任务依赖 DAG**（两层语义缩放） | 只读轮询 agent-teams 的 `GET /plugins/dsh-agent-teams/state` |
| **会话地图** | `/dsh-flow/map/` | 对话轮次构成的**非线性工作区**（父/子分支树），可分支 / 继续 / 发消息 | 宿主 `sessions` + `workspaces` 服务，落盘到 `flow/workspaces.json` |

标签选择由宿主**按会话持久化**（`dsh.conversation.<sessionId>`），存着的 id 找不到时会回落到「对话」——所以插件卸载不会把某个会话困在空白页里。画布页自身不画任何导航：没有「回到对话」按钮，也没有内嵌切换条。

## 用起来

### 智能体画布图层

- **语义缩放**：缩放倍率低于 `1.5` 只渲染 team + member；跨过阈值展开 task 节点与依赖边。边由 `task.dependencies` 现算，不落盘。
- **拖拽与记忆**：卡片可拖动，坐标存在浏览器 `localStorage`，只作视觉元数据——节点身份始终是真身（`teamId` / member name / task id），位置永远不确定身份。
- **只读**：不发起 halt / plan / edit，写操作仍在原生对话里由 AgentTeams 工具完成。

### 会话地图图层

- 一张卡片 = 一轮对话（提问 + 回答），分支按 DSH 原生 fork 关系连成树。
- **点卡片**（非按钮区域）打开右侧**检查器**：只读展开这一轮的提问/回答/工具调用，同时把 DSH 的当前会话切到它——不离开画布。
- **追问 / 分支**：检查器底部与卡片上的 `＋` / 分支按钮会在画布上开一张草稿卡，输入仍发生在画布上——**这是地图唯一的写入口**。
- **DSH 按钮 / 详情标题**：走同一个动作 `flow:open-session`，即切回宿主「对话」标签并锚定到那一轮。想继续追问、看完整过程记录、创建分支，都在原生对话里做。
- **归档**：卡片上的归档按钮把会话移出画布（记入 `hiddenSessionIds`），之后 DSH 的列表刷新不会把它重建回来。
- **折叠 / 快捷词**：有后续对话的卡片可折叠；草稿卡上的常用补充词可增删（最多 12 个，单个最多 16 字）。
- **工作区自动跟随**：在 DSH 原生界面换工作区，画布跟着换，不需要再选一次。
- 滚轮在卡片上滚动该卡自己的回答，在空白处缩放画布；`Esc` 关闭检查器。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖本插件的 config：

```yaml
- insert:
    - id: dsh-flow
      name: dsh-flow
      config:
        dataFile: !!js dshHomePath('flow/workspaces.json')
        autoProjection: true
        projectionWorkspaceTitle: DSH 任务
        trustedHosts: []
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataFile` | `dshHomePath('flow/workspaces.json')` | 画布图的持久化路径，**必填** |
| `autoProjection` | `true` | 是否自动把 DSH 会话投影到画布（监听 `session/created` 与 `session/event`） |
| `projectionWorkspaceTitle` | `DSH 任务` | 无法从 cwd 推出工作区名时的回退标题 |
| `trustedHosts` | `[]` | 额外放行的 Host 头（`localhost` 与 `127.0.0.1` 始终放行） |

`/dsh-flow` 路由不在 DSH `/api` 的浏览器信任围栏内，所以插件自己校验 `Host` 头以防 DNS rebinding；换非本机地址访问时把主机名加进 `trustedHosts`。

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

`client.js` 对 slot 只注册**一条**条目（`conversation.view`、`order: 20`），宿主把 `slots.entries('conversation.view')` 直接投影成标签行（按 `order` 升序，宿主自己是 `chat`=0 / `trajectory`=10）。

### 一个标签、两个图层

```js
const LAYERS = {
  team:    { src: '/dsh-flow/',     label: 'view.canvas' },   // 默认层，标签名就是它
  session: { src: '/dsh-flow/map/', label: 'view.map' },
}
let layer = 'team'   // 模块级状态，不是 React state：宿主只渲染激活 View，
                     // 切走/切回会卸载重挂，层级不该跟着丢
```

标签体是**一个 iframe**，除此之外什么都不渲染。iframe 在挂载时创建、卸载时移除；一旦离开文档，它的浏览上下文就销毁了——所以切走再切回来必然是一次重新加载，回来后落在**你离开时的那一层**。

**换层**靠给活着的 iframe 赋 `src`（即一次导航），换层前先给容器加 `is-opening` 藏住旧层像素，避免深色模式下闪一帧白页。一个 frame 扛两层，所以「这条消息发给谁」只能由 `layer` 判断：会话地图的推送统一走 `sendSession(...)`，只在 `layer === 'session'` 时发出；主题则**谁在屏幕上就发给谁**。

### 两条数据通路

- **智能体画布图层**：纯前端，1s 轮询 agent-teams 的 `/state`。宿主侧只 serve 静态文件，**无状态**。
- **会话地图图层**：宿主侧 `WorkspaceStore` + 会话事件投影。投影由 `session/created` 与 `session/event` 驱动，**与图层无关地一直在跑**，所以即使没打开过画布，会话也已经在图里了。写入去抖（800ms 一次全量落盘，避免每个事件一次写盘把主线程打满），并带跨进程文件锁与外部修改告警。
  - 画布与宿主**会话列表**的对齐（`/map-api/sessions/sync`）走的是另一条路：由客户端在 iframe `load` 时推一次，而不是持续轮询。换到会话地图层本身就是一次导航，所以每次 转换 过去都会先对齐一遍。地图层自己另外以 1s 轮询 `/map-api/projection` 拉最新的投影。

### 主题与语言

两个图层都跟随宿主，并且走**宿主自己的服务**、不做 DOM 嗅探，所以 `system` 偏好会被解析成真实的浅/深色，区域化语言 id（`zh-CN`）也能正确归到中文：

- 深色：`ctx.theme.getTheme().active.colorScheme` 取初值 + `ctx.on('theme/change')` 跟随 → `postMessage('flow:theme')` → iframe 设 `data-theme="dark"`，CSS 变量切换。
- 语言：`ctx.locale.getSnapshot().active` 取初值 + `ctx.locale.subscribe()` 跟随 → 标签文案用 `ctx.locale.bind(NS)` 在注册时取（thunk，换语言不用重新注册）。

## 参考

### HTTP 路由

全部经 `Host` 校验（`localhost` / `127.0.0.1` 默认放行）。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-flow` | 302 → `/dsh-flow/` |
| GET | `/dsh-flow/` | 智能体画布页 |
| GET | `/dsh-flow/app.js` · `/dsh-flow/styles.css` | 智能体画布资源 |
| GET | `/dsh-flow/map` | 302 → `/dsh-flow/map/` |
| GET | `/dsh-flow/map/` | 会话地图页 |
| GET | `/dsh-flow/map.js` · `/dsh-flow/map.css` | 会话地图资源 |
| * | `/dsh-flow/map-api/*` | 见下表 |

### 会话地图 API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/map-api/reset` | 清空所有工作区，并隐藏当前全部 DSH 会话 |
| GET | `/map-api/workspaces` | 工作区摘要列表 |
| POST | `/map-api/workspaces` | 新建工作区 `{ title }` |
| GET | `/map-api/workspaces/:id` | 完整工作区（含 threads / messages） |
| POST | `/map-api/workspaces/:id` | 在工作区内新建节点 `{ title, parentId?, dshSessionId?, position?, color? }` |
| POST | `/map-api/threads/:id/branch` | 从节点分叉 `{ title?, dshSessionId?, position?, color? }` |
| POST | `/map-api/threads/:id/messages` | 追加一条消息 `{ text }` |
| PATCH | `/map-api/threads/:id` | 改 `title` / `position` |
| DELETE | `/map-api/threads/:id` | 删除节点**及其全部后代**，并隐藏对应 DSH 会话 |
| POST | `/map-api/sessions/sync` | 用宿主会话列表对齐画布 `{ sessions, removedSessionIds }` |

### postMessage 协议

画布页与宿主客户端之间只认 `{ source: 'dsh-flow', type, ...payload }`，且校验 origin 与 `event.source` 必须是本插件挂载的那个 frame。

| 方向 | 消息 | 载荷 | 行为 |
| --- | --- | --- | --- |
| 画布 → 宿主 | `flow:switch-layer` | — | 翻转 `layer` 并给 iframe 重赋 `src` |
| 画布 → 宿主 | `flow:request-current` | — | 回送当前工作区与会话（仅会话地图层） |
| 画布 → 宿主 | `flow:open-session` | `sessionId, seq?` | `sessions.open()` + 切回「对话」标签 + 按 `seq` 锚定滚动 |
| 画布 → 宿主 | `flow:activate-session` | `sessionId` | `sessions.open()`，不离开画布 |
| 画布 → 宿主 | `flow:fork-session` | `sessionId, atSeq?, requestId` | `sessions.fork()` |
| 画布 → 宿主 | `flow:send-message` | `sessionId, text, requestId` | `session.prompt(text, 'queue')` |
| 画布 → 宿主 | `flow:create-session` | `workspaceId?, cwd?, requestId` | `sessions.create()` |
| 宿主 → 画布 | `flow:theme` · `flow:locale` | `dark` / `locale` | 主题与语言跟随 |
| 宿主 → 画布 | `flow:workspaces` · `flow:current-session` | 工作区 / 当前会话 | 会话地图的输入 |
| 宿主 → 画布 | `flow:live-reply` | `sessionId, running, text` | 正在生成时的实时回复 |
| 宿主 → 画布 | `flow:map-opened` | — | 会话地图装载后重绘。**不重置相机**：同一会话来回换层要留住视口 |
| 宿主 → 画布 | `flow:forked-session` · `flow:created-session` · `flow:message-sent` · `flow:bridge-error` | `requestId, …` | 结算画布发起的 RPC |

带 `requestId` 的调用由画布侧 `dshRpc()` 等待，超时 20s；直接在浏览器里打开画布页（不在 DSH 里）时立即拒绝。

### 本地存储

| 位置 | 内容 |
| --- | --- |
| `<DSH home>/flow/workspaces.json`（+ `.lock`） | 工作区 / 节点 / 投影消息；**只支持单实例写入** |
| `dsh-flow:positions:v1` | 智能体画布卡片坐标 |
| `dsh-flow:map-card-positions:v3` | 会话地图卡片坐标 |
| `dsh-flow:map-collapsed-cards:v1` | 折叠状态 |
| `dsh-flow:map-quick-phrases:v1` | 快捷词 |
| `dsh-flow:map-branch-anchors` | 分支锚点 |

浏览器侧存的**全是视觉元数据**，会话真身始终在 DSH——清缓存只丢布局，不影响状态。

## 设计取舍

**为什么是一个标签两个图层，而不是两个标签。** 早先这两层是平级标签（`flow` / `flow-map`）。宿主只渲染当前激活的 View（`renderSlot(..., { only: active.id })`），所以两个标签必然是**两个文档、两套引擎**，标签行把一个画布读成了两个功能。现在合成一个：两套引擎仍是各自独立的文档（没有合并、没有重写），只是不再各占一个标签。**代价**：`src` 变更就是一次导航，所以每次 转换 都是一次重新加载（和过去切标签同价）。这是保留两套引擎的诚实成本。

**画布不画导航，也不画品牌。** 换标签和回对话是宿主标签行的职责；图层之间的切换是画布控制行的职责。页面上不出现插件名——**画布叫什么只由宿主标签行决定，当前在哪一层只由控制行的 转换 决定**。

**会话地图没有自己的侧边栏。** 会话列表、切换会话、新建会话、工作区选择器宿主全都有，画布只画图，多一条侧边栏只会和宿主那条打架。相应地「新建会话」只在**空画布**时出现一次（画布中央那个大按钮），一旦画布上有卡片就交给宿主。

**隐藏宿主的原生 composer。** 宿主在「对话」标签底部常驻一个会话级 composer（`conversation.composer` slot），切到画布时它仍显示在 iframe 下方。插件利用「宿主只渲染激活视图」这一点，在 iframe 一挂载就往 `<body>` 加 `dsh-flow-view-active` 类，用 scoped CSS 隐藏它，切回对话/轨迹即还原：

- 隐藏的是**整条** composer，不是那张输入框——`[data-composer-seat]` 里装着宿主拼出来的整条 slot 链（对话编辑器、`user-questions` 追问面板、`subagent` 只读 composer、附件区），所以它们都不会再冒到画布上。宿主另一形态（`[data-conversation-composer-overlay]`）也有同样的规则兜住。
- 同一条规则还负责**列宽拖拽手柄**：宿主把两个 `[data-width-handle]` 一直摆在对话列两侧（`position:absolute; top:0; bottom:0; cursor:col-resize`），只隐藏输入框的话它们会横在画布左右边缘上——在画布里拖一下，改的是宿主对话列的宽度。宿主自己遇到 overlay 形态的 composer 时也会隐藏它们，这里用的是同一招，只是换成本插件挂载的判据。
- 挂载用 **`useLayoutEffect`** 而不是 `useEffect`：被动 effect 跑在宿主**已经画完一帧之后**，每次切进画布原生输入框都会先亮一帧。实测（无头 Chromium 按帧采样，`对话 → 智能体画布`）切过去后 **541 帧里 0 帧**画出原生输入框，第一帧就已经是隐藏态。

**两个图层共用一套外观规格。** 会话地图的顶栏与控制行是照着智能体画布抄的——同样的 44px 顶栏、下边框、按钮高度/内距/字号/圆角、46px 定宽的比例标签，以及同一套背景色（浅色 `#f5f7fa` 画布 + `#fff` 面板，深色 `#151517` 画布 + `#1b1b1c` 面板）。

## 开发

```sh
node --check index.js && node --check client.js \
  && node --check app.js && node --check map.js

dsh web
# 对话区顶部标签行点「智能体画布」，再用控制行最左边的「转换」换层
```

改动 `client.js` 后**必须重启宿主**：客户端 bundle 有 `rev` 哈希，重启才会重新打包。`app.js` / `map.js` / CSS 是每次请求现读（`cache-control: no-store`），改完刷新页面即可。

## 已知边界

- **转换 = 一次重载**：宿主一次只渲染当前 View，iframe 换 `src` 就是导航，旧层的浏览上下文销毁。会话地图的 JS 有 100KB+，每次换到它都有一次重载代价。
- **画布引擎有两份拷贝**：`app.js` 与 `map.js` 各自带一套相机/缩放/平移/视口裁剪/bezier/位置持久化（`app.js` 当年就是从 `dsh-synapse` 复制魔改的，`map.js` 也是那套），所以两边很容易漂。已统一的是**外观**与**入口**，引擎本身还没合并。要合并数据层是更后面的事：会话地图的节点身份是 DSH 会话（持久），智能体画布的节点是 agent-teams 的 team/member/task（**临时**，团队归档或宿主重启即消失，只靠 1s 轮询 `/state`，没有自己的存储），硬并成一张图就得选一套身份体系。
- **样式值也是两份**：`styles.css` 与 `map.css` 各有一份顶栏/控制行的数值，去重要把相机层抽成共用模块。
- **会话地图图层内部未国际化**：标签名会跟随宿主中/英，地图内部文案暂为中文。
- **画布页不带导航 chrome**：入口只有宿主标签行。标签只在**有会话**时出现（宿主对空白会话整个返回 null）。若宿主 `slots` 服务缺失，标签不会注册，此时只能用直链。
- **智能体画布图层硬依赖 agent-teams**：未安装或没起过团队时为空态。
- **`workspaces.json` 只支持单实例写入**：有跨进程锁与告警，双开仍可能互相覆盖。
- **已知的邻居**（不是本插件的东西，也不归本插件管）：`@nanmicoder/dsh-agent-teams` 有一颗悬浮徽标（`.aYQbCq_badge{position:absolute;top:64px;right:18px}`），在原生「对话」里浮在空白处，到画布页正好压住控制行最右边的 **＋**（重叠约 11px）。要处理的话得在插件侧为它加一条 scoped 规则，或反馈给上游。
- **没有测试**：仓库里没有测试目录。

## 许可证

MIT © 2026 rootkiller6788 —— 见 [LICENSE](LICENSE)。
