# dsh-flow

给 DeepSeek Harness 加一个**统一智能体画布**标签：会话时间轴与多智能体团队层级编排同处一图——用户需求轮在主时间轴，团队作为嵌套区域长在其下，每个成员一个子区域，装着ta的任务与发言卡；成员立绘、按说话者编织的对话链、任务依赖 DAG 一眼可读。

![智能体画布：需求时间轴 + 团队层级编排 + 立绘检查器](assets/1.png)

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.19.0-3c873a?style=flat-square" alt="Node.js >= 22.19.0">
  <img src="https://img.shields.io/badge/DSH-web%20profile-5B4CF0?style=flat-square" alt="DSH web profile">
</p>

## 一句话

**需求 → 拉起智能体团队 → 画布自动生成这张图**：对话按说话者分层编排，任务按依赖连线，数据存在 dsh-flow 自己的存储里。

## 快速开始

需要支持 profile 插件机制的 DeepSeek Harness、Node.js `>= 22.19.0`，以及 `web` profile。

```sh
dsh plugin --profile web add github:rootkiller6788/dsh-flow
dsh web
```

> 本插件**未发布到 npm**：`dsh-flow` 这个名字在 registry 上属于另一个项目，请不要用 `dsh plugin add dsh-flow`。

启动后，对话区顶部的标签行会多出一个「智能体画布」标签；也可以直接打开 `/dsh-flow/`。

## 画布上有什么

一个页面、一个引擎、一张图。节点分两类：

| 节点 | 画的是什么 | 数据源 |
| --- | --- | --- |
| **会话轮次卡** | 一轮对话（提问 + 回答），按 DSH 原生 fork 关系连成分支树，可追问 / 分支 / 归档；成员中继与子代理通知等**智能体事件轮**以派生标签呈现（`论文手 → 队长`），不暴露协议原文 | 宿主 `sessions` + `workspaces` 服务，投影落盘到 `flow/workspaces.json` |
| **团队层级区域** | 团队标题条下嵌套**成员子区域**：每个成员一格，装着ta的任务 chip（按依赖深度连线）与发言卡（按时间排布）。指派关系由包含表达，依赖用箭头，对话流向由跨区域的轮次链表达 | 团队数据**存放在 dsh-flow 自己的存储**（`flow/teams.json` 快照）；安装了 agent-teams 时自动跟随其实时状态并刷新快照 |

### 多智能体对话

点开一张轮次卡，检查器里是**参与者气泡流**：用户消息、成员中继消息（立绘头像 + `发送者 → 接收者` 方向）、子代理通知各自成块，工具调用折叠在过程记录里。

agent-teams（或宿主）会把成员消息以 `Agent <uuid> sent a message:【发送者 → 接收者】正文` 之类的信封中继进宿主会话。本插件在**投影层就把信封拆成结构**（`message.agent`），渲染层对旧数据做同规则兜底——UUID 和协议原文不会出现在画布上。

### 团队检查器

点团队标题条或成员子区域，右栏呈现**整体编排**：成员立绘行（头像 + 角色 + 模型 + 进度）、任务依赖列表（状态 chip）、队长收件箱（成员 → 队长的真实消息）。

### 立绘系统

`assets/` 内置 15 张角色/动作图（9 职业 + 6 状态）。成员名与角色关键词自动映射立绘（资料/数据→分析师、建模/科学→科学家、验证/审阅→QA、求解/实现→工程师、论文/写作→研究员、队长→船长……），未匹配回退首字色块。立绘容器背景跟随明暗主题。

## 团队数据的归属

团队结构（成员 / 任务 / 依赖 / 收件箱）**存放在 dsh-flow 自己的存储**：`flow/teams.json` 快照，由画布在拉取成功时自动镜像。渲染优先级：

1. 安装了 agent-teams → 使用其实时状态并刷新快照
2. 未安装 / 离线 → 使用自己的快照渲染（历史冻结）
3. 两者都无 → 纯对话时间轴

对话编织本身来自**对话投影的中继解析**，不依赖任何外部插件。

