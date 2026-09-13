# dsh-flow

给 DeepSeek Harness 加一个**智能体画布**标签：一张无限画布，把「会话轮次」和「智能体团队」画在同一张图上——会话按 fork 关系连成分支树，团队展开成「队长 → 成员 → 任务 DAG」的簇，成员消息以带方向的气泡流呈现在检查器里。

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

启动后，对话区顶部的标签行会多出一个「智能体画布」标签；也可以直接打开 `/dsh-flow/`。

### 依赖

| 画布内容 | 依赖 |
| --- | --- |
| 会话分支树 | 无额外依赖，直接用宿主会话 |
| 团队簇（成员 / 任务 DAG） | 需安装并启用 [`@nanmicoder/dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams)，且至少拉起过一个团队；未安装时该区域为空，不影响会话层 |

## 画布上有什么

画布是**一个页面、一个引擎、一张图**，节点分两类：

| 节点 | 画的是什么 | 数据源 |
| --- | --- | --- |
| **会话轮次卡** | 一轮对话（提问 + 回答），按 DSH 原生 fork 关系连成分支树，可追问 / 分支 / 归档；成员中继与子代理通知等**智能体事件轮**以派生标签呈现（`论文手 → 队长`），不暴露协议原文 | 宿主 `sessions` + `workspaces` 服务，投影落盘到 `flow/workspaces.json` |
| **团队泳道带** | 从所属会话的时间轴上长出来的一条区域：头部（名称/状态/进度）挂在最新轮正下方，成员**泳道**贯穿整个时间段，任务 chip 按依赖深度排在各自成员的泳道上（层级 + 先后）；成员发言轮沿时间轴垂直落一条刻度到对应泳道——层级和时间轮次同读一张图 | 团队经 `captainSessionId` 关联到 DSH 会话；前端 1s 轮询 agent-teams 的 `/state`，团队数据不落盘 |

缩放到 **55%** 以下时团队簇折叠成一张摘要卡；会话树不受影响。

### 多智能体对话

点开一张轮次卡，检查器里是**参与者气泡流**，不是一段文本：用户消息、「我」气泡、成员中继消息（头像 + 发送者 → 接收者方向）各自成块，工具调用折叠在过程记录里。

agent-teams 会把成员消息以 `Agent <uuid> sent a message:【发送者 → 接收者】正文` 的信封中继进宿主会话。本插件在**投影层就把信封拆成结构**（`message.agent`），渲染层再对旧数据做同规则的兜底解析——UUID 和英文信封不会出现在画布上。

## 用起来

- **拖拽与记忆**：卡片可拖动，会话卡坐标存浏览器 `localStorage`，只作视觉元数据——节点身份始终是真身（DSH 会话 / teamId / 成员名），位置永远不确定身份。「重置」回到自动布局。
- **检查器**：点卡片（非按钮区域）打开右侧检查器，同时把 DSH 的当前会话切到它——不离开画布。`Esc` 关闭。
- **追问 / 分支**：检查器底部与卡片角标会在画布上开一张草稿卡，输入发生在画布上——这是唯一的写入口；快捷词可增删（最多 12 个，单个 16 字）。
- **DSH 按钮**：切回宿主「对话」标签并锚定到那一轮；看完整过程记录在原生对话里做。
- **归档**：卡片上的归档按钮把会话移出画布（记入 `hiddenSessionIds`），DSH 的列表刷新不会把它重建回来。
- **主题跟随**：浅 / 深色跟随宿主（`theme/change` 事件 → `data-theme`），深色由同一套设计 token 驱动。
- 滚轮在卡片上滚动该卡自己的回答，在空白处缩放画布。

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
├── index.js            # 宿主侧：WorkspaceStore + 会话事件投影 + 中继信封解析 + 路由
├── client.js           # 客户端：一个 conversation.view 标签（内嵌一个 iframe）+ 主题跟随 + 会话动作中继
├── engine.js           # 画布引擎：相机 / 手势 / 视口裁剪 / 连线几何 / 拖拽绑定（与业务无关，可复用）
├── theme.css           # 设计 token（浅/深一套变量）+ 全部组件样式
├── src/                # 统一画布页面（ES 模块）
│   ├── canvas.js       #   入口：宿主桥、实时回复、轮询、启动
│   ├── core.js         #   共享状态、几何常量、localStorage、宿主桥接、成员配色
│   ├── markdown.js     #   Markdown 渲染（含 ■ 分节规范化）
│   ├── relay.js        #   智能体信封解析（中继/成员消息/子代理通知）
│   ├── session.js      #   会话投影数据层 + 轮次卡 + 分支图布局
│   ├── teams.js        #   团队轮询 + 层级区域布局（团队 ⊃ 成员子区域）
│   ├── scene.js        #   场景装配：需求时间轴 + 嵌套区域 + 类型化连线
│   ├── view.js         #   相机、虚拟化挂载、节点渲染、检查器、主渲染
│   └── actions.js      #   交互：草稿 / 追问 / 分支 / 归档 / 快捷词 / 选择追问
├── cordis.patch.yml    # 插入 dsh-flow 服务
└── package.json        # dsh.bundle.patch + dsh.client.inject
```

### 两条数据通路

- **会话层**：宿主侧 `WorkspaceStore` + 会话事件投影。投影由 `session/created` 与 `session/event` 驱动，**与画布是否打开无关地一直在跑**；写入去抖（800ms 全量落盘），带跨进程文件锁与外部修改告警。画布以 1s 轮询 `/dsh-flow/map-api/*` 拉最新投影；与宿主会话列表的对齐（`/map-api/sessions/sync`）由客户端在 iframe `load` 时推一次。
- **团队层**：纯前端 1s 轮询 agent-teams 的 `/state`，宿主侧不存团队数据。

### 主题

画布跟随宿主的**深 / 浅色**（`ctx.theme.getTheme().active.colorScheme` 取初值 + `theme/change` 跟随）。画布内部文案为中文，标签名跟随宿主中 / 英。

## 参考

### HTTP 路由

全部经 `Host` 校验（`localhost` / `127.0.0.1` 默认放行）。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-flow` | 302 → `/dsh-flow/` |
| GET | `/dsh-flow/` | 统一画布页 |
| GET | `/dsh-flow/engine.js` · `/dsh-flow/canvas.js` · `/dsh-flow/theme.css` | 画布资源 |
| GET | `/dsh-flow/map` · `/dsh-flow/map/` | 302 → `/dsh-flow/`（旧路径兼容） |
| * | `/dsh-flow/map-api/*` | 见下表 |

### 画布 API

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
| 画布 → 宿主 | `flow:request-current` | — | 回送当前工作区与会话 |
| 画布 → 宿主 | `flow:open-session` | `sessionId, seq?` | `sessions.open()` + 切回「对话」标签 + 按 `seq` 锚定滚动 |
| 画布 → 宿主 | `flow:activate-session` | `sessionId` | `sessions.open()`，不离开画布 |
| 画布 → 宿主 | `flow:fork-session` | `sessionId, atSeq?, requestId` | `sessions.fork()` |
| 画布 → 宿主 | `flow:send-message` | `sessionId, text, requestId` | `session.prompt(text, 'queue')` |
| 画布 → 宿主 | `flow:create-session` | `workspaceId?, cwd?, requestId` | `sessions.create()` |
| 宿主 → 画布 | `flow:theme` · `flow:locale` | `dark` / `locale` | 主题与语言跟随 |
| 宿主 → 画布 | `flow:workspaces` · `flow:current-session` | 工作区 / 当前会话 | 画布的输入 |
| 宿主 → 画布 | `flow:live-reply` | `sessionId, running, text` | 正在生成时的实时回复 |
| 宿主 → 画布 | `flow:forked-session` · `flow:created-session` · `flow:message-sent` · `flow:bridge-error` | `requestId, …` | 结算画布发起的 RPC |

带 `requestId` 的调用由画布侧 `dshRpc()` 等待，超时 20s；直接在浏览器里打开画布页（不在 DSH 里）时立即拒绝。

### 本地存储

| 位置 | 内容 |
| --- | --- |
| `<DSH home>/flow/workspaces.json`（+ `.lock`） | 工作区 / 节点 / 投影消息；**只支持单实例写入** |
| `dsh-flow:map-card-positions:v3` | 会话卡坐标（与旧版画布兼容） |
| `dsh-flow:cluster-positions:v1` | 团队簇卡片坐标 |
| `dsh-flow:map-collapsed-cards:v1` | 折叠状态 |
| `dsh-flow:map-quick-phrases:v1` | 快捷词 |
| `dsh-flow:map-branch-anchors` | 分支锚点 |

浏览器侧存的**全是视觉元数据**，会话真身始终在 DSH——清缓存只丢布局，不影响状态。

## 设计取舍

**一张画布，不是一个标签里塞两个图层。** 会话与团队本来就是同一次工作的两个视角：团队由会话拉起，任务在会话里汇报。拆成两个页面只会让两边各养一套引擎、各长一套外观，最后对不上。现在引擎（`engine.js`）只管相机、手势、裁剪和连线，与业务无关；会话与团队都是它上面的节点和边。

**中继消息在投影层结构化。** 信封解析放在宿主侧 `index.js` 而不是渲染层，因为落盘的就是脏数据，晚洗不如早洗；渲染层只对存量旧数据做同规则兜底。

**写操作收口到草稿卡。** 画布上的追问 / 分支 / 新建会话都走草稿卡这一个入口，其余动作（切会话、锚定、归档之外的一切）仍由宿主原生对话完成——画布不做第二个 composer。

**团队簇不落盘。** 团队是临时实体（归档或宿主重启即消失），只有它的**位置**值得记住，身份始终由 agent-teams 的 `/state` 决定。

**隐藏邻居插件的悬浮 UI。** agent-teams 会往对话列注入自己的徽标与活动面板；在画布视图上它们会盖住画布控件。插件侧用其 CSS-module 命名空间前缀做 scoped 隐藏，只在本插件视图生效，原生对话里不碰它。

## 开发

```sh
node --check index.js && node --check client.js \
  && node --check engine.js && node --check canvas.js

dsh web
# 对话区顶部标签行点「智能体画布」
```

改动 `client.js` 后**必须重启宿主**：客户端 bundle 有 `rev` 哈希，重启才会重新打包。`engine.js` / `canvas.js` / `theme.css` 是每次请求现读（`cache-control: no-store`），改完刷新页面即可。

## 已知边界

- **团队簇硬依赖 agent-teams**：未安装或没起过团队时该区域为空，会话层不受影响。
- **团队与会话之间没有连线**：agent-teams 的 `/state` 不暴露团队由哪个会话拉起，两侧只能在同一张画布上并列，暂时连不起来。
- **`workspaces.json` 只支持单实例写入**：有跨进程锁与告警，双开仍可能互相覆盖。
- **画布内部文案未国际化**：标签名会跟随宿主中/英，画布内部文案暂为中文。
- **画布页不带导航 chrome**：入口只有宿主标签行。标签只在**有会话**时出现（宿主对空白会话整个返回 null）。若宿主 `slots` 服务缺失，标签不会注册，此时只能用直链。
- **没有测试**：仓库里没有测试目录。

## 许可证

MIT © 2026 rootkiller6788 —— 见 [LICENSE](LICENSE)。
