/**
 * The updater's browser half: update controls injected into the Plugins page.
 *
 * A plain script on purpose — the host serves a client bundle as one concatenated
 * classic script, so this file declares a factory function and imports nothing.
 * `scripts/build-client.mjs` wraps it, together with `src/i18n.js`, in the module
 * envelope the loader expects.
 *
 * Why DOM injection at all: the official Plugins page exposes several detail-page
 * slots but *no* slot on the list itself, and the list is exactly where both
 * controls belong. Two rules keep the attachment safe.
 *
 * 1. Only ever *append a sibling* into a container React renders. React diffs its
 *    own children and leaves unknown nodes alone, and the two containers used here
 *    — the toolbar's control row and a card's trailing cell — have stable children,
 *    so nothing of the host's is ever reordered or rewritten.
 * 2. Never read or write a class name the host owns. CSS-module hashes change
 *    between builds, so every anchor below is a `data-*` attribute or an ARIA role
 *    the page already carries for accessibility.
 *
 * Nothing is written to a host node: no attribute, no text, no class.
 */

/**
 * Build the client plugin's `apply` and `inject`.
 * @param React - the host's React instance, resolved through the module loader.
 * @returns the client plugin halves.
 */
function createUpdaterClient(React) {
  const API = '/api/plugin-updater'

  /**
   * React's element factory, used only for the detail-page slot.
   *
   * The injected controls are plain DOM because they are inserted into a list React
   * did not render them into; the detail control is the opposite — a slot the host
   * renders — so it must be a React element and is built with this.
   */
  const createElement = React.createElement

  /** Marks every node this plugin owns, so cleanup and idempotence are one selector. */
  const OWNED = 'data-plugin-updater'

  /* ---------------------------------------------------------------- styles -- */

  /**
   * Styles for the injected controls.
   *
   * Every value is copied from the host's own published primitives so an injected
   * control is indistinguishable from a rendered one: the `sm` size, the outline
   * and ghost variants and the disabled rule come from `Button.module.css`; the
   * capsule and its tone formula from `Tag.module.css`; the spinner geometry and
   * its 1.5s dash animation from `StateDot.module.css`. Only `--dsw-*` semantic
   * tokens are used, so light and dark both follow the theme with no second rule.
   */
  const CSS = [
    '.dsu-row{display:inline-flex;align-items:center;gap:8px}',
    '.dsu-card-row{display:inline-flex;align-items:center;gap:8px;min-width:0}',

    // Button: the host's `.button` + `.sm`, in each variant it publishes.
    '.dsu-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
    'gap:4px;border:none;border-radius:var(--dsw-radius-sm);cursor:pointer;font-family:inherit;',
    'font-size:12px;line-height:18px;height:28px;padding:0 10px;color:var(--dsw-alias-label-primary);',
    'background:transparent;white-space:nowrap;transition:background 120ms ease,color 120ms ease,border-color 120ms ease}',
    // A `display` declaration on the base class outranks the user agent's own
    // `[hidden]{display:none}`, because this stylesheet is injected after it. The
    // rule is restated here so `hidden` keeps working on an injected control.
    '.dsu-btn[hidden]{display:none}',
    '.dsu-btn:disabled{cursor:not-allowed;opacity:.4}',
    '.dsu-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
    '.dsu-outline{border:.5px solid var(--dsw-alias-border-l3)}',
    '.dsu-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
    '.dsu-outline:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
    '.dsu-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
    '.dsu-ghost:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
    '.dsu-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
    '.dsu-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
    // A failed update is the one state that must be impossible to miss.
    '.dsu-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
    '.dsu-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}',
    '.dsu-link{border:none;background:none;padding:0;height:auto;font:inherit;cursor:pointer;',
    'color:var(--dsw-alias-label-tertiary);text-decoration:underline;text-underline-offset:2px}',
    '.dsu-link:hover:not(:disabled){background:none;color:var(--dsw-alias-label-primary)}',
    '.dsu-link:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',

    // Tag: the host's capsule, in the tones this feature needs.
    '.dsu-tag{display:inline-flex;align-items:center;border-radius:999px;corner-shape:round;',
    'padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;',
    'font-variant-numeric:tabular-nums;font-family:var(--dsw-font-mono,ui-monospace,monospace);',
    'background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);',
    'color:var(--dsw-alias-state-business-primary)}',
    '.dsu-tag-success{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);',
    'color:var(--dsw-alias-state-success-primary)}',
    '.dsu-tag-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);',
    'color:var(--dsw-alias-state-warn-primary)}',

    // StateDot: the host's ongoing spinner, same period and dash rhythm.
    '.dsu-spin{flex:none;color:var(--dsw-alias-label-tertiary);transform-origin:center;',
    'animation:dsu-spin 1.5s linear infinite}',
    '.dsu-spin .dsu-track{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;opacity:.25}',
    '.dsu-spin .dsu-arc{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;',
    'stroke-dasharray:12 150;animation:dsu-dash 1.5s ease-in-out infinite}',
    '@keyframes dsu-spin{to{transform:rotate(360deg)}}',
    '@keyframes dsu-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}',
    '50%{stroke-dasharray:24 150;stroke-dashoffset:-6}',
    '100%{stroke-dasharray:12 150;stroke-dashoffset:0}}',
    '@media (prefers-reduced-motion:reduce){.dsu-spin,.dsu-spin .dsu-arc{animation:none}',
    '.dsu-spin .dsu-arc{stroke-dasharray:18 150;stroke-dashoffset:-3}}',

    // Inline status text: 13/20, like the page's own secondary lines.
    '.dsu-note{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
    '.dsu-note-error{color:var(--dsw-alias-state-error-primary)}',

    // The run summary, under the header so it never covers the list.
    '.dsu-summary{display:flex;align-items:center;gap:10px;margin:0;font-size:13px;line-height:20px;',
    'color:var(--dsw-alias-label-secondary)}',
    '.dsu-summary-error{color:var(--dsw-alias-state-error-primary)}',
    '.dsu-summary-warn{color:var(--dsw-alias-state-warn-primary)}',

    /* ---------------------------------------------------------- dialog -- */

    // The overlay, the card and its elevation follow the host's own Modal
    // (`Modal.module.css`): a viewport-covering layer whose mask paints
    // `--dsw-alias-bg-mask-1` — a 24%-alpha black, which is what a scrim is — and a
    // layer-2 surface raised by the prominent elevation with the panel radius.
    //
    // The mask token matters. `--dsw-alias-bg-overlay` is the *surface* colour a
    // popover paints itself with, and it is opaque; using it here covers the whole
    // window in a solid sheet instead of dimming what is behind the dialog.
    '.dsu-scrim{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;',
    'padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px;',
    'background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24));backdrop-filter:var(--dsw-mask-blur,none)}',
    '.dsu-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;',
    'width:100%;max-width:560px;max-height:min(640px,calc(100vh - 48px));',
    'border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);',
    'box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);overflow:hidden;',
    'animation:dsu-enter var(--ds-transition-duration,160ms) var(--ds-ease-in-out,ease)}',
    '@keyframes dsu-enter{from{opacity:0}to{opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.dsu-dialog{animation:none}}',
    '.dsu-dialog:focus{outline:none}',
    '.dsu-dialog-head{display:flex;align-items:flex-start;gap:12px;padding:20px 14px 10px 24px}',
    '.dsu-dialog-title{margin:0;font-size:16px;font-weight:500;line-height:24px;flex:1;min-width:0}',
    '.dsu-dialog-sub{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);',
    'font-family:var(--dsw-font-mono,ui-monospace,monospace);word-break:break-all}',
    '.dsu-close{flex:none;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);',
    'background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;',
    'display:inline-flex;align-items:center;justify-content:center}',
    '.dsu-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.dsu-close:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',

    // The table scrolls on its own so a long history never grows the dialog past
    // the viewport, and its header stays pinned while it does.
    '.dsu-table-wrap{flex:1;min-height:0;overflow:auto;padding:0 14px 8px 24px}',
    '.dsu-table{width:100%;border-collapse:collapse;font-size:13px;line-height:20px}',
    '.dsu-table th{position:sticky;top:0;z-index:1;text-align:left;font-weight:500;font-size:12px;',
    'color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);',
    'padding:8px 8px 6px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
    '.dsu-table td{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}',
    '.dsu-table tr:last-child td{border-bottom:none}',
    '.dsu-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.dsu-col-action{width:88px;text-align:right}',
    '.dsu-version{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums}',
    '.dsu-range{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;',
    'color:var(--dsw-alias-label-tertiary);word-break:break-all}',
    '.dsu-range-warn{color:var(--dsw-alias-state-warn-primary)}',
    '.dsu-row-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}',
    '.dsu-row-note-warn{color:var(--dsw-alias-state-warn-primary)}',
    '.dsu-muted{color:var(--dsw-alias-label-caption)}',

    // Status and footer.
    '.dsu-dialog-foot{display:flex;align-items:center;gap:10px;padding:12px 24px 18px;',
    'border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px;',
    'color:var(--dsw-alias-label-tertiary)}',
    '.dsu-dialog-status{flex:1;min-width:0}',
    '.dsu-dialog-error{color:var(--dsw-alias-state-error-primary)}',
    '.dsu-empty{padding:24px;text-align:center;font-size:13px;line-height:20px;',
    'color:var(--dsw-alias-label-tertiary)}',
    '.dsu-loading{display:flex;align-items:center;justify-content:center;gap:8px;padding:32px 24px;',
    'font-size:13px;color:var(--dsw-alias-label-tertiary)}',
  ].join('')

  /* ----------------------------------------------------------------- icons -- */

  /** An inline SVG from one path, at the inline size the page's own icons use. */
  function icon(size, path) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    node.setAttribute('width', String(size))
    node.setAttribute('height', String(size))
    node.setAttribute('viewBox', '0 0 14 14')
    node.setAttribute('fill', 'none')
    node.setAttribute('aria-hidden', 'true')
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    shape.setAttribute('d', path)
    shape.setAttribute('fill', 'currentColor')
    node.appendChild(shape)
    return node
  }

  /** The refresh glyph. */
  const iconRefresh = (size) =>
    icon(size ?? 14, 'M7 1.6a5.4 5.4 0 0 1 4.8 2.8l.4-1.4.9.3-.9 2.9a.5.5 0 0 1-.6.3l-2.9-.8.3-.9 1.7.5A4.4 4.4 0 1 0 11.4 7h1a5.4 5.4 0 1 1-5.4-5.4Z')

  /** A downward arrow into a tray: the update glyph. */
  const iconUpdate = (size) =>
    icon(size ?? 14, 'M6.5 1.5v6.1L4.4 5.5l-.7.7L7 9.4l3.3-3.2-.7-.7-2.1 2.1V1.5h-1ZM2.5 9v2.2c0 .4.3.7.7.7h7.6c.4 0 .7-.3.7-.7V9h-1v2H3.5V9h-1Z')

  /** A clock with a returning arrow: the version-history glyph. */
  const iconHistory = (size) =>
    icon(
      size ?? 13,
      'M7 2.2a4.8 4.8 0 1 1-4.6 3.4H1.2l1.9-2.6 1.9 2.6H3.9A3.8 3.8 0 1 0 7 3.2v-1ZM6.6 4.3v3.1l2.3 1.4.5-.8-1.8-1.1V4.3h-1Z',
    )

  /** A cross: the dialog's close control. */
  const iconClose = (size) =>
    icon(size ?? 14, 'M3.4 2.6 2.6 3.4 6.2 7l-3.6 3.6.8.8L7 7.8l3.6 3.6.8-.8L7.8 7l3.6-3.6-.8-.8L7 6.2 3.4 2.6Z')

  /**
   * The same glyphs as React elements, for the one control React renders.
   *
   * The injected controls above are DOM, so their icons are DOM; the detail-page
   * control is a React element, and React cannot render a raw DOM node passed as a
   * child — it throws, the slot's error boundary swallows the entry, and the control
   * silently disappears. The two builders therefore exist side by side rather than
   * one being reused for both.
   * @param size - square pixel size.
   * @param path - the path data.
   * @returns a React element for the icon.
   */
  const iconElement = (size, path) =>
    createElement(
      'svg',
      { width: size, height: size, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
      createElement('path', { d: path, fill: 'currentColor' }),
    )

  /** The version-history glyph as a React element. */
  const iconHistoryElement = (size) =>
    iconElement(
      size ?? 13,
      'M7 2.2a4.8 4.8 0 1 1-4.6 3.4H1.2l1.9-2.6 1.9 2.6H3.9A3.8 3.8 0 1 0 7 3.2v-1ZM6.6 4.3v3.1l2.3 1.4.5-.8-1.8-1.1V4.3h-1Z',
    )

  /** The host's ongoing spinner, rebuilt from its published geometry. */
  function spinner(size) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    node.setAttribute('width', String(size ?? 14))
    node.setAttribute('height', String(size ?? 14))
    node.setAttribute('viewBox', '0 0 24 24')
    node.setAttribute('class', 'dsu-spin')
    node.setAttribute('aria-hidden', 'true')
    for (const cls of ['dsu-track', 'dsu-arc']) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      circle.setAttribute('class', cls)
      circle.setAttribute('cx', '12')
      circle.setAttribute('cy', '12')
      circle.setAttribute('r', '9')
      node.appendChild(circle)
    }
    return node
  }

  /* ----------------------------------------------------------------- state -- */

  /**
   * Everything the injected controls render from, so a check result, an in-flight
   * update and a finished run can never disagree with one another.
   */
  function createStore() {
    return {
      /** name → one route result. */
      checks: new Map(),
      /** Whether a check batch is running. */
      checking: false,
      /** The package being updated right now. */
      updating: null,
      /** The last finished update, for that card's settled state. */
      lastResult: null,
      /** The batch summary shown under the header. */
      summary: null,
      /**
       * The running DSH version, so a version row can say whether it covers this one.
       *
       * Read from the boot payload the shell already publishes rather than asked of
       * the Host: it is a fact about the page's own runtime, and a lookup would have
       * to exist only for a warning.
       */
      runtime: runtimeVersion(),
      /** How many updates the last check found. */
      count() {
        let total = 0
        for (const row of this.checks.values()) if (row.outcome === 'update') total += 1
        return total
      },
      /** The update targets, keyed by name, for a batch request. */
      targets() {
        const out = {}
        for (const [name, row] of this.checks) if (row.outcome === 'update') out[name] = row.latest
        return out
      },
    }
  }

  /**
   * The running DSH version, read from the boot payload the shell publishes.
   * @returns the version, or undefined when the page does not carry one.
   */
  function runtimeVersion() {
    const boot = window.__DSH_BOOT__
    if (boot === undefined || boot === null) return undefined
    for (const candidate of [boot.version, boot.hostVersion, boot.runtime?.version, boot.dsh?.version]) {
      if (typeof candidate === 'string' && candidate !== '') return candidate
    }
    return undefined
  }

  /* -------------------------------------------------------------- requests -- */

  /**
   * Call one updater route.
   * @param path - the route path under the prefix.
   * @param options - HTTP method and JSON body.
   * @returns the parsed answer.
   * @throws {Error} when the route refused the call.
   */
  async function call(path, options) {
    const settings = options ?? {}
    const response = await fetch(`${API}${path}`, {
      method: settings.method ?? 'GET',
      headers: settings.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
      credentials: 'same-origin',
    })
    const text = await response.text()
    let payload
    try {
      payload = text === '' ? null : JSON.parse(text)
    } catch {
      throw new Error(`${t('failedGeneric')} (${String(response.status)})`)
    }
    if (!response.ok) throw new Error(payload?.reason ?? payload?.error ?? t('failedGeneric'))
    return payload
  }

  /* ------------------------------------------------------------------ i18n -- */

  let t = (key, params) => interpolate(UPDATER_EN[key] ?? key, params)

  /** Substitute `{name}` placeholders. */
  function interpolate(text, params) {
    if (params === undefined) return text
    return String(text).replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match))
  }

  /* --------------------------------------------------------------- markup --- */

  /**
   * Build one control with the host's own geometry.
   * @param options - label, variant, icon, and click handler.
   * @returns the button element.
   */
  function button(options) {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = `dsu-btn ${options.variant ?? 'dsu-outline'}`
    node.setAttribute(OWNED, '1')
    if (options.label !== undefined) node.appendChild(document.createTextNode(options.label))
    if (options.icon !== undefined) node.appendChild(options.icon)
    if (options.title !== undefined) node.title = options.title
    if (options.ariaLabel !== undefined) node.setAttribute('aria-label', options.ariaLabel)
    if (options.disabled === true) node.disabled = true
    if (typeof options.onClick === 'function') node.addEventListener('click', options.onClick)
    return node
  }

  /** A capsule carrying a short state. */
  function tag(text, tone, title) {
    const node = document.createElement('span')
    node.className = `dsu-tag${tone === undefined ? '' : ` ${tone}`}`
    node.setAttribute(OWNED, '1')
    node.appendChild(document.createTextNode(text))
    if (title !== undefined) node.title = title
    return node
  }

  /** An inline status line. */
  function note(text, tone) {
    const node = document.createElement('span')
    node.className = `dsu-note${tone === undefined ? '' : ` ${tone}`}`
    node.setAttribute(OWNED, '1')
    node.appendChild(document.createTextNode(text))
    return node
  }

  /**
   * Replace a control's contents without replacing the node.
   *
   * Replacing it would drop focus and re-trigger the observer for no reason.
   */
  function refill(node, label, icon) {
    while (node.firstChild !== null) node.removeChild(node.firstChild)
    if (label !== undefined) node.appendChild(document.createTextNode(label))
    if (icon !== undefined) node.appendChild(icon)
  }

  /* ----------------------------------------------------------------- wiring -- */

  const store = createStore()

  /** The Plugins page root, or null while it is not mounted. */
  const panel = () => document.querySelector('section[data-plugin-panel]')

  /** The toolbar's control row: the page header's trailing cell. */
  function toolbar(page) {
    const header = page.querySelector('header')
    if (header === null || header.children.length < 2) return null
    return header.lastElementChild
  }

  /** One card's trailing cell, found through the switch it already contains. */
  function cardCell(card) {
    const toggle = card.querySelector('button[role="switch"]')
    return toggle === null ? null : toggle.parentElement
  }

  /** The host's last real control in a row, which the injected controls precede. */
  function lastHostChild(row) {
    const children = Array.from(row.children).filter((child) => !child.hasAttribute(OWNED))
    return children.length === 0 ? null : children[children.length - 1]
  }

  /* ------------------------------------------------------------- tool bar -- */

  let checkButton = null
  let updateAllButton = null
  let summaryLine = null

  /** Bring the toolbar controls in line with the store. */
  function renderToolbar(page) {
    const row = toolbar(page)
    if (row === null) return
    if (checkButton === null || !checkButton.isConnected) {
      checkButton = button({ variant: 'dsu-outline', ariaLabel: t('check'), onClick: () => void runCheck() })
      row.insertBefore(checkButton, lastHostChild(row))
    }
    if (updateAllButton === null || !updateAllButton.isConnected) {
      updateAllButton = button({ variant: 'dsu-primary', ariaLabel: t('updateAll'), onClick: () => void runUpdateAll() })
      row.insertBefore(updateAllButton, lastHostChild(row))
    }
    // A host re-render that reorders the row would otherwise leave the controls
    // behind the add button; only move them when they actually moved.
    if (checkButton.nextElementSibling !== updateAllButton) row.insertBefore(checkButton, updateAllButton)

    // The client writes to the DOM from the observer that watches it, so each of
    // these updates is guarded: an identical write would re-enter the observer.
    const checkLabel = store.checking ? t('checking') : t('check')
    if (checkButton.getAttribute('data-plugin-updater-label') !== checkLabel) {
      checkButton.setAttribute('data-plugin-updater-label', checkLabel)
      refill(checkButton, checkLabel, store.checking ? spinner(14) : iconRefresh(14))
    }
    checkButton.disabled = store.checking

    const count = store.count()
    const busy = store.updating !== null
    const showAll = count > 0 || busy
    const allLabel = busy ? t('updating') : count > 0 ? t('updateAllCount', { count }) : t('updateAll')
    const signature = `${allLabel}|${busy ? '1' : '0'}|${showAll ? '1' : '0'}`
    if (updateAllButton.getAttribute('data-plugin-updater-state') !== signature) {
      updateAllButton.setAttribute('data-plugin-updater-state', signature)
      updateAllButton.hidden = !showAll
      updateAllButton.disabled = busy || count === 0
      refill(updateAllButton, allLabel, busy ? spinner(14) : undefined)
    }

    renderSummary(page)
  }

  /** The batch summary, one row under the header. */
  function renderSummary(page) {
    const summary = store.summary
    if (summary === null) {
      if (summaryLine !== null && summaryLine.parentElement !== null) summaryLine.remove()
      return
    }
    // Keyed on the message itself, so the same summary never re-writes its own
    // text — which the observer would see as a fresh mutation.
    const signature = `${summary.updated}|${summary.failed}|${summary.restart ? 1 : 0}|${summary.message ?? ''}`
    if (summaryLine !== null && summaryLine.parentElement !== null && summaryLine.getAttribute('data-plugin-updater-state') === signature) return

    if (summaryLine === null || summaryLine.parentElement === null) {
      summaryLine = document.createElement('div')
      summaryLine.setAttribute(OWNED, '1')
      summaryLine.setAttribute('role', 'status')
      summaryLine.setAttribute('aria-live', 'polite')
      const header = page.querySelector('header')
      // The summary belongs to the page, not the toolbar row: placing it directly
      // under the header keeps the list below it from moving.
      if (header !== null) page.insertBefore(summaryLine, header.nextSibling)
      else page.prepend(summaryLine)
    }
    summaryLine.setAttribute('data-plugin-updater-state', signature)
    summaryLine.className = `dsu-summary${summary.failed > 0 ? ' dsu-summary-error' : summary.restart ? ' dsu-summary-warn' : ''}`
    while (summaryLine.firstChild !== null) summaryLine.removeChild(summaryLine.firstChild)

    const parts = []
    if (summary.updated > 0) parts.push(t('summaryOk', { count: summary.updated }))
    if (summary.failed > 0) parts.push(t('summaryFailed', { count: summary.failed }))
    // Only a profile without HMR needs a restart, and only then is it said.
    if (summary.updated > 0 && summary.restart) parts.push(t('restartSummary', { count: summary.updated }))
    if (parts.length === 0 && summary.message !== undefined) parts.push(summary.message)
    summaryLine.appendChild(document.createTextNode(parts.join(' ')))

    summaryLine.appendChild(
      button({
        variant: 'dsu-ghost dsu-link',
        label: t('dismiss'),
        onClick: () => {
          store.summary = null
          render()
        },
      }),
    )
  }

  /* ----------------------------------------------------------------- card -- */

  /**
   * Bring one card's controls in line with the store.
   *
   * A card with nothing to report gets nothing at all — no placeholder, no disabled
   * button. That is what leaves the official bundles and every up-to-date plugin
   * looking exactly as they did.
   *
   * The function must be free of DOM writes when the rendered result would not
   * change: it runs from the observer that watches these very writes, so an
   * unnecessary `remove()` or `insertBefore()` would re-enter it forever.
   * @param card - one `li[data-plugin-package]` element.
   */
  function renderCard(card) {
    const name = card.getAttribute('data-plugin-package')
    if (name === null) return

    let row = null
    for (const child of card.querySelectorAll(`[${OWNED}="card"]`)) {
      if (child.getAttribute('data-plugin-updater-for') === name) {
        row = child
        break
      }
    }

    const signature = cardSignature(name)
    // Unchanged since the last render: leave the DOM strictly alone.
    if (row !== null && row.getAttribute('data-plugin-updater-state') === signature) return

    const cell = cardCell(card)
    if (cell === null) {
      if (row !== null && row.parentElement !== null) row.remove()
      return
    }

    if (signature === 'none') {
      if (row !== null && row.parentElement !== null) row.remove()
      return
    }

    if (row === null) {
      row = document.createElement('span')
      row.className = 'dsu-card-row'
      row.setAttribute(OWNED, 'card')
      row.setAttribute('data-plugin-updater-for', name)
      // The switch is this cell's only host child; inserting immediately before it
      // is what places the update control to its left.
      cell.insertBefore(row, card.querySelector('button[role="switch"]'))
    } else if (row.parentElement !== cell) {
      // React re-created the cell: put the same node back rather than make a new one.
      cell.insertBefore(row, card.querySelector('button[role="switch"]'))
    }
    row.setAttribute('data-plugin-updater-state', signature)

    while (row.firstChild !== null) row.removeChild(row.firstChild)
    fillCard(row, name, card)
  }

  /**
   * A string that changes exactly when a card's rendered result would.
   * @param name - the package name.
   * @returns the signature, or `'none'` when the card shows nothing.
   */
  function cardSignature(name) {
    if (store.updating === name) return 'updating'
    const result = store.lastResult !== null && store.lastResult.name === name ? store.lastResult : null
    if (result !== null && result.status === 'failed') {
      return `failed:${result.failure?.code ?? ''}:${result.target ?? ''}:${result.repaired?.status ?? ''}`
    }
    if (result !== null && result.status === 'updated') return `done:${result.to ?? ''}`
    if (result !== null && result.status === 'restart-required') return `restart:${result.to ?? ''}`
    const check = store.checks.get(name)
    if (check !== undefined && check.outcome === 'update') return `update:${check.installed}->${check.latest}`
    return 'none'
  }

  /**
   * Fill a card's row for the state its signature named.
   * @param row - the row element, already detached from its contents.
   * @param name - the package name.
   * @param card - the card, for the title a control may read.
   */
  function fillCard(row, name, card) {
    const check = store.checks.get(name)
    const result = store.lastResult !== null && store.lastResult.name === name ? store.lastResult : null

    if (store.updating === name) {
      row.appendChild(spinner(16))
      row.appendChild(note(t('updating')))
      return
    }

    if (result !== null && result.status === 'failed') {
      row.appendChild(
        button({
          variant: 'dsu-outline dsu-danger',
          label: t('retry'),
          title: failureText(result.failure),
          onClick: () => void runUpdate(name, result.target ?? check?.latest),
        }),
      )
      row.appendChild(note(shortFailure(result.failure), 'dsu-note-error'))
      if (result.repaired !== undefined) {
        row.appendChild(note(t(result.repaired.status === 'restored' ? 'repaired' : 'repairFailed')))
      }
      return
    }

    if (result !== null && result.status === 'updated') {
      // Live: the running tree already holds the new code, so the card reports the
      // version alone and never asks for a restart.
      row.appendChild(tag(t('updatedTo', { version: result.to ?? '' }), 'dsu-tag-success'))
      return
    }

    if (result !== null && result.status === 'restart-required') {
      // No HMR on this profile: the files are new but the running tree is not.
      row.appendChild(tag(t('updated'), 'dsu-tag-success'))
      row.appendChild(note(t('restartNotice', { version: result.to ?? '' })))
      return
    }

    if (check !== undefined && check.outcome === 'update') {
      row.appendChild(tag(t('versionFrom', { from: check.installed, to: check.latest })))
      const target = check.latest
      row.appendChild(
        button({
          variant: 'dsu-outline',
          label: t('update'),
          icon: iconUpdate(13),
          ariaLabel: t('updateOne', { name }),
          onClick: () => void runUpdate(name, target),
        }),
      )
    }
  }

  /** One short line describing a failure. */
  function shortFailure(failure) {
    switch (failure?.code) {
      case 'incompatible-version':
        return t('failedIncompatible', { name: failure.incompatible?.[0]?.name ?? '' })
      case 'build-blocked':
        return t('failedBuildBlocked', { packages: (failure.pendingBuilds ?? []).join(', ') })
      case 'not-applied':
        return t('failedNotApplied')
      case 'not-newer':
        return t('failedNotNewer')
      case 'ahead-of-registry':
        return t('failedAhead')
      case 'unknown-package':
        return t('failedUnknownPackage')
      case 'not-registry':
        return t('failedNotRegistry')
      case 'builtin':
      case 'optional':
        return t('failedBuiltin')
      case 'busy':
        return t('busy')
      default:
        return t('failedGeneric')
    }
  }

  /** The fuller text a failed card's tooltip carries. */
  function failureText(failure) {
    const lines = [shortFailure(failure)]
    if (failure?.code === 'incompatible-version' && Array.isArray(failure.incompatible)) {
      const peers = []
      for (const entry of failure.incompatible) {
        for (const peer of Object.entries(entry?.unsatisfiedPeers ?? {})) peers.push(`${peer[0]} ${String(peer[1])}`)
      }
      if (peers.length > 0) lines.push(t('failedIncompatiblePeers', { peers: peers.join(', ') }))
    }
    if (typeof failure?.diagnostic === 'string' && failure.diagnostic !== '') lines.push(failure.diagnostic)
    return lines.join('\n')
  }

  /* --------------------------------------------------------------- render -- */

  /** Redraw everything currently on the page. */
  function render() {
    const page = panel()
    if (page === null) return
    renderToolbar(page)
    for (const card of page.querySelectorAll('li[data-plugin-package]')) renderCard(card)
  }

  /* ----------------------------------------------------------------- work -- */

  /** Run one check batch. */
  async function runCheck() {
    if (store.checking) return
    store.checking = true
    store.summary = null
    render()
    try {
      const answer = await call('/check')
      store.checks = new Map()
      for (const row of Array.isArray(answer?.results) ? answer.results : []) {
        if (typeof row?.name === 'string') store.checks.set(row.name, row)
      }
      const count = store.count()
      store.summary = { updated: 0, failed: 0, restart: false, message: t(count > 0 ? 'foundCount' : 'allCurrent', { count }) }
    } catch (error) {
      store.summary = {
        updated: 0,
        failed: 0,
        restart: false,
        message: `${t('checkFailed')} ${String(error?.message ?? error)}`,
      }
    } finally {
      store.checking = false
      render()
    }
  }

  /** Update one package. */
  async function runUpdate(name, target) {
    if (store.updating !== null) return
    if (typeof target !== 'string' || target === '') return
    store.updating = name
    store.lastResult = null
    store.summary = null
    render()
    try {
      const result = await call('/update', { method: 'POST', body: { name, target } })
      store.lastResult = result
      const done = settle(result, name)
      store.summary = { updated: done ? 1 : 0, failed: done ? 0 : 1, restart: result?.status === 'restart-required' }
    } catch (error) {
      store.lastResult = {
        name,
        target,
        status: 'failed',
        failure: { code: 'unexpected', diagnostic: String(error?.message ?? error) },
      }
      store.summary = { updated: 0, failed: 1, restart: false }
    } finally {
      store.updating = null
      render()
    }
  }

  /**
   * Fold one route answer into the store.
   * @param result - the answer, or undefined.
   * @param name - the package it concerns.
   * @returns whether the update succeeded, whether or not it needed a restart.
   */
  function settle(result, name) {
    // `updated` means the new code is already running; `restart-required` means the
    // files are new but this profile has no hot reload. Both are successes.
    if (result?.status === 'updated' || result?.status === 'restart-required') {
      // The version on disk moved, so the row that advertised the update is stale.
      store.checks.delete(name)
      return true
    }
    return false
  }

  /** Update every package the last check found, continuing past failures. */
  async function runUpdateAll() {
    if (store.updating !== null) return
    const targets = store.targets()
    const names = Object.keys(targets)
    if (names.length === 0) return
    let updated = 0
    let failed = 0
    let restart = false
    store.summary = null
    for (const name of names) {
      store.updating = name
      render()
      try {
        const result = await call('/update', { method: 'POST', body: { name, target: targets[name] } })
        store.lastResult = result
        if (settle(result, name)) {
          updated += 1
          if (result?.status === 'restart-required') restart = true
        } else {
          failed += 1
        }
      } catch (error) {
        failed += 1
        store.lastResult = {
          name,
          target: targets[name],
          status: 'failed',
          failure: { code: 'unexpected', diagnostic: String(error?.message ?? error) },
        }
      }
      store.summary = { updated, failed, restart }
      render()
    }
    store.updating = null
    store.summary = { updated, failed, restart }
    render()
  }

  /* --------------------------------------------------------------- dialog -- */

  /**
   * The version-history dialog's own state.
   *
   * Separate from the page store because the dialog is transient: it holds one
   * package's history, which row is installing, and why it could not load.
   */
  const dialog = {
    /** The package name the dialog is about, or null when it is closed. */
    name: null,
    /** Whether the history is still being read. */
    loading: false,
    /** The rows, once read. */
    rows: [],
    /** The source answer: registry, github or local. */
    source: undefined,
    /** The repository a github source names. */
    repo: undefined,
    /** The version installed now. */
    current: undefined,
    /** Whether the rows carry a compatibility range at all. */
    rangeKnown: false,
    /** Why the history could not be read. */
    problem: undefined,
    /** The version installing right now, if any. */
    installing: null,
    /** The last install's outcome, shown in the footer. */
    outcome: null,
  }

  /** The dialog's root element, kept across renders so focus is never dropped. */
  let dialogRoot = null

  /** Open the version dialog for one package. */
  async function openVersions(name) {
    dialog.name = name
    dialog.loading = true
    dialog.rows = []
    dialog.problem = undefined
    dialog.outcome = null
    dialog.installing = null
    renderDialog()
    await loadVersions(name)
  }

  /** Read one package's history into the dialog. */
  async function loadVersions(name) {
    try {
      const answer = await call(`/versions?name=${encodeURIComponent(name)}`)
      // A different package was opened while this was in flight: drop the answer.
      if (dialog.name !== name) return
      dialog.rows = Array.isArray(answer?.versions) ? answer.versions : []
      dialog.source = answer?.source
      dialog.repo = answer?.repo
      dialog.current = answer?.current
      dialog.rangeKnown = answer?.rangeKnown === true
      dialog.problem = answer?.problem
    } catch (error) {
      if (dialog.name !== name) return
      dialog.problem = String(error?.message ?? error)
    } finally {
      if (dialog.name === name) {
        dialog.loading = false
        renderDialog()
      }
    }
  }

  /** Close the dialog and forget its state. */
  function closeVersions() {
    dialog.name = null
    dialog.rows = []
    dialog.problem = undefined
    dialog.outcome = null
    if (dialogRoot !== null && dialogRoot.parentElement !== null) dialogRoot.remove()
    dialogRoot = null
    // The list behind the dialog may now be stale.
    render()
  }

  /**
   * Whether one row's declared range covers the running DSH version.
   *
   * The comparison is deliberately coarse. Resolving a full semver range host-side
   * would mean shipping a range parser for a warning that must never block an
   * install, so a row is flagged only when its range plainly names another line.
   * @param range - the version's declared range.
   * @param runtime - the running DSH version.
   * @returns true, false, or undefined when it cannot be told.
   */
  function rangeCovers(range, runtime) {
    if (typeof range !== 'string' || range === '' || typeof runtime !== 'string' || runtime === '') return undefined
    // Every comparator in the range is checked for a bare literal that differs from
    // the runtime's own major.minor line; that catches the common `>=0.1.5-rc.2` /
    // `<0.2.0-0` pair without pretending to be a resolver.
    const literals = range.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g)
    if (literals === null || literals.length === 0) return undefined
    const line = (value) => value.split('.').slice(0, 2).join('.')
    const ours = line(runtime)
    return literals.some((literal) => line(literal) === ours)
  }

  /**
   * Render the dialog, creating it on first use.
   *
   * Every interaction re-renders through this function rather than mutating the DOM
   * in place, because the dialog is small and transient; only the root element is
   * kept, so re-rendering never steals focus from the dialog itself.
   */
  function renderDialog() {
    if (dialog.name === null) return
    const name = dialog.name

    if (dialogRoot === null || !dialogRoot.isConnected) {
      dialogRoot = document.createElement('div')
      dialogRoot.className = 'dsu-scrim'
      dialogRoot.setAttribute(OWNED, 'dialog')
      // Clicking the scrim closes; clicking the card must not.
      dialogRoot.addEventListener('mousedown', (event) => {
        if (event.target === dialogRoot) closeVersions()
      })
      document.body.appendChild(dialogRoot)
      // Escape closes from anywhere inside, including after focus moves.
      dialogRoot.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          closeVersions()
        }
      })
    }
    while (dialogRoot.firstChild !== null) dialogRoot.removeChild(dialogRoot.firstChild)

    const card = document.createElement('div')
    card.className = 'dsu-dialog'
    card.setAttribute(OWNED, 'dialog-card')
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-modal', 'true')
    card.setAttribute('aria-label', t('historyTitle', { name }))
    card.tabIndex = -1
    dialogRoot.appendChild(card)

    // Head.
    const head = document.createElement('div')
    head.className = 'dsu-dialog-head'
    const headText = document.createElement('div')
    headText.style.flex = '1'
    headText.style.minWidth = '0'
    const title = document.createElement('h2')
    title.className = 'dsu-dialog-title'
    title.appendChild(document.createTextNode(t('history')))
    headText.appendChild(title)
    const sub = document.createElement('p')
    sub.className = 'dsu-dialog-sub'
    sub.appendChild(document.createTextNode(name))
    headText.appendChild(sub)
    head.appendChild(headText)
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'dsu-close'
    close.setAttribute(OWNED, 'dialog-close')
    close.setAttribute('aria-label', t('historyClose'))
    close.title = t('historyClose')
    close.appendChild(iconClose(14))
    close.addEventListener('click', closeVersions)
    head.appendChild(close)
    card.appendChild(head)

    // Body.
    if (dialog.loading) {
      const loading = document.createElement('div')
      loading.className = 'dsu-loading'
      loading.setAttribute('role', 'status')
      loading.appendChild(spinner(16))
      loading.appendChild(document.createTextNode(t('historyLoading')))
      card.appendChild(loading)
    } else if (dialog.problem !== undefined && dialog.rows.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'dsu-empty'
      empty.setAttribute('role', 'alert')
      empty.appendChild(document.createTextNode(problemText(dialog.problem)))
      card.appendChild(empty)
    } else if (dialog.rows.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'dsu-empty'
      empty.appendChild(document.createTextNode(t('historyEmpty')))
      card.appendChild(empty)
    } else {
      card.appendChild(versionTable(name))
    }

    // Foot.
    const foot = document.createElement('div')
    foot.className = 'dsu-dialog-foot'
    const status = document.createElement('span')
    status.className = 'dsu-dialog-status'
    if (dialog.outcome !== null) {
      status.className = `dsu-dialog-status ${dialog.outcome.ok ? '' : 'dsu-dialog-error'}`
      status.setAttribute('role', dialog.outcome.ok ? 'status' : 'alert')
      status.appendChild(document.createTextNode(dialog.outcome.text))
    }
    foot.appendChild(status)
    if (dialog.rangeKnown && dialog.rows.length > 0) {
      const note = document.createElement('span')
      note.className = 'dsu-muted'
      note.appendChild(document.createTextNode(t('historyRangeNote')))
      foot.appendChild(note)
    }
    card.appendChild(foot)

    card.focus()
    // The first installable row is what a keyboard user most likely wants next.
    const first = card.querySelector('button[data-dsu-install]:not([disabled])')
    if (first !== null && dialog.outcome === null) first.focus()
  }

  /** One problem code as a sentence. */
  function problemText(problem) {
    switch (problem) {
      case 'unknown-package':
        return t('failedUnknownPackage')
      case 'local-source':
        return t('historyLocal')
      case 'rate-limited':
        return t('historyRateLimited')
      case 'not-found':
        return t('failedNotFound')
      case 'network':
        return t('failedNetwork')
      default:
        return t('failedGeneric')
    }
  }

  /** The version table. */
  function versionTable(name) {
    const wrap = document.createElement('div')
    wrap.className = 'dsu-table-wrap'
    const table = document.createElement('table')
    table.className = 'dsu-table'
    table.setAttribute(OWNED, 'dialog-table')

    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    for (const [key, cls] of [
      ['historyColVersion', ''],
      ['historyColRange', ''],
      ['historyColAction', 'dsu-col-action'],
    ]) {
      const th = document.createElement('th')
      if (cls !== '') th.className = cls
      th.setAttribute('scope', 'col')
      th.appendChild(document.createTextNode(t(key)))
      headRow.appendChild(th)
    }
    thead.appendChild(headRow)
    table.appendChild(thead)

    const body = document.createElement('tbody')
    for (const row of dialog.rows) {
      body.appendChild(versionRow(name, row))
    }
    table.appendChild(body)
    wrap.appendChild(table)
    return wrap
  }

  /** One version row: the version, its declared range, and the install control. */
  function versionRow(name, row) {
    const tr = document.createElement('tr')
    tr.setAttribute(OWNED, 'dialog-row')
    if (row.isCurrent === true) tr.setAttribute('data-dsu-current', '1')

    // Version, with the badges that qualify it.
    const versionCell = document.createElement('td')
    const version = document.createElement('span')
    version.className = 'dsu-version'
    version.appendChild(document.createTextNode(row.version))
    versionCell.appendChild(version)
    if (row.isCurrent === true) {
      versionCell.appendChild(document.createTextNode(' '))
      versionCell.appendChild(tag(t('historyCurrent'), 'dsu-tag-success'))
    } else if (row.latest === true) {
      versionCell.appendChild(document.createTextNode(' '))
      versionCell.appendChild(tag(t('historyLatest')))
    }
    if (typeof row.subject === 'string' && row.subject !== '') {
      const subject = document.createElement('span')
      subject.className = 'dsu-row-note'
      subject.style.display = 'block'
      subject.appendChild(document.createTextNode(row.subject))
      versionCell.appendChild(subject)
    }
    tr.appendChild(versionCell)

    // The declared compatibility, and only a warning when it plainly differs.
    const rangeCell = document.createElement('td')
    const covers = rangeCovers(row.dshRange, store.runtime)
    if (dialog.rangeKnown !== true) {
      const muted = document.createElement('span')
      muted.className = 'dsu-muted'
      muted.appendChild(document.createTextNode(t('historyRangeUnknown')))
      rangeCell.appendChild(muted)
    } else if (typeof row.dshRange !== 'string' || row.dshRange === '') {
      const muted = document.createElement('span')
      muted.className = 'dsu-muted'
      muted.appendChild(document.createTextNode(t('historyRangeMissing')))
      rangeCell.appendChild(muted)
    } else {
      const range = document.createElement('span')
      range.className = `dsu-range${covers === false ? ' dsu-range-warn' : ''}`
      range.appendChild(document.createTextNode(row.dshRange))
      rangeCell.appendChild(range)
      if (covers === false) {
        const warn = document.createElement('span')
        warn.className = 'dsu-row-note dsu-row-note-warn'
        warn.style.display = 'block'
        warn.appendChild(document.createTextNode(t('historyRangeOther')))
        rangeCell.appendChild(warn)
      }
    }
    tr.appendChild(rangeCell)

    // The install control.
    const actionCell = document.createElement('td')
    actionCell.className = 'dsu-col-action'
    const installing = dialog.installing !== null && dialog.installing === row.version
    const busy = dialog.installing !== null
    if (row.isCurrent === true) {
      const installed = document.createElement('span')
      installed.className = 'dsu-muted'
      installed.appendChild(document.createTextNode(t('historyCurrent')))
      actionCell.appendChild(installed)
    } else {
      const install = button({
        variant: 'dsu-outline',
        label: installing ? t('historyInstalling') : t('historyInstall'),
        icon: installing ? spinner(13) : undefined,
        disabled: busy,
        ariaLabel: `${t('historyInstall')} ${row.version}`,
        onClick: () => void runInstall(name, row),
      })
      install.setAttribute('data-dsu-install', '1')
      actionCell.appendChild(install)
    }
    tr.appendChild(actionCell)
    return tr
  }

  /** Install one version from the dialog. */
  async function runInstall(name, row) {
    if (dialog.installing !== null) return
    dialog.installing = row.version
    dialog.outcome = null
    renderDialog()
    try {
      const result = await call('/install', { method: 'POST', body: { name, version: row.version } })
      if (dialog.name !== name) return
      if (result?.status === 'updated' || result?.status === 'restart-required') {
        // The list behind the dialog is stale now; the card owns the outcome.
        store.checks.delete(name)
        store.lastResult = result
        store.summary = { updated: 1, failed: 0, restart: result.status === 'restart-required' }
        dialog.installing = null
        closeVersions()
        return
      }
      dialog.installing = null
      dialog.outcome = { ok: false, text: shortFailure(result?.failure) }
    } catch (error) {
      if (dialog.name !== name) return
      dialog.installing = null
      dialog.outcome = { ok: false, text: String(error?.message ?? error) }
    }
    renderDialog()
  }

  /* -------------------------------------------------------------- observer -- */

  /**
   * Re-attach after every render, from one observer that never detaches.
   *
   * The page does not merely re-render its cards: leaving the Plugins panel and
   * coming back — or flipping the theme, which re-renders the whole shell — replaces
   * the `section[data-plugin-panel]` element itself. An observer bound to the old
   * element would watch a detached node forever and the controls would never come
   * back. One observer on `document.body` therefore owns the whole lifecycle:
   * {@link render} finds the panel that exists *now* and is idempotent, so watching
   * everything costs one no-op pass per mutation burst and survives every
   * remount.
   */
  let scheduled = false
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    const run = () => {
      scheduled = false
      render()
    }
    // Coalesce a burst of mutations into one render, and let React finish its own
    // commit before reading the DOM back.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else setTimeout(run, 0)
  }

  const observer = new MutationObserver(schedule)

  /** Dispose everything this plugin created. */
  function dispose() {
    observer.disconnect()
    if (dialogRoot !== null && dialogRoot.parentElement !== null) dialogRoot.remove()
    dialogRoot = null
    dialog.name = null
    for (const node of document.querySelectorAll(`[${OWNED}]`)) node.remove()
    for (const node of document.querySelectorAll('style[data-plugin="dsh-plugin-updater"]')) node.remove()
  }

  /**
   * The detail page's version button, for the host's own slot.
   *
   * The list controls above are injected into the DOM because the list exposes no
   * slot; the detail page is the opposite case, and `plugins.detail.actions` is the
   * supported seat for exactly this kind of control. Contributing through it means
   * the button is rendered by React inside the page's own action row, inherits its
   * placement and its disabled state, and needs no observation at all.
   *
   * The renderer spreads the owner's props straight onto the component
   * (`renderEntry` does `jsx(Comp, { ...kit, ...injected, ...slotInjected.props,
   * ...ownerProps })`) while the page itself calls
   * `renderSlot('plugins.detail.actions', { subject })`. The component therefore
   * receives `{ subject }` and not the subject — reading the argument as the subject
   * is exactly why this button once rendered nothing at all.
   * @param props - the host's props: the page's `subject`, plus its own kit.
   * @returns the control, or null when this page is not one to add it to.
   */
  function detailAction(props) {
    const subject = props?.subject
    // Only an installed third-party bundle has a version history to show. An
    // official plugin follows the DSH release, and a row is not a package.
    if (subject?.kind !== 'bundle') return null
    const pkg = subject.pkg
    if (pkg === undefined || pkg === null || pkg.installed !== true) return null
    const name = pkg.name
    if (typeof name !== 'string' || name === '') return null

    return createElement(
      'button',
      {
        type: 'button',
        className: 'dsu-btn dsu-outline',
        'data-plugin-updater': 'detail',
        onClick: () => void openVersions(name),
      },
      iconHistoryElement(13),
      createElement('span', null, t('history')),
    )
  }

  return {
    /** Services this half reads: `locale` localizes the injected text, `slots` seats the detail control. */
    inject: ['locale', 'slots'],
    /**
     * Attach the update controls to the Plugins page.
     * @param ctx - the client plugin context.
     */
    apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.setAttribute('data-plugin', 'dsh-plugin-updater')
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      })

      const locale = ctx.get('locale')
      if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        ctx.effect(() => locale.register(UPDATER_NS, { en: UPDATER_EN, zh: UPDATER_ZH }))
        const bound = locale.bind(UPDATER_NS)
        t = (key, params) => interpolate(bound(key) ?? UPDATER_EN[key] ?? key, params)
        if (typeof locale.subscribe === 'function') ctx.effect(() => locale.subscribe(() => render()))
      }

      // The detail page's control rides the host's own slot, which renders it
      // through React; the list's controls are injected below.
      const slots = ctx.get('slots')
      if (slots !== undefined && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        ctx.effect(() =>
          slots.inject('plugins.detail.actions', () =>
            slots.register({ name: 'plugins.detail.actions', id: 'plugin-updater-versions', order: 10 }, detailAction),
          ),
        )
      }

      ctx.effect(() => {
        render()
        // `document.body` rather than the panel: the panel element is replaced on
        // every remount, and this one node is not.
        observer.observe(document.body, { childList: true, subtree: true, attributeFilter: ['data-plugin-status'] })
        return dispose
      })
    },
  }
}
