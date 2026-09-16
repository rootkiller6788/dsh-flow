# dsh-flow

[中文](./README.md) · **English**

Adds a **unified agent canvas** tab to DeepSeek Harness: the session timeline and the multi-agent team hierarchy share one figure — the user's requirement turns stay on the main timeline, the team grows below them as a nested region, each member gets a sub-region holding their tasks and speech cards. Character artwork, a dialogue chain woven by speaker, and the task dependency DAG all read at a glance.

![Agent canvas: requirement timeline + team hierarchy + artwork inspector](assets/1.png)

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.19.0-3c873a?style=flat-square" alt="Node.js >= 22.19.0">
  <img src="https://img.shields.io/badge/DSH-web%20profile-5B4CF0?style=flat-square" alt="DSH web profile">
  <img src="https://img.shields.io/badge/runtime%20deps-0-2ea44f?style=flat-square" alt="zero runtime dependencies">
  <img src="https://img.shields.io/badge/build%20step-none-f0ad4e?style=flat-square" alt="no build step">
</p>

## In one line

**A requirement → raise an agent team → the canvas draws this figure**: dialogue is laid out by speaker, tasks are wired by dependency, and the data lives in dsh-flow's own storage.

It **fully replaces [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams)**: the 13 tools map one to one, and 31 differential checks guard that line. But it does not depend on the other plugin — if that plugin is installed it is an optional read-only source, and if it is not, everything still runs. For what differs in use, see the [comparison](#comparison-with-dsh-agent-teams).

## Quick start

You need a DeepSeek Harness that supports the profile plugin mechanism, Node.js `>= 22.19.0`, and the `web` profile.

```sh
dsh plugin --profile web add github:rootkiller6788/dsh-flow
dsh web
```

> This plugin is **not published to npm**: the name `dsh-flow` belongs to another project on the registry, so please do not use `dsh plugin add dsh-flow`.

Once it starts, the tab bar above the conversation area gains an **Agent Canvas** tab; you can also open `/dsh-flow/` directly.

## What is on the canvas

One page, one engine, one figure. Nodes come in two kinds:

| Node | What it draws | Data source |
| --- | --- | --- |
| **Session turn card** | One round of conversation (question + answer), wired into a branch tree by DSH's native fork relation; follow-up / branch / archive from here. **Agent event turns** — member relays, subagent notices — render as a derived label (`论文手 → 队长`), never as raw protocol text | The host's `sessions` + `workspaces` services, projected to disk at `flow/workspaces.json` |
| **Team region** | Under the team's title bar, nested **member sub-regions**: one cell per member, holding their task chips (wired by dependency depth) and speech cards (laid out in time order). Assignment is expressed by containment, dependency by arrows, dialogue flow by the turn chain crossing regions | Team data **lives in dsh-flow's own storage** (`<stateDir>/<teamId>/events.jsonl`); when the deployment has a `.agent-teams/`, it is listed alongside as a **read-only source** |

### Multi-agent dialogue

Open a turn card and the inspector shows a **participant bubble flow**: user messages, member relay messages (artwork avatar + `sender → recipient` direction), and subagent notices each as their own block, with tool calls folded into the process record.

agent-teams (or the host) relays member messages into the host session inside an envelope like `Agent <uuid> sent a message:【sender → recipient】body`. This plugin **splits the envelope into structure at the projection layer** (`message.agent`), and the render layer applies the same rule to older data as a fallback — no UUID and no protocol text ever reaches the canvas.

### Team inspector

Click a team's title bar or a member sub-region and the right pane shows the **whole arrangement**: member artwork rows (avatar + role + model + progress + current activity), the task dependency list (state chips), the captain's mailbox (real member → captain messages), plus three judgement panels:

- **K9 verdict / K10 blockers / K11 coverage matrix** — the same computation the model sees when it calls `flow_status`, so what you read off the canvas cannot drift from what the captain decided on
- **Click a task row** to expand that task's **attempt timeline**: how many times it was tried, how each attempt ended, which one was rolled back (this information exists only at the protocol layer — a monotonic attempt counter cannot say how any single attempt ended)
- **Staged teams** are **editable and approvable right in the inspector**, through the same validation `flow_edit_plan` / `flow_approve` use

When team data contains lines that cannot be read, the team's card grows a `数据损坏 N` badge and the inspector lists each one with its **kind / member / line number / reason** — the line number is the only thing that makes a damaged file fixable. Teams that cannot reach the canvas at all are covered by a deployment-wide count in the toolbar; otherwise they simply would not exist on the canvas.

### Artwork

`assets/` ships 15 character/action images (9 professions + 6 states). Member names and role keywords map to artwork automatically (research/data → analyst, modelling/science → scientist, verify/review → QA, solve/implement → engineer, paper/writing → researcher, captain → captain …), falling back to a colour block with the first character. The artwork container's background follows the light/dark theme.

## Where team data lives

Team structure (members / tasks / dependencies / mailboxes) **lives in dsh-flow's own storage**, one directory per team:

```
<stateDir>/            # defaults to .dsh-flow
└── <teamId>/
    ├── events.jsonl   # the append-only source of truth — everything the team did
    ├── state.json     # a checkpoint: one reading of events.jsonl, discardable and rebuildable
    ├── manifest.json  # metadata such as creation time and the initial goal
    └── mail/          # one .jsonl mailbox per member
```

**The log is the fact; the checkpoint is a cache.** When the two disagree the log wins, and the disagreement is judged an error by `teamDiffEvents` rather than quietly smoothed over — reconciliation **refuses** a difference it cannot express instead of picking a winner. A line that cannot be read never stops parsing, but it does go into the import report (below).

Where teams come from is a **source registry** (`ctx.flowTeamSources`): this deployment's own log is always registered, and when a `.agent-teams/` exists it is listed at the same time as a **read-only source**. During a migration you see both sets, so switching over is one config line rather than a big-bang move (a source whose `canAppend` is false cannot be edited from the canvas).

The dialogue weave itself comes from **relay parsing in the conversation projection** and depends on no external plugin.

## Using it

- **The `/dsh-flow` command**: `/dsh-flow [--profile <name>] <goal>` makes the current session the captain and raises a team. Each profile also gets an alias `/dsh-flow-<name>` (a profile name must be lowercase alphanumeric plus hyphens to be addressable; a name like `bug fix` yields no alias rather than a guessed normalisation). The command **only creates the team and stops at the staged plan** — it never approves in the same turn, because review is the reason staging exists.
- **Dragging and memory**: cards can be dragged; coordinates go to browser `localStorage` as visual metadata only — a node's identity is always the real thing (DSH session / teamId / member name), and position never determines identity. "Reset" returns to automatic layout.
- **Inspector**: click a card (not on a button) to open the right inspector, which also switches the current DSH session to it — without leaving the canvas. `Esc` closes.
- **Follow-up / branch**: the inspector footer and a card corner open a draft card on the canvas; typing happens on the canvas, which is the only write entry point. Quick phrases are editable (up to 12, 16 characters each).
- **DSH button**: switches back to the host's Chat tab and anchors to that turn; the full process record is read in the native conversation.
- **Archive**: the archive button on a card moves the session off the canvas (recorded in `hiddenSessionIds`); a DSH list refresh will not rebuild it.
- **Theme**: light / dark follows the host (`theme/change` event → `data-theme`), dark is driven by the same design tokens, and the artwork container background switches with it.
- The wheel scrolls a card's own answer over a card, and zooms the canvas over empty space.

## Configuration

Override this plugin's config in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-flow
      name: dsh-flow
      config:
        dataFile: !!js dshHomePath('flow/workspaces.json')
        autoProjection: true
        projectionWorkspaceTitle: DSH 任务
        trustedHosts: []

        stateDir: .dsh-flow        # where teams live
        runner: subagents          # manual | subagents (fixed at composition time)
        memberProvider: spawn
        maxMembers: 8
        # agentTeamsStateDir: .agent-teams   # open this only while migrating
        # profiles: {...}                     # see below
```

| Key | Default | Meaning |
| --- | --- | --- |
| `dataFile` | `dshHomePath('flow/workspaces.json')` | Persistence path for the canvas figure. **Required** |
| `autoProjection` | `true` | Whether to project DSH sessions onto the canvas automatically (listens to `session/created` and `session/event`) |
| `projectionWorkspaceTitle` | `DSH 任务` | Fallback title when no workspace name can be derived from the cwd |
| `trustedHosts` | `[]` | Extra authorities the `Host` check accepts (`localhost` and `127.0.0.1` are always allowed) |
| `stateDir` | `.dsh-flow` | Root of the team logs and mailboxes; a relative path resolves against the session working directory, which keeps two deployments' teams out of each other |
| `runner` | `subagents` | **A composition-time choice**: `subagents` is the real kernel, `manual` means "you can look and edit, nothing executes" |
| `memberProvider` | `spawn` | Which subagent provider members are started with |
| `agentTeamsStateDir` | none | When given, registers that `.agent-teams` directory as a **read-only source**; during a migration both sets of teams are visible while the `flow_*` tools keep acting on ours |
| `maxMembers` | — | Member cap for profile rosters and for the teams they produce |
| `profiles` | none | The team profile table: a named roster + seed tasks + a review policy |

`profiles` is **deployment configuration rather than protocol** — which teams a deployment offers is its own business, so it lives in config and not in code. A profile's `taskPlanning` has exactly two values: `seed` (the tasks below define the whole graph) or `captain` (the roster is given, the graph is the captain's to design). The `role` / `reasoning_effort` given in a roster decide the members' default routes.

The `/dsh-flow` routes are not inside DSH `/api`'s browser trust fence, so the plugin checks the `Host` header itself against DNS rebinding; to reach it from a non-local address, add the hostname to `trustedHosts`.

## Architecture

One package, zero runtime dependencies, no build. **The source is the artifact**: `files` lists `.js`, not `lib/` — clone it and it runs, with no "compile first" step.

The host's design philosophy is everything is a plugin, and it classifies services as `core` / `seam` / `bundle`. dsh-flow divides itself the same way: **one pure core, two seams, one composition root**.

### The three services

| Service | Class | Form | Why it has to be that form |
| --- | --- | --- | --- |
| `ctx.flowTeams` | core | single instance | This deployment has exactly one team record, and other plugins consume it |
| `ctx.flowTeamSources` | seam | **registry** | The implementations really do coexist: during a migration, native teams and `.agent-teams` teams must both be visible |
| `ctx.flowRunner` | seam | **one of two, chosen at composition time** | Two instances would fight: two schedulers would claim the same task |

One name can have only one provider (a second `ctx.provide` under the same name throws), so the distinction above is not a style choice but a hard constraint — what coexists becomes a registry, and what is mutually exclusive must be fixed at composition time.

`kernel.js` is the composition root: the one place that puts store / runner / tools side by side. It implements no capability itself; it only decides which implementation this deployment uses and which seams they are attached to.

### Seven layers, each layer's invariant asserted by the gate

Boundaries are expressed by directories and **asserted layer by layer** by `pnpm run build` — a boundary nobody asserts decays over time, and what is left is just a directory that happens to sit there.

| Layer | Modules | The invariant the gate asserts |
| --- | --- | --- |
| `rules/` | 25 | The pure core: no `node:`, no `ctx` — importable by plain Node |
| `canvas/` | 12 | Browser side: no `node:`; **it may read the pure core and nothing else**, importing any host layer is a boundary crossed |
| `store/` | 5 | Host side: **must not enter the serve allowlist** (entering it means shipping it to the browser) |
| `sources/` | 3 | same as above |
| `runner/` | 11 | same as above |
| `tools/` | 8 | same as above |
| `config/` | 2 | same as above |
| *all layers* | — | Dependencies **point inward only**; **no module may import `canvas/`** (it is a leaf, not a library) |

```
dsh-flow (plain JS, no runtime dependencies)
├── src/
│   ├── rules/          # 25 — the pure core: K1–K14 + the event protocol + projection + reconcile
│   │                   #   entities / gates / project / reconcile / coverage / delivery …
│   ├── store/          #  5 — team registry + append-only log + mailboxes + snapshot + import report
│   │                   #   → ctx.flowTeams (core)
│   ├── sources/        #  3 — the team source registry: this deployment's log / an imported .agent-teams
│   │                   #   → ctx.flowTeamSources (seam, registry form)
│   ├── runner/         # 11 — the executor seam: interface.js defines it, manual / subagents implement it
│   │                   #   → ctx.flowRunner (seam, one of two at composition time)
│   ├── tools/          #  8 — registration and implementation of the 13 flow_* tools
│   ├── config/         #  2 — deployment configuration: the profile table + the two hooks turning config into events
│   └── canvas/         # 12 — the canvas page (the only layer ever served over HTTP)
│       ├── canvas.js   #   entry: host bridge, live replies, polling, boot
│       ├── core.js     #   shared state, geometry, localStorage, host bridge, member colours
│       ├── html.js     #   escaping and other pure helpers (split out so panel modules are testable in Node)
│       ├── markdown.js #   Markdown rendering (with ■ section normalisation)
│       ├── relay.js    #   agent envelope parsing (relays / member messages / subagent notices)
│       ├── session.js  #   session projection data layer (incremental merge + cursors) + turn cards + branch layout
│       ├── teams.js    #   team polling (live → snapshot fallback) + hierarchical region layout
│       ├── team-panels.js # pure rendering for the panels (K9/K10/K11, attempt timeline, damaged lines)
│       ├── scene.js    #   scene assembly: requirement timeline + nested regions + typed edges
│       ├── view.js     #   camera, virtualised mounting, node rendering, inspector, main render
│       ├── artwork.js  #   artwork mapping (role keyword → profession image, state → action image)
│       └── actions.js  #   interaction: draft / follow-up / branch / archive / quick phrases / select-and-ask
├── index.js            # host-side entry: WorkspaceStore + session event projection + envelope parsing + routes
├── client.js           # client: one conversation.view tab (an embedded iframe) + theme following + action relay
├── engine.js           # canvas engine: camera / gestures / viewport culling / edge geometry / drag binding
├── theme.css           # design tokens (one set of variables for light/dark) + all component styles
├── assets/             # 15 artwork images (9 professions + 6 states)
├── kernel.js           # the composition root: the one place that puts store / runner / tools side by side
├── cordis.patch.yml    # inserts the dsh-flow service and gives it its config
└── package.json        # dsh.bundle.patch + dsh.client.inject
```

**Dependencies point inward only.** `rules` depends on no layer; `store` / `sources` / `runner` / `tools` / `config` depend only on `rules`; `canvas` reads only `rules` (team data arrives over HTTP, not by import); the composition root depends on all of them. Every one of those edges is asserted in the gate.

Three rules break most quietly, and the gate handles each explicitly: a canvas module doing `import 'node:fs'` is **green everywhere under `pnpm test`** and only a browser would notice; a module missing from the serve allowlist is only discoverable through a 404; and a host module importing `canvas/` backwards is green in Node too. So these are not conventions, they are assertions.

**How team activity is observed: through its own channel, without emitting session events.** The source of truth is `<stateDir>/<teamId>/events.jsonl` (an append-only event log), projected to `GET /dsh-flow/map-api/teams` for the canvas to read.

No `dsh-flow/*` event is written into the session because the host does not accept one: `KNOWN_SESSION_EVENT_TYPES` is a closed set generated at build time, whose comment states outright that a downstream plugin's events are "outside this list by construction" and that the registration surface is "deferred until there is a real consumer"; and `Session.append` offers no way to set the envelope's `ignorable` flag — without it an unrecognised type is treated as **required**, and the reader would rather refuse to reconstruct **the entire session**. So such an event would either be dropped or damage the log it landed in. The full argument is in the comment at the end of `kernel.js`.

## Comparison with dsh-agent-teams

In the host's own words, the difference is **whether a plugin divides its own internals into services**. The host frames this as "everything is a plugin" and "Plugins, not loop changes", which in code comes down to the `core` / `seam` split:

| Usual phrasing | The host's own terms | The evidence |
| --- | --- | --- |
| **microkernel** | Keep `core` as small as possible and hang every capability off a **declared seam**; new behaviour goes on an extension point rather than into `core` | dsh-flow: a `rules/` pure core (no IO, no `ctx`) + three services + one composition root |
| **monolithic kernel** | No seam; the capabilities all live inside `core` | dsh-agent-teams: `src/` is one flat plane (17 TS modules + 13 under `client/`), importing each other freely, with no mechanism asserting module boundaries |

A seam comprises three roles — **Service Definition / Provider / Consumer** — and is only complete with all three. In dsh-flow they line up plainly: `runner/interface.js` is the definition, `manual.js` and `subagents.js` are the two Providers, and `tools/` is the Consumer.

**Both are DSH plugins**, and both attach to seams the host provides — the difference is whether the plugin has seams of its own. Once the functionality is split into core and seam, "add another way to execute" is adding a Provider and "add another kind of team source" is one `register()` call; on a flat `src/`, that work is changing the core.

dsh-flow's goal is to **fully replace** [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams): everything it can do, this can do — but without depending on it. If it is installed, it is an optional read-only source; if it is not, everything still runs.

The capability surface is aligned: the 13 tools map one to one to `agent_teams_*`, and the 31 differential checks in `pnpm test:diff` guard that line (same functions fed the same inputs, conclusions compared one by one). **What differs is what it is like to use:**

### What it is like to use

| | dsh-flow | dsh-agent-teams |
| --- | --- | --- |
| Install | Clone it and it runs, **nothing to install** | Pulls a whole dependency tree (24 peers, including React 18) |
| Host upgrade | Declares no host version; probes capabilities at runtime and takes a fallback branch when it cannot | Pins 4 host versions in its peers; outside those it will not work |
| Change one canvas line | Save → **refresh the page** (0 builds, 0 restarts) | Rebuild the client bundle → **restart the host** |
| Stop execution, keep the view | `runner: manual` — look and edit, nothing runs | No equivalent switch |
| How a task's attempts went | Click a task row for the **attempt timeline**: how each attempt ended, which was rolled back | A monotonic attempt counter that cannot say how any one ended |
| Unreadable lines | Go into the **import report**, listed with **line numbers** on the canvas | — |
| Teams that cannot reach the canvas | Counted in the toolbar; they do not vanish silently | — |
| Approving a plan | Edit and approve directly on the canvas, through the same validation `flow_edit_plan` / `flow_approve` use | Panel editing |
| The canvas | Session timeline and team hierarchy **in one figure** (the team nests under the requirement turns) | A team tree panel |
| Uninstalling the other plugin | Everything keeps working — there was never a second record | — |

What you can "feel" in the table above all comes from the architecture: **a change takes effect on refresh** because canvas modules are served over HTTP individually (`src/**` invalidated by mtime + ETag revalidation), with no bundle step; **`runner: manual` exists** because execution is a seam, fixed at composition time; and **uninstalling the other plugin changes nothing** because team records are this plugin's own append-only log, with the other plugin only an entry in the source registry. Changing `client.js` (the tab registration layer) still requires a host restart on both sides — that layer really does go into the host's client bundle.

### Measurements

All of these are this repository's own numbers, reproducible with one command:

| Item | Number |
| --- | --- |
| Cost of the plugin on the host's startup path (`import './index.js'`) | **4.3 ms** |
| Composition root assembly (`import './kernel.js'`, cold) | 33 ms |
| A change to `src/canvas/**` taking effect | **0 builds, 0 restarts** |
| Canvas first paint | 41 requests / 449 KB; every request afterwards revalidates by ETag, so unchanged files are a 304 |
| The layer-boundary gate (107 modules parsed + 7 layers asserted + serve allowlist) | 4.0 s |
| All 434 tests | 1.1 s |

### Why there is no "N times faster" here

A cross-implementation performance comparison requires **both sides to run on this machine**. dsh-agent-teams' full pipeline does not: it has no `node_modules` and no `lib/` (its published artifact), and its `snapshot.ts` imports host runtime packages directly (`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-agent`). Replacing those with stubs and then timing measures the stubs, not it. Its state-reading layer (`src/state.ts`) depends only on Node builtins and could in principle run directly under Node 24, but that is another repository's code, and running it needs your explicit consent.

So any "N times faster" in this repository would be invented. What can be given is the kind of difference above — **confirmable without running anything** — plus my own reproducible measurements.

## Reference

### HTTP routes

All go through the `Host` check (`localhost` / `127.0.0.1` are allowed by default).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/dsh-flow` | 302 → `/dsh-flow/` |
| GET | `/dsh-flow/` | the canvas page |
| GET | `/dsh-flow/engine.js` · `/dsh-flow/src/canvas/*.js` · `/dsh-flow/src/rules/*.js` · `/dsh-flow/theme.css` | canvas assets |
| GET | `/dsh-flow/assets/*.png` | artwork (only `[a-z0-9-]+.png` is allowed) |
| GET | `/dsh-flow/map` · `/dsh-flow/map/` | 302 → `/dsh-flow/` (old path) |
| * | `/dsh-flow/map-api/*` | see below |

### Canvas API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/map-api/reset` | Clear every workspace and hide all current DSH sessions |
| GET | `/map-api/workspaces` | Workspace summary list |
| POST | `/map-api/workspaces` | Create a workspace `{ title }` |
| GET | `/map-api/workspaces/:id` | A full workspace (with threads / messages) |
| POST | `/map-api/workspaces/:id` | Create a node in a workspace `{ title, parentId?, dshSessionId?, position?, color? }` |
| POST | `/map-api/threads/:id/branch` | Branch from a node `{ title?, dshSessionId?, position?, color? }` |
| POST | `/map-api/threads/:id/messages` | Append a message `{ text }` |
| PATCH | `/map-api/threads/:id` | Change `title` / `position` |
| DELETE | `/map-api/threads/:id` | Delete a node **and every descendant**, and hide the matching DSH sessions |
| POST | `/map-api/sessions/sync` | Align the canvas with the host's session list `{ sessions, removedSessionIds }` |
| POST | `/map-api/projection` | **Incremental read**: `{ sessionIds, cursors }` → only the threads those sessions belong to, each carrying only messages whose `rev` exceeds the cursor; always returns `threadIds` so the client can prune archived nodes |
| GET | `/map-api/teams` | Team snapshot `{ teams, damaged }`: every team currently visible in the source registry, each with its own `warnings` (the import report); `damaged` is a **deployment-wide** count — a team that cannot even reach the canvas is visible only here |
| GET | `/map-api/profiles` | The addressable profile list (those with a truthy `profileCommandName`) |
| GET | `/map-api/teams/:teamId/tasks/:taskId` | One task's attempt timeline (including rollbacks). **Fetched on demand**, never carried in the one-second poll |
| POST | `/map-api/teams/:teamId/plan` | Edit a staged plan from the canvas. Shares `applyTeamEdits` with `flow_edit_plan`, so K8 judges once |
| POST | `/map-api/teams/:teamId/approve` | Approve a staged plan from the canvas. Shares `applyTeamApproval` with `flow_approve` |

The last two are **a person acting on their own team through their own canvas**, authorised by the `Host` check rather than by a session identity — an HTTP request carries no identity, and inventing one would be the appearance of a guarantee rather than a guarantee. Two constraints keep them from being a way around the tool layer: they go through the same `applyTeamEdits` / `applyTeamApproval`, and they accept only a source whose `canAppend` is true (a team imported from `.agent-teams` is somebody else's record and must not be appended to).

### postMessage protocol

Between the canvas page and the host client, only `{ source: 'dsh-flow', type, ...payload }` is recognised, and the origin and `event.source` must both be the frame this plugin mounted.

| Direction | Message | Payload | Behaviour |
| --- | --- | --- | --- |
| canvas → host | `flow:request-current` | — | sends back the current workspace and session |
| canvas → host | `flow:open-session` | `sessionId, seq?` | `sessions.open()` + switch back to the Chat tab + anchor the scroll at `seq` |
| canvas → host | `flow:activate-session` | `sessionId` | `sessions.open()` without leaving the canvas |
| canvas → host | `flow:fork-session` | `sessionId, atSeq?, requestId` | `sessions.fork()` |
| canvas → host | `flow:send-message` | `sessionId, text, requestId` | `session.prompt(text, 'queue')` |
| canvas → host | `flow:create-session` | `workspaceId?, cwd?, requestId` | `sessions.create()` |
| host → canvas | `flow:theme` · `flow:locale` | `dark` / `locale` | theme and locale following |
| host → canvas | `flow:workspaces` · `flow:current-session` | workspaces / current session | the canvas' input |
| host → canvas | `flow:live-reply` | `sessionId, running, text` | the live reply while generating |
| host → canvas | `flow:forked-session` · `flow:created-session` · `flow:message-sent` · `flow:bridge-error` | `requestId, …` | settling an RPC the canvas started |

Calls carrying a `requestId` are awaited by the canvas' `dshRpc()`, with a 20s timeout; opening the canvas page directly in a browser (outside DSH) rejects immediately.

### Local storage

| Location | Contents |
| --- | --- |
| `<DSH home>/flow/workspaces.json` (+ `.lock`) | Workspaces / nodes / projected messages, stored gzipped (plain JSON is readable too); **single writer only** |
| `<stateDir>/<teamId>/events.jsonl` | The team **source of truth**: an append-only event log (the default `stateDir` is `.dsh-flow`) |
| `<stateDir>/<teamId>/state.json` · `manifest.json` · `mail/` | Checkpoint, metadata, and one mailbox per member |
| `dsh-flow:map-card-positions:v3` | Session card coordinates |
| `dsh-flow:cluster-positions:v1` | Team region card coordinates |
| `dsh-flow:map-collapsed-cards:v1` | Collapsed state |
| `dsh-flow:map-quick-phrases:v1` | Quick phrases |
| `dsh-flow:map-branch-anchors` | Branch anchors |

Everything stored in the browser is **visual metadata only**; the real session always lives in DSH — clearing the cache loses layout and nothing else.

## Design decisions

**One canvas, hierarchical arrangement.** Sessions and teams are two views of the same piece of work: a team is raised by a session, and tasks are reported in the session. Splitting them into two pages would only mean two engines and two appearances. The engine (`engine.js`) handles only camera, gestures, culling and edges, and knows nothing about the domain; sessions and teams are both nodes and edges on top of it, with the team growing as a nested region beneath the requirement timeline — hierarchy by containment, time by columns.

**Team data lives at home.** Team structure lands in this plugin's own append-only log, and the canvas reads its own `map-api`, mirroring nobody's state. The direct consequence is that **uninstalling agent-teams changes nothing**: there is no "degrade to a frozen snapshot" middle state, because there was never a second record. When agent-teams is installed it is a **read-only source** in the registry — a switch, not a dependency.

**Relay messages are structured at the projection layer.** Envelope parsing lives host-side in `index.js` rather than in the render layer, because what lands on disk is already dirty data and washing late is worse than washing early; the render layer only applies the same rule to older data as a fallback.

**Writes funnel through the draft card.** Follow-up / branch / new-session on the canvas all go through that one entry point, and everything else is still done in the host's native conversation — the canvas does not build a second composer.

**Artwork is identity.** Member names and role keywords hash to the profession artwork in `assets/`: the member card, the inspector bubbles and the member rows all read from the same source, falling back to a colour block with the first character. The container background follows the light/dark theme.

## Development

```sh
pnpm test             # 434 tests: the rules core, the store on a real filesystem, the scheduler, the tools, the whole kernel
pnpm run build        # syntax + layer boundaries + serve allowlist + theme token discipline
pnpm test:diff        # 31 differential checks against dsh-agent-teams (same functions, same inputs, conclusions compared)
pnpm test:rehearsal   # rehearse against a real .agent-teams directory: everything on disk is reachable

dsh web
# click the Agent Canvas tab above the conversation area
```

**After changing anything under `src/`, always run `pnpm run build`.** It is not only a syntax check: every layer's invariant is asserted there (the pure core may not touch IO or `ctx`, the canvas may not touch `node:` or any host layer, host layers may not enter the serve allowlist, dependencies must point inward only, every layer's entry must exist). What those mistakes have in common is being **green under `pnpm test`** — a canvas module doing `import 'node:fs'` is only discoverable in a browser, and a module missing from the allowlist only through a 404.

A boundary nobody asserts decays over time, and what is left is just a directory that happens to sit there.

Changing `client.js` **requires restarting the host**: the client bundle carries a `rev` hash and is only repacked on restart. `engine.js` / `src/**` / `theme.css` / `assets/*.png` go through an in-memory cache keyed by mtime and are revalidated with `cache-control: no-cache` + ETag — every request confirms the file has not changed (and returns 200 with the new content if it has), so refreshing the page is enough.

## Known limits

- **The canvas' actual rendering has no automated tests**: the 434 tests cover the host side (rules, store, scheduler, tools, kernel) and the **pure rendering functions** of the panel modules. The canvas' DOM behaviour — dragging, the `<select>` interaction, clickable task rows, repainting after an edit — has to be walked through in a real browser, and that part has no CI behind it.
- **The `.agent-teams` source is read-only**: it can be listed and read, but not edited from the canvas (`canAppend` is false). It is somebody else's record, and appending would write a second copy of a team into our log under an id we do not own.
- **There is no edge between a team and its session**: the team record only says which session raised it; the dialogue chain on the canvas comes from the session projection itself.
- **Both data locations are single-writer**: `workspaces.json` and the team store each have a cross-process lock and a "modified by another instance" warning, but the lock is advisory and two open copies can still overwrite each other.
- **The canvas' own text is not internationalised**: tab names follow the host's language, the canvas' internal text is currently Chinese.
- **The canvas page carries no navigation chrome**: its only entry is the host tab bar. The tab only appears when there are sessions (the host returns null for a blank session). If the host's `slots` service is missing the tab is not registered, and only the direct link works.

## License

MIT © 2026 rootkiller6788 — see [LICENSE](LICENSE).