## 用起来

- **拖拽与记忆**：卡片可拖动，坐标存浏览器 `localStorage`，只作视觉元数据——节点身份始终是真身（DSH 会话 / teamId / 成员名），位置永远不确定身份。「重置」回到自动布局。
- **检查器**：点卡片（非按钮区域）打开右侧检查器，同时把 DSH 的当前会话切到它——不离开画布。`Esc` 关闭。
- **追问 / 分支**：检查器底部与卡片角标会在画布上开一张草稿卡，输入发生在画布上——这是唯一的写入口；快捷词可增删（最多 12 个，单个 16 字）。
- **DSH 按钮**：切回宿主「对话」标签并锚定到那一轮；看完整过程记录在原生对话里做。
- **归档**：卡片上的归档按钮把会话移出画布（记入 `hiddenSessionIds`），DSH 的列表刷新不会把它重建回来。
- **主题**：浅 / 深色跟随宿主（`theme/change` 事件 → `data-theme`），深色由同一套设计 token 驱动；立绘容器背景同步切换。
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
| `dataFile` | `dshHomePath('flow/workspaces.json')` | 画布图与团队快照（`teams.json` 同目录）的持久化路径，**必填** |
| `autoProjection` | `true` | 是否自动把 DSH 会话投影到画布（监听 `session/created` 与 `session/event`） |
| `projectionWorkspaceTitle` | `DSH 任务` | 无法从 cwd 推出工作区名时的回退标题 |
| `trustedHosts` | `[]` | 额外放行的 Host 头（`localhost` 与 `127.0.0.1` 始终放行） |

`/dsh-flow` 路由不在 DSH `/api` 的浏览器信任围栏内，所以插件自己校验 `Host` 头以防 DNS rebinding；换非本机地址访问时把主机名加进 `trustedHosts`。

## 架构

```
dsh-flow (纯 JS，无运行时依赖)
├── index.js            # 宿主侧：WorkspaceStore + 会话事件投影 + 信封解析 + 团队快照存储 + 路由
├── client.js           # 客户端：一个 conversation.view 标签（内嵌一个 iframe）+ 主题跟随 + 会话动作中继
├── engine.js           # 画布引擎：相机 / 手势 / 视口裁剪 / 连线几何 / 拖拽绑定（与业务无关，可复用）
├── theme.css           # 设计 token（浅/深一套变量）+ 全部组件样式
├── assets/             # 15 张立绘（9 职业 + 6 状态）
├── src/                # 统一画布页面（ES 模块）
│   ├── canvas.js       #   入口：宿主桥、实时回复、轮询、启动
│   ├── core.js         #   共享状态、几何常量、localStorage、宿主桥接、成员配色
│   ├── markdown.js     #   Markdown 渲染（含 ■ 分节规范化）
│   ├── relay.js        #   智能体信封解析（中继/成员消息/子代理通知）
│   ├── session.js      #   会话投影数据层 + 轮次卡 + 分支图布局
│   ├── teams.js        #   团队轮询（实时→快照回退）+ 层级区域布局
│   ├── scene.js        #   场景装配：需求时间轴 + 嵌套区域 + 类型化连线
│   ├── view.js         #   相机、虚拟化挂载、节点渲染、检查器、主渲染
│   ├── artwork.js      #   立绘映射（角色关键词 → 职业图，状态 → 动作图）
│   └── actions.js      #   交互：草稿 / 追问 / 分支 / 归档 / 快捷词 / 选择追问
├── cordis.patch.yml    # 插入 dsh-flow 服务
└── package.json        # dsh.bundle.patch + dsh.client.inject
```

## 参考

### HTTP 路由

