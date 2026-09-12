window.__ModuleLoader__.load({
  id: 'dsh-flow',
  factory: require => {
    const React = require('react')
    const module = { exports: {} }
    // One conversation View tab — 「智能体画布」, a peer of the host's own Chat
    // (order 0) and Trajectory (order 10) tabs. It renders exactly one iframe
    // and no navigation chrome of its own, and inside that iframe live two
    // layers: the agent-teams canvas (/dsh-flow/) and the session map
    // (/dsh-flow/map/). The 转换 button in the canvas' control row swaps them.
    //
    // There used to be a second View tab for the map. The host renders only the
    // active View, so two tabs were two documents carrying two engines, and the
    // tab row read as two features stitched together. Now the two engines are
    // two layers of one canvas: 转换 re-points this tab's iframe from one page to
    // the other, so neither engine had to be merged or rewritten.
    //
    // Neither layer paints its own name: the pages carry no brand row and no
    // plugin id. The tab row names the canvas; the control row's 转换 names the
    // layer you are looking at.
    // Theme and locale come from the host services (ctx.theme / ctx.locale) —
    // the same sources the native UI renders from — so both layers switch
    // light/dark and zh/en together with the rest of the harness.
    module.exports.inject = ['sessions', 'workspaces', 'slots', 'theme', 'locale']
    module.exports.apply = ctx => {
      const NS = 'view.dsh-flow'
      /** The host's own Chat tab — where the canvas' session actions land. */
      const CHAT_VIEW = 'chat'
      /** The tab's id, which is also this tab's mounted-frame registry key. */
      const CANVAS = 'flow'
      // The tab's two layers. `team` is the default because it is the layer the
      // tab is named after; 转换 flips to `session` and back.
      const LAYERS = {
        team: { src: '/dsh-flow/', label: 'view.canvas' },
        session: { src: '/dsh-flow/map/', label: 'view.map' },
      }
      const ORDER = 20
      // Which layer is on screen. Module state rather than React state, so it
      // survives the host unmounting the tab (it renders the active View alone):
      // come back to the tab and the canvas is on the layer you left it on.
      // Deliberately not persisted — a reloaded page starts on the tab's own
      // layer, which is the one the tab is named after.
      let layer = 'team'

      const DICT = {
        zh: { 'view.canvas': '智能体画布', 'view.map': '会话地图' },
        en: { 'view.canvas': 'Agent Canvas', 'view.map': 'Session Map' },
      }
      // getSnapshot().active is a registered locale id ("zh"/"en"), but a
      // browser-derived provisional value can arrive region-tagged ("zh-CN").
      const localeId = () => (/^zh/i.test(ctx.locale.getSnapshot().active ?? '') ? 'zh' : 'en')
      const t = ctx.locale.bind(NS)

      const currentSession = () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        const id = snapshot.current
        if (id === undefined) return null
        const session = snapshot.byId[id]
        return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null }
      }
      const sessionSnapshot = () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        return snapshot.ids.map(id => {
          const session = snapshot.byId[id]
          return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null, parentId: session.parentId ?? null, blank: session.blank }
        }).filter(Boolean)
      }
      const workspaceSnapshot = () => {
        const sessions = ctx.sessions.list.getSnapshot()
        const snapshot = ctx.workspaces.list.getSnapshot()
        const accounted = new Set(snapshot.items.flatMap(workspace => workspace.sessionIds))
        return [
          ...snapshot.items.map(workspace => ({ id: workspace.workspaceId, title: workspace.title, path: workspace.path, sessionIds: workspace.sessionIds })),
          { id: 'dsh-ungrouped', title: '未分组', path: null, sessionIds: sessions.ids.filter(id => !accounted.has(id)) },
        ]
      }
      const prompt = async (sessionId, text) => {
        const scope = ctx.sessions.scope(sessionId)
        const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
        if (session === undefined) throw new Error('关联的 DSH 会话已不可用')
        const result = await session.prompt([{ type: 'text', text }], 'queue')
        if (!result.ok) throw new Error(result.error?.message ?? 'DSH 未接受这条消息')
      }

      const style = document.createElement('style')
      style.textContent = [
        // The host hands the active View a .viewArea flex column; fill it.
        '.dsh-flow-view{flex:1;min-height:0;display:flex;flex-direction:column}',
        // Held hidden (not display:none, which would clamp the canvas' measured
        // scroll offset to zero) only until the frame has loaded, so the tab
        // body never flashes an unpainted white sheet in dark mode. The layer
        // swap reuses it for the same reason.
        '.dsh-flow-view.is-opening{visibility:hidden}',
        '.dsh-flow-frame{flex:1;min-width:0;display:block;border:0}',
        // The host renders its own session composer underneath whichever view is
        // active, so it sits under the canvas too. The canvas owns the whole
        // conversation column, so while our tab is mounted we hide that native
        // composer (a stable data-attribute anchor, not a hashed class) and
        // restore it the moment Chat/Trajectory is selected again.
        // That one seat is the entire composer: the host builds the whole slot
        // chain inside it — the conversation editor, the user-questions prompt,
        // the read-only sub-agent composer, attachments — so hiding the seat
        // hides every one of them, including the panels that would otherwise
        // pop up over the canvas mid-turn.
        'body.dsh-flow-view-active [data-composer-seat]{display:none!important}',
        // The host's other composer shape: a view that marks itself with
        // `[data-conversation-composer-overlay]` (Trajectory does) gets the seat
        // positioned as a floating overlay instead of a sticky row. Ours never
        // renders that marker, but the rule is here so no composer variant can
        // survive over the canvas.
        'body.dsh-flow-view-active [data-conversation-composer-overlay]{display:none!important}',
        // Hiding the composer alone leaves its two column-width grips behind:
        // the host keeps them live at `position:absolute; top:0; bottom:0` with
        // `cursor:col-resize`, so they lie across the canvas' left and right
        // edges and a drag in our tab resizes the native chat column instead of
        // panning the canvas. The host hides them itself whenever the composer
        // renders as an overlay — `.root:has([data-conversation-composer-overlay])
        // .widthHandle{display:none}`, which is exactly the case our canvas is in
        // — so this is that same rule, keyed off the mounted-tab body class.
        // `[data-width-handle]` is set on that div alone and nowhere else in the
        // host bundles, the same kind of stable anchor as the composer seat.
        'body.dsh-flow-view-active [data-width-handle]{display:none!important}',
      ].join('')
      document.head.append(style)

      // Only the mounted tab's frame exists at a time — the host renders the
      // active View alone — so this map is also "is our canvas live".
      const frames = new Map()
      // The body class arms the `[data-composer-seat]` rule above. frames.size is
      // the signal: the host renders only the active View ({ only: active.id }), so
      // our frame is mounted exactly when our tab is selected.
      const syncComposerVisibility = () => document.body.classList.toggle('dsh-flow-view-active', frames.size > 0)
      const send = (type, payload) => frames.get(CANVAS)?.contentWindow?.postMessage({ source: 'dsh-flow', type, ...payload }, location.origin)
      // Messages only the session layer understands. While the canvas layer is
      // on screen they are dropped rather than handed to a frame that would
      // ignore them — one frame carries both layers, so the layer is the only
      // thing that can tell them apart.
      const sendSession = (type, payload) => { if (layer === 'session') send(type, payload) }
      // 转换: swap the layer inside this tab's one frame. Assigning `src` on a
      // live iframe navigates it, so the incoming layer boots exactly the way a
      // tab switch used to — the honest cost of keeping two separate engines.
      const showLayer = () => {
        const frame = frames.get(CANVAS)
        if (frame === undefined) return
        // Hold the outgoing layer's pixels until the incoming one paints, so a
        // dark-mode swap never flashes an unpainted white sheet.
        frame.parentElement?.classList.add('is-opening')
        frame.title = t(LAYERS[layer].label)
        frame.src = LAYERS[layer].src
      }

      // snapshot.active is the *resolved* theme, so a `system` preference
      // follows the OS scheme instead of reading as neither light nor dark.
      // Sent to whichever layer is on screen, so a 转换 never lands on a page
      // that has not been told the theme yet.
      const syncTheme = () => send('flow:theme', { dark: ctx.theme.getTheme().active.colorScheme === 'dark' })
      // The canvas layer's copy is localized; the session layer's is not, so it
      // ignores this message.
      const syncLocale = () => send('flow:locale', { locale: localeId() })

      let syncQueued = false
      const knownSessionIds = new Set()
      const syncSessions = () => {
        if (syncQueued) return
        syncQueued = true
        queueMicrotask(() => {
          syncQueued = false
          const sessions = sessionSnapshot()
          const sessionIds = new Set(sessions.map(session => session.id))
          const removedSessionIds = [...knownSessionIds].filter(id => !sessionIds.has(id))
          knownSessionIds.clear()
          for (const id of sessionIds) knownSessionIds.add(id)
          void fetch('/dsh-flow/map-api/sessions/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions, removedSessionIds }) }).catch(() => {})
        })
      }
      const liveUnsubscribers = new Map()
      const syncLiveSessions = () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        for (const id of snapshot.ids) {
          if (liveUnsubscribers.has(id)) continue
          const scope = ctx.sessions.scope(id)
          const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
          if (session === undefined) continue
          const publish = () => {
            // Nobody is listening while the session layer is not on screen.
            if (layer !== 'session' || !frames.has(CANVAS)) return
            const state = session.getSnapshot()
            const text = state.partial?.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n') ?? ''
            send('flow:live-reply', { sessionId: id, running: state.running, text })
          }
          liveUnsubscribers.set(id, session.subscribe(publish))
          publish()
        }
        for (const [id, unsubscribe] of liveUnsubscribers) if (!snapshot.ids.includes(id)) { unsubscribe(); liveUnsubscribers.delete(id) }
      }
      const pushMapState = () => {
        sendSession('flow:workspaces', { workspaces: workspaceSnapshot() })
        sendSession('flow:current-session', { session: currentSession() })
      }
      const syncCurrentSession = () => {
        syncSessions()
        syncLiveSessions()
        syncTheme()
        pushMapState()
      }

      // Set by the mounted View from the props the host hands it.
      // `openView` is the host's own tab switch, which is also how we get back
      // to Chat on the canvas' behalf.
      const openView = { current: undefined }
      const close = () => { if (openView.current !== undefined) openView.current(CHAT_VIEW, '') }

      const onMessage = event => {
        if (event.origin !== location.origin || event.data?.source !== 'dsh-flow') return
        // Same-origin is not enough: the message has to come from the frame we
        // mounted, so another plugin's iframe cannot drive our session actions.
        if (frames.get(CANVAS)?.contentWindow !== event.source) return
        const type = event.data.type
        // Emitted by the 转换 button, which both layers carry so either one can
        // hand over to the other. A toggle rather than a target layer name, so
        // the two layers can never disagree about which one is showing.
        if (type === 'flow:switch-layer') {
          layer = layer === 'team' ? 'session' : 'team'
          showLayer()
          return
        }
        if (type === 'flow:request-current') {
          sendSession('flow:workspaces', { workspaces: workspaceSnapshot() })
          return sendSession('flow:current-session', { session: currentSession() })
        }
        if (type === 'flow:open-session') {
          try { ctx.sessions.open(event.data.sessionId); close() } catch { sendSession('flow:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
          // Best-effort anchor to the requested turn: chat nodes expose their
          // source event seq (anchorSeq) and render with data-chat-anchor-key,
          // so resolve seq -> node key -> scroll once the view materializes.
          const seq = event.data.seq
          if (Number.isInteger(seq)) {
            const tryScroll = attempt => {
              const scope = ctx.sessions.scope(event.data.sessionId)
              const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
              if (session === undefined) return
              const chat = session.getSnapshot()?.chat
              if (chat === undefined) return
              let key = undefined
              for (const node of chat.nodes.values()) {
                if (node.anchorSeq === seq) { key = node.key; break }
              }
              if (key !== undefined) {
                const row = document.querySelector(`[data-chat-anchor-key="${CSS.escape(key)}"]`)
                if (row instanceof HTMLElement) row.scrollIntoView({ block: 'start' })
                return
              }
              if (attempt < 3) window.setTimeout(() => tryScroll(attempt + 1), 500)
            }
            window.setTimeout(() => tryScroll(0), 300)
          }
          return
        }
        if (type === 'flow:activate-session') {
          // Bidirectional current-session sync: switch DSH's current session
          // without leaving the canvas; the subscription re-sends
          // flow:current-session so the map follows the new highlight.
          try { ctx.sessions.open(event.data.sessionId) } catch { sendSession('flow:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
          return
        }
        if (type === 'flow:fork-session') {
          const atSeq = Number.isInteger(event.data.atSeq) ? event.data.atSeq : undefined
          ctx.sessions.fork({ sessionId: event.data.sessionId, atSeq, increaseTitle: true }).then(id => {
            const snapshot = ctx.sessions.list.getSnapshot()
            sendSession('flow:forked-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? 'DSH 分支' } })
          }).catch(() => { sendSession('flow:bridge-error', { message: 'DSH 分支创建失败，请确认源会话已经完成当前轮次' }) })
          return
        }
        if (type === 'flow:send-message') {
          const text = typeof event.data.text === 'string' ? event.data.text.trim() : ''
          if (text === '') return sendSession('flow:bridge-error', { requestId: event.data.requestId, message: '消息不能为空' })
          prompt(event.data.sessionId, text).then(() => {
            sendSession('flow:message-sent', { requestId: event.data.requestId, sessionId: event.data.sessionId })
          }).catch(error => {
            sendSession('flow:bridge-error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : 'DSH 消息发送失败' })
          })
          return
        }
        if (type === 'flow:create-session') {
          const workspaceId = typeof event.data.workspaceId === 'string' && event.data.workspaceId !== '' && event.data.workspaceId !== 'dsh-ungrouped' ? event.data.workspaceId : undefined
          const cwd = typeof event.data.cwd === 'string' && event.data.cwd !== '' ? event.data.cwd : undefined
          const create = workspaceId === undefined ? ctx.sessions.create(cwd === undefined ? {} : { cwd }) : ctx.sessions.create({ workspaceId })
          create.then(id => {
            const snapshot = ctx.sessions.list.getSnapshot()
            sendSession('flow:created-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? '新会话', cwd: snapshot.byId[id]?.cwd ?? cwd ?? null } })
          }).catch(() => { sendSession('flow:bridge-error', { requestId: event.data.requestId, message: 'DSH 会话创建失败，请先在 DSH 选择工作目录' }) })
        }
      }
      window.addEventListener('message', onMessage)

      /** The tab body: one iframe, mounted for as long as the tab is active. */
      const createCanvasTab = () => props => {
        const container = React.useRef(null)
        // Layout effect, not a plain effect: mounting the frame is what adds the
        // body class that hides the native composer, and a passive effect runs
        // *after* the host has painted — so the native input box would still be
        // on screen for one frame every time this tab is selected. Before paint,
        // it never gets painted at all.
        React.useLayoutEffect(() => {
          openView.current = props.openView
          const node = container.current
          if (node === null) return undefined
          // Built per mount rather than hoisted: the host renders only the
          // active View, so a tab switch unmounts this branch — which destroys
          // the iframe's browsing context anyway — and coming back is a fresh load.
          // The layer it opens on is whatever 转换 last left it on.
          const frame = document.createElement('iframe')
          frame.className = 'dsh-flow-frame'
          frame.title = t(LAYERS[layer].label)
          frame.src = LAYERS[layer].src
          node.classList.add('is-opening')
          const reveal = () => {
            window.clearTimeout(fallback)
            node.classList.remove('is-opening')
          }
          const onLoad = () => {
            // A freshly loaded frame has no locale/theme/state yet.
            // syncCurrentSession carries the theme, so it is not sent twice.
            syncLocale()
            syncCurrentSession()
            // Only the session layer has an opening act (fit + focus).
            if (layer === 'session') send('flow:map-opened')
            // One frame's grace so the canvas can finish its own centering.
            window.requestAnimationFrame(reveal)
          }
          // If the frame never loads, reveal anyway rather than showing nothing.
          const fallback = window.setTimeout(reveal, 1500)
          frame.addEventListener('load', onLoad)
          frames.set(CANVAS, frame)
          syncComposerVisibility()
          node.append(frame)
          return () => {
            window.clearTimeout(fallback)
            frame.removeEventListener('load', onLoad)
            // Only surrender the slot if it is still ours, so a cleanup that
            // overlaps a remount cannot evict the live frame.
            if (frames.get(CANVAS) === frame) frames.delete(CANVAS)
            syncComposerVisibility()
            frame.remove()
          }
        }, [])
        return React.createElement('div', { className: 'dsh-flow-view', ref: container })
      }

      // Theme + locale follow the host services, so a switch made anywhere in
      // the native UI reaches the canvas. Client plugins share one context,
      // which is what lets `ctx.on('theme/change')` reach us — the same idiom
      // dsh-client-ui-layout uses to drive its ThemePresenter.
      ctx.effect(() => {
        const offTheme = ctx.on('theme/change', syncTheme)
        const offLocale = ctx.locale.subscribe(syncLocale)
        return () => { offTheme(); offLocale() }
      }, 'dsh-flow: theme + locale follow')
      ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-flow: copy')

      // Contributed as a peer of the host's Chat (order 0) and Trajectory
      // (order 10) tabs. The host projects the tab roster straight off these
      // entries, persists the choice per session, and falls back to Chat if the
      // stored id is gone — so an unload can never strand a session here.
      ctx.effect(() => ctx.slots.inject('conversation.view', () => {
        const dispose = ctx.slots.register({
          name: 'conversation.view',
          id: CANVAS,
          order: ORDER,
          locale: NS,
          label: () => t('view.canvas'),
        }, createCanvasTab())
        return () => { if (typeof dispose === 'function') dispose() }
      }), 'dsh-flow: conversation view tab')

      ctx.effect(() => () => {
        window.removeEventListener('message', onMessage)
        for (const unsubscribe of liveUnsubscribers.values()) unsubscribe()
        for (const frame of frames.values()) frame.remove()
        frames.clear()
        syncComposerVisibility()
        style.remove()
      }, 'dsh-flow: view teardown')
    }
    return module.exports
  },
})
