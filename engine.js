// dsh-flow canvas engine.
//
// Everything the two old pages each carried a copy of now lives here once:
// camera (pan + pointer-centred zoom), pointer gestures, viewport culling,
// connector geometry and the drag binder. The page (canvas.js) owns all data
// and DOM for nodes; the engine only knows about rectangles and transforms.
//
// Screen-space mapping used throughout:
//   screen = world * zoom + camera   (transform-origin is 0 0)
const FlowEngine = (() => {
  'use strict'

  const ZOOM_MIN = 0.35
  const ZOOM_MAX = 4
  const roundZoom = value => Math.round(value * 100) / 100
  const clampZoom = value => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, roundZoom(value)))

  // ---------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------
  function createCamera({ x = 0, y = 0, zoom = 1, onChange } = {}) {
    const camera = { x, y, zoom, onChange }
    camera.apply = element => {
      if (element instanceof HTMLElement) element.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`
    }
    /** Zoom keeping the world point under the cursor pinned to the cursor. */
    camera.zoomAtPoint = (nextZoom, clientX, clientY, viewport) => {
      const target = clampZoom(nextZoom)
      if (target === camera.zoom || !(viewport instanceof HTMLElement)) return false
      const bounds = viewport.getBoundingClientRect()
      const localX = clientX - bounds.left
      const localY = clientY - bounds.top
      const worldX = (localX - camera.x) / camera.zoom
      const worldY = (localY - camera.y) / camera.zoom
      camera.zoom = target
      camera.x = localX - worldX * target
      camera.y = localY - worldY * target
      if (typeof camera.onChange === 'function') camera.onChange()
      return true
    }
    camera.zoomBy = (delta, viewport) => {
      const bounds = viewport instanceof HTMLElement ? viewport.getBoundingClientRect() : null
      const anchorX = bounds === null ? window.innerWidth / 2 : bounds.left + bounds.width / 2
      const anchorY = bounds === null ? window.innerHeight / 2 : bounds.top + bounds.height / 2
      return camera.zoomAtPoint(camera.zoom + delta, anchorX, anchorY, viewport)
    }
    /** Centre the world rectangle (x, y, w, h) in the viewport. */
    camera.centerOn = (rect, viewport) => {
      if (!(viewport instanceof HTMLElement)) return
      const bounds = viewport.getBoundingClientRect()
      camera.x = bounds.width / 2 - (rect.x + rect.w / 2) * camera.zoom
      camera.y = bounds.height / 2 - (rect.y + rect.h / 2) * camera.zoom
      if (typeof camera.onChange === 'function') camera.onChange()
    }
    /** Place the world point at the viewport's top-left inset by (insetX, insetY). */
    camera.anchorTopLeft = (worldX, worldY, insetX, insetY) => {
      camera.x = insetX - worldX * camera.zoom
      camera.y = insetY - worldY * camera.zoom
      if (typeof camera.onChange === 'function') camera.onChange()
    }
    return camera
  }

  // ---------------------------------------------------------------------------
  // Culling: world rectangles visible in the viewport, inflated by a margin so
  // nodes mount just before they scroll into view.
  // ---------------------------------------------------------------------------
  function worldWindow(camera, viewport, margin) {
    if (!(viewport instanceof HTMLElement)) return null
    const bounds = viewport.getBoundingClientRect()
    return {
      left: (-camera.x - margin) / camera.zoom,
      right: (bounds.width - camera.x + margin) / camera.zoom,
      top: (-camera.y - margin) / camera.zoom,
      bottom: (bounds.height - camera.y + margin) / camera.zoom,
    }
  }

  function visibleIds(items, camera, viewport, margin) {
    const window_ = worldWindow(camera, viewport, margin)
    if (window_ === null) return new Set(items.map(item => item.id))
    const visible = new Set()
    for (const item of items) {
      const { x, y, w, h } = item.rect
      if (x + w < window_.left || x > window_.right || y + h < window_.top || y > window_.bottom) continue
      visible.add(item.id)
    }
    return visible
  }

  /**
   * Mount/unmount nodes as the camera moves, without rebuilding the canvas.
   * `build(item)` must return an element positioned absolutely in world space.
   */
  function createVirtualizer({ layer, margin = 1400, build }) {
    const mounted = new Map()
    return {
      get size() { return mounted.size },
      has(id) { return mounted.has(id) },
      sync(items, camera, viewport) {
        if (!(layer instanceof HTMLElement)) return
        const visible = visibleIds(items, camera, viewport, margin)
        for (const [id, element] of mounted) {
          if (visible.has(id)) continue
          element.remove()
          mounted.delete(id)
        }
        for (const item of items) {
          if (!visible.has(item.id) || mounted.has(item.id)) continue
          const element = build(item)
          if (element instanceof HTMLElement) {
            layer.appendChild(element)
            mounted.set(item.id, element)
          }
        }
      },
      clear() {
        for (const element of mounted.values()) element.remove()
        mounted.clear()
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Connectors: cubic bezier that leaves the source on its right edge and
  // enters the target on its left edge, with a bend that scales with distance.
  // Rects are {x, y, w, h}; the page layers edge classes on top.
  // ---------------------------------------------------------------------------
  function edgePath(from, to) {
    const x1 = from.x + from.w
    const y1 = from.y + from.h / 2
    const x2 = to.x
    const y2 = to.y + to.h / 2
    const bend = Math.min(110, Math.max(36, Math.abs(x2 - x1) * 0.2))
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
  }

  function setEdgePath(pathElement, from, to) {
    if (pathElement instanceof SVGPathElement) pathElement.setAttribute('d', edgePath(from, to))
  }

  // ---------------------------------------------------------------------------
  // Drag binder: pointer drag with per-frame coalescing, so a high report-rate
  // pointer cannot queue a reflow per event. `zoom()` reads the live zoom so
  // world-space deltas stay correct while zoomed.
  // ---------------------------------------------------------------------------
  function bindDrag(handle, { zoom, onMove, onDrop }) {
    if (!(handle instanceof HTMLElement)) return
    handle.addEventListener('pointerdown', event => {
      if (typeof zoom !== 'function' || zoom() <= 0) return
      const card = handle.closest('[data-node][style]') ?? handle.closest('[data-node]')
      if (!(card instanceof HTMLElement)) return
      event.preventDefault()
      const origin = {
        x: event.clientX,
        y: event.clientY,
        position: { x: Number.parseFloat(card.style.left) || 0, y: Number.parseFloat(card.style.top) || 0 },
      }
      let position = origin.position
      let stopped = false
      let frame = 0
      const apply = () => {
        frame = 0
        if (typeof onMove === 'function') onMove(position, card)
      }
      const move = moveEvent => {
        const z = zoom()
        position = {
          x: origin.position.x + (moveEvent.clientX - origin.x) / z,
          y: origin.position.y + (moveEvent.clientY - origin.y) / z,
        }
        if (frame === 0) frame = window.requestAnimationFrame(apply)
      }
      const stop = () => {
        if (stopped) return
        stopped = true
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', stop)
        document.removeEventListener('pointercancel', stop)
        if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
        apply()
        if (typeof onDrop === 'function') onDrop(position, card)
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', stop)
      document.addEventListener('pointercancel', stop)
    })
  }

  // ---------------------------------------------------------------------------
  // Gestures: pan on the empty canvas, wheel zoom elsewhere. The page decides
  // what counts as "empty" via `interactive` (a selector matched against the
  // event target: when it hits, the engine keeps its hands off) and may veto
  // wheel zoom via `allowWheel`.
  // ---------------------------------------------------------------------------
  function attachGestures({ viewport, camera, interactive, allowWheel, onGesture }) {
    if (!(viewport instanceof HTMLElement)) return
    const blocked = event => typeof interactive === 'function' && event.target instanceof Element && interactive(event.target)
    const setGesture = active => {
      viewport.classList.toggle('is-panning', active)
      if (typeof onGesture === 'function') onGesture(active)
    }

    viewport.addEventListener('pointerdown', event => {
      if (blocked(event) || event.button !== 0) return
      event.preventDefault()
      const origin = { x: event.clientX, y: event.clientY, camera: { x: camera.x, y: camera.y } }
      let pendingCamera = null
      let frame = 0
      setGesture(true)
      try { viewport.setPointerCapture(event.pointerId) } catch { /* detached */ }
      const apply = () => {
        frame = 0
        if (pendingCamera === null) return
        camera.x = pendingCamera.x
        camera.y = pendingCamera.y
        pendingCamera = null
        if (typeof camera.onChange === 'function') camera.onChange()
      }
      const move = moveEvent => {
        pendingCamera = {
          x: origin.camera.x + moveEvent.clientX - origin.x,
          y: origin.camera.y + moveEvent.clientY - origin.y,
        }
        if (frame === 0) frame = window.requestAnimationFrame(apply)
      }
      const stop = () => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', stop)
        document.removeEventListener('pointercancel', stop)
        if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
        apply()
        setGesture(false)
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', stop)
      document.addEventListener('pointercancel', stop)
    })

    viewport.addEventListener('wheel', event => {
      if (typeof allowWheel === 'function' && !allowWheel(event)) return
      event.preventDefault()
      camera.zoomAtPoint(camera.zoom + (event.deltaY < 0 ? 0.05 : -0.05), event.clientX, event.clientY, viewport)
    }, { passive: false })
  }

  // ---------------------------------------------------------------------------
  // Keyed position memory (visual metadata only — never node identity).
  // ---------------------------------------------------------------------------
  function positionStore(storageKey) {
    let entries = new Map()
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (Array.isArray(item) && typeof item[0] === 'string' && item[1] !== null && Number.isFinite(item[1].x) && Number.isFinite(item[1].y)) {
            entries.set(item[0], { x: Math.round(item[1].x), y: Math.round(item[1].y) })
          }
        }
      }
    } catch { /* private browsing */ }
    let flushTimer = 0
    const persist = () => {
      try { localStorage.setItem(storageKey, JSON.stringify([...entries])) } catch { /* private browsing */ }
    }
    return {
      get(key) { return entries.get(key) },
      set(key, position, aliases = []) {
        const rounded = { x: Math.round(position.x), y: Math.round(position.y) }
        entries.set(key, rounded)
        for (const alias of aliases) entries.set(alias, rounded)
        // Coalesce rapid drags into one write per idle gap.
        window.clearTimeout(flushTimer)
        flushTimer = window.setTimeout(persist, 400)
      },
      clear() { entries.clear(); persist() },
    }
  }

  return {
    ZOOM_MIN,
    ZOOM_MAX,
    createCamera,
    visibleIds,
    worldWindow,
    createVirtualizer,
    edgePath,
    setEdgePath,
    bindDrag,
    attachGestures,
    positionStore,
  }
})()
window.dshFlowEngine = FlowEngine