全部经 `Host` 校验（`localhost` / `127.0.0.1` 默认放行）。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-flow` | 302 → `/dsh-flow/` |
| GET | `/dsh-flow/` | 统一画布页 |
| GET | `/dsh-flow/engine.js` · `/dsh-flow/src/*.js` · `/dsh-flow/theme.css` | 画布资源 |
| GET | `/dsh-flow/assets/*.png` | 立绘图（仅放行 `[a-z0-9-]+.png`） |
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
| GET | `/map-api/teams` | 读取团队快照 `{ teams }`（未落盘时为空数组） |
| POST | `/map-api/teams/snapshot` | 镜像团队状态 `{ teams }`（画布拉取成功时自动调用） |

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
| `<DSH home>/flow/workspaces.json`（+ `.lock`） | 工作区 / 节点 / 投影消息，gzip 压缩存放（明文 JSON 也能读）；**只支持单实例写入** |
| `<DSH home>/flow/teams.json` | 团队快照（成员 / 任务 / 依赖 / 收件箱） |
| `dsh-flow:map-card-positions:v3` | 会话卡坐标（与旧版画布兼容） |
| `dsh-flow:cluster-positions:v1` | 团队区域卡片坐标 |
| `dsh-flow:map-collapsed-cards:v1` | 折叠状态 |
| `dsh-flow:map-quick-phrases:v1` | 快捷词 |
| `dsh-flow:map-branch-anchors` | 分支锚点 |

浏览器侧存的**全是视觉元数据**，会话真身始终在 DSH——清缓存只丢布局，不影响状态。

## 设计取舍

**一张画布，层级化编排。** 会话与团队本来就是同一次工作的两个视角：团队由会话拉起，任务在会话里汇报。拆成两个页面只会让两边各养一套引擎、各长一套外观。现在引擎（`engine.js`）只管相机、手势、裁剪和连线，与业务无关；会话与团队都是它上面的节点和边，团队作为嵌套区域长在需求时间轴之下——层级用包含表达，时间用列表达。

**团队数据存在自己家里。** 团队结构由画布在拉取成功时镜像快照到 `flow/teams.json`：安装着 agent-teams 就跟实时，卸载了就用快照渲染历史。dsh-flow 对外部插件的唯一依赖是它的 state 接口，且可降级。

**中继消息在投影层结构化。** 信封解析放在宿主侧 `index.js` 而不是渲染层，因为落盘的就是脏数据，晚洗不如早洗；渲染层只对存量旧数据做同规则兜底。

**写操作收口到草稿卡。** 画布上的追问 / 分支 / 新建会话都走草稿卡这一个入口，其余动作仍由宿主原生对话完成——画布不做第二个 composer。

**立绘即身份。** 成员名与角色关键词哈希映射到 `assets/` 的职业立绘：画布成员卡、检查器气泡、成员行三处同源，未匹配回退首字色块。容器背景跟随明暗主题。

## 开发

```sh
node --check index.js && node --check client.js \
  && node --check engine.js && for f in src/*.js; do node --check "$f"; done

dsh web
# 对话区顶部标签行点「智能体画布」
```

改动 `client.js` 后**必须重启宿主**：客户端 bundle 有 `rev` 哈希，重启才会重新打包。`engine.js` / `src/*` / `theme.css` 是每次请求现读（`cache-control: no-store`），改完刷新页面即可。

## 已知边界

- **团队数据是快照冻结**：未安装 agent-teams 时，团队区域渲染的是最后一次拉取的快照——不再有新团队 / 新任务出现。装回 agent-teams 后自动恢复实时。
- **团队与会话之间没有连线**：快照不记录团队由哪个会话拉起之外的运行时关系；画布上的对话链来自会话投影本身。
- **`workspaces.json` 只支持单实例写入**：有跨进程锁与告警，双开仍可能互相覆盖。
- **画布内部文案未国际化**：标签名会跟随宿主中/英，画布内部文案暂为中文。
- **画布页不带导航 chrome**：入口只有宿主标签行。标签只在**有会话**时出现（宿主对空白会话整个返回 null）。若宿主 `slots` 服务缺失，标签不会注册，此时只能用直链。
- **没有测试**：仓库里没有测试目录。

## 许可证

MIT © 2026 rootkiller6788 —— 见 [LICENSE](LICENSE)。
