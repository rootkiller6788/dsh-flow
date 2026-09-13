window.__ModuleLoader__.load({
  id: 'dsh-flow',
  factory: require => {
    const React = require('react')
    const module = { exports: {} }
    // One conversation View tab — 「智能体画布」, a peer of the host's own Chat
    // (order 0) and Trajectory (order 10) tabs. It renders exactly one iframe
    // and no navigation chrome of its own; the iframe is the unified canvas,
    // where session turns and agent teams are one graph.
    //
    // There used to be two tabs, then two layers behind a 转换 button. Both
    // shapes meant two documents carrying two engines; now a single page serves
    // the whole canvas and no layer swap exists at all.
    //
    // The page carries no brand row and no plugin id: the tab row names the
    // canvas. Theme and locale come from the host services (ctx.theme /
    // ctx.locale) — the same sources the native UI renders from.
    module.exports.inject = ['sessions', 'workspaces', 'slots', 'theme', 'locale']
    module.exports.apply = ctx => {
      const NS = 'view.dsh-flow'
      /** The host's own Chat tab — where the canvas' session actions land. */
      const CHAT_VIEW = 'chat'
      /** The tab's id, which is also this tab's mounted-frame registry key. */
      const CANVAS = 'flow'
      const ORDER = 20

      const DICT = {
        zh: { 'view.canvas': '智能体画布' },
        en: { 'view.canvas': 'Agent Canvas' },
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
        // body never flashes an unpainted white sheet in dark mode.
        '.dsh-flow-view.is-opening{visibility:hidden}',
        '.dsh-flow-frame{flex:1;min-width:0;display:block;border:0}',
        // The host renders its own session composer underneath whichever view is
        // active, so it sits under the canvas too. The canvas owns the whole
        // conversation column, so while our tab is mounted we hide that native
        // composer (a stable data-attribute anchor, not a hashed class) and
        // restore it the moment Chat/Trajectory is selected again.
        'body.dsh-flow-view-active [data-composer-seat]{display:none!important}',
        // The host's other composer shape (an overlay-marked view) is covered
        // by the same rule so no composer variant can survive over the canvas.
        'body.dsh-flow-view-active [data-conversation-composer-overlay]{display:none!important}',
        // Hiding the composer alone leaves its two column-width grips behind:
        // the host keeps them live at `position:absolute; top:0; bottom:0`, so
        // they lie across the canvas' edges and a drag in our tab would resize
        // the native chat column. The host hides them itself whenever the
        // composer renders as an overlay — this is that same rule, keyed off
        // the mounted-tab body class.
        'body.dsh-flow-view-active [data-width-handle]{display:none!important}',
        // The agent-teams plugin paints its own floating badge and activity
        // panel into the conversation column. Over the canvas they cover our
        // controls, and their visual identity is not ours to inherit — so on
        // OUR view only, they are hidden. Match by the plugin's CSS-module
        // namespace prefix rather than one exact class, so minor upstream
        // renames of the suffix keep working; the prefix is its bundle hash,
        // which changes only when the plugin is rebuilt anyway. Outside the
        // canvas (native Chat) none of this applies — that UI is theirs.
        'body.dsh-flow-view-active [class*="aYQbCq_"]{display:none!important}',
      ].join('')
      document.head.append(style)

      // Only the mounted tab's frame exists at a time — the host renders the
      // active View alone — so this map is also "is our canvas live".
      const frames = new Map()
      // The body class arms the rules above. frames.size is the signal: the host
      // renders only the active View, so our frame is mounted exactly when our
      // tab is selected.
      const syncComposerVisibility = () => document.body.classList.toggle('dsh-flow-view-active', frames.size > 0)
      const send = (type, payload) => frames.get(CANVAS)?.contentWindow?.postMessage({ source: 'dsh-flow', type, ...payload }, location.origin)

      // snapshot.active is the *resolved* theme, so a `system` preference
      // follows the OS scheme instead of reading as neither light nor dark.
      const syncTheme = () => send('flow:theme', { dark: ctx.theme.getTheme().active.colorScheme === 'dark' })
      // The canvas renders its own copy; it reads this to stay in step.
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
            if (!frames.has(CANVAS)) return
            const state = session.getSnapshot()
            const text = state.partial?.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n') ?? ''
            send('flow:live-reply', { sessionId: id, running: state.running, text })
          }
          liveUnsubscribers.set(id, session.subscribe(publish))
          publish()
        }
        for (const [id, unsubscribe] of liveUnsubscribers) if (!snapshot.ids.includes(id)) { unsubscribe(); liveUnsubscribers.delete(id) }
      }
      const syncCurrentSession = () => {
        syncSessions()
        syncLiveSessions()
        syncTheme()
        send('flow:workspaces', { workspaces: workspaceSnapshot() })
        send('flow:current-session', { session: currentSession() })
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
        if (type === 'flow:request-current') {
          send('flow:workspaces', { workspaces: workspaceSnapshot() })
          return send('flow:current-session', { session: currentSession() })
        }
        if (type === 'flow:open-session') {
          try { ctx.sessions.open(event.data.sessionId); close() } catch { send('flow:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
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
          // flow:current-session so the canvas follows the new highlight.
          try { ctx.sessions.open(event.data.sessionId) } catch { send('flow:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
          return
        }
        if (type === 'flow:fork-session') {
          const atSeq = Number.isInteger(event.data.atSeq) ? event.data.atSeq : undefined
          ctx.sessions.fork({ sessionId: event.data.sessionId, atSeq, increaseTitle: true }).then(id => {
            const snapshot = ctx.sessions.list.getSnapshot()
            send('flow:forked-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? 'DSH 分支' } })
          }).catch(() => { send('flow:bridge-error', { requestId: event.data.requestId, message: 'DSH 分支创建失败，请确认源会话已经完成当前轮次' }) })
          return
        }
        if (type === 'flow:send-message') {
          const text = typeof event.data.text === 'string' ? event.data.text.trim() : ''
          if (text === '') return send('flow:bridge-error', { requestId: event.data.requestId, message: '消息不能为空' })
          prompt(event.data.sessionId, text).then(() => {
            send('flow:message-sent', { requestId: event.data.requestId, sessionId: event.data.sessionId })
          }).catch(error => {
            send('flow:bridge-error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : 'DSH 消息发送失败' })
          })
          return
        }
        if (type === 'flow:create-session') {
          const workspaceId = typeof event.data.workspaceId === 'string' && event.data.workspaceId !== '' && event.data.workspaceId !== 'dsh-ungrouped' ? event.data.workspaceId : undefined
          const cwd = typeof event.data.cwd === 'string' && event.data.cwd !== '' ? event.data.cwd : undefined
          const create = workspaceId === undefined ? ctx.sessions.create(cwd === undefined ? {} : { cwd }) : ctx.sessions.create({ workspaceId })
          create.then(id => {
            const snapshot = ctx.sessions.list.getSnapshot()
            send('flow:created-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? '新会话', cwd: snapshot.byId[id]?.cwd ?? cwd ?? null } })
          }).catch(() => { send('flow:bridge-error', { requestId: event.data.requestId, message: 'DSH 会话创建失败，请先在 DSH 选择工作目录' }) })
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
          const frame = document.createElement('iframe')
          frame.className = 'dsh-flow-frame'
          frame.title = t('view.canvas')
          frame.src = '/dsh-flow/'
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
      // which is what lets `ctx.on('theme/change')` reach us.
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
