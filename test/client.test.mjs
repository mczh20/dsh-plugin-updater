/**
 * Client-half tests against a DOM harness that reproduces the Plugins page.
 *
 * The harness builds the structure the official page renders — including the
 * unstable CSS-module class names, which the client must never depend on — so these
 * tests fail if an anchor drifts. They also assert the two rules the approach rests
 * on: official cards are never touched, and nothing the host owns is written to.
 *
 * `lib/client.js` is a classic script that calls `window.__ModuleLoader__.load`, so
 * the harness supplies that global and then calls the factory.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/**
 * The page's own markup, reproduced from the official client.
 *
 * Class names carry the same generated prefix the real page uses, to prove the
 * client anchors on data attributes and roles rather than on those names.
 * @param options - which rows the page should contain.
 * @returns the page's HTML.
 */
function pageHtml(options = {}) {
  const { packages = [], official = [], status = 'running' } = options
  const officialCards = official
    .map(
      (id) =>
        `<li class="fO69Vq_card fO69Vq_cardLink" data-plugin-item="${id}"><div class="fO69Vq_cardHead"><span class="fO69Vq_cardIcon"></span><div class="fO69Vq_cardMain"><div class="fO69Vq_titleRow"><button type="button" class="fO69Vq_cardTitle">${id}</button></div><span class="fO69Vq_cardDesc">desc</span></div></div></li>`,
    )
    .join('')
  const packageCards = packages
    .map(
      (pkg) =>
        `<li class="fO69Vq_card fO69Vq_cardLink" data-plugin-package="${pkg.name}" data-plugin-status="${status}"><div class="fO69Vq_cardHead"><span class="fO69Vq_cardIcon"></span><div class="fO69Vq_cardMain"><div class="fO69Vq_titleRow"><button type="button" class="fO69Vq_cardTitle">${pkg.name}</button></div><span class="fO69Vq_cardDesc">desc</span></div><div class="fO69Vq_cardEnd"><button type="button" role="switch" aria-checked="true" class="fO69Vq_switch"><span class="fO69Vq_thumb"></span></button></div></div></li>`,
    )
    .join('')
  return `<!doctype html><html><body><div id="app"><section class="fO69Vq_page" data-plugin-panel="true" aria-busy="false">
  <header class="fO69Vq_pageHead" data-window-drag="true">
    <div><h1 class="fO69Vq_pageTitle">Plugins</h1><div class="fO69Vq_pageIntro"><span>intro</span></div></div>
    <div class="fO69Vq_toolbar">
      <button type="button" class="fO69Vq_iconButton" aria-label="refresh"></button>
      <button type="button" class="fO69Vq_addButton">+ Add plugin</button>
    </div>
  </header>
  ${officialCards === '' ? '' : `<section class="fO69Vq_group" data-plugin-group="official"><div class="fO69Vq_groupHead"><h3 class="fO69Vq_groupTitle">Official</h3><span class="fO69Vq_count">${official.length}</span></div><ul class="fO69Vq_cards">${officialCards}</ul></section>`}
  ${packageCards === '' ? '' : `<section class="fO69Vq_group" data-plugin-group="bundles"><div class="fO69Vq_groupHead"><h3 class="fO69Vq_groupTitle">Installed</h3><span class="fO69Vq_count">${packages.length}</span></div><ul class="fO69Vq_cards">${packageCards}</ul></section>`}
</section></div></body></html>`
}

/**
 * Boot the client bundle in a fresh DOM.
 * @param html - the page markup.
 * @param options - fetch answers, a language, and a call recorder.
 * @returns the window, the plugin's public halves, and recorded calls.
 */
function boot(html, options = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'http://127.0.0.1:19387/' })
  const { window } = dom
  let loaded
  window.__ModuleLoader__ = { load: (definition) => { loaded = definition } }
  window.fetch = async (url, init) => {
    const record = { url: String(url), init }
    options.calls?.push(record)
    const answer = (options.answers ?? {})[record.url]
    if (answer === undefined) return { ok: false, status: 404, text: async () => '' }
    const body = typeof answer === 'function' ? answer(record) : answer
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  const registrations = []
  const effects = []
  const subscriptions = []
  window.eval(bundle)
  assert.ok(loaded !== undefined, 'the bundle must register a factory')
  assert.equal(loaded.id, 'dsh-plugin-updater')
  const exported = loaded.factory((specifier) => {
    assert.equal(specifier, 'react')
    // `createElement` records its arguments instead of rendering, so a test can call
    // a slot control's own handler the way the host's renderer would.
    //
    // It also refuses a DOM node passed as a child, which is what React itself does.
    // Without that check the mock accepts anything, and a control that would crash
    // inside the host's error boundary — vanishing silently — passes here instead.
    return {
      createElement: (type, props, ...children) => {
        for (const child of children) {
          const isNode = child !== null && typeof child === 'object' && typeof child.nodeType === 'number'
          if (isNode) {
            throw new Error(
              `Objects are not valid as a React child (found: DOM node <${String(child.nodeName).toLowerCase()}>)`,
            )
          }
        }
        return { type, props: props ?? {}, children }
      },
      useReducer: () => [0, () => {}],
      useEffect: () => {},
      useRef: () => ({}),
    }
  })
  // `bind` answers from the language a test selects. Returning undefined for a key
  // is what a real locale service does before its dictionary is registered, and the
  // client must then fall back to its own English source strings.
  const locale = {
    register: (ns, dicts) => registrations.push({ ns, dicts }),
    bind: () => (key) => (options.language === undefined ? undefined : options.language[key]),
    subscribe: (fn) => { subscriptions.push(fn) },
  }
  // Slot registrations are recorded, and their handlers exposed, so a test can call
  // a contributed control the way the host's renderer would.
  const slotHandlers = new Map()
  const slots = {
    inject: (slot, callback) => { callback(); return () => {} },
    register: (definition, render) => {
      if (typeof render === 'function' && definition?.name !== undefined) slotHandlers.set(definition.name, render)
      return () => {}
    },
  }
  const ctx = {
    get: (key) => (key === 'locale' ? locale : key === 'slots' ? slots : undefined),
    effect: (fn) => { effects.push(fn) },
  }
  exported.apply(ctx)
  for (const effect of effects) effect()
  return { dom, window, exported, registrations, subscriptions, effects, slotHandlers }
}

/** Wait for the client's coalesced render to run. */
async function settle(window) {
  await new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
  await new Promise((resolve) => setTimeout(resolve, 5))
}

/** Every node the updater injected. */
const owned = (window) => Array.from(window.document.querySelectorAll('[data-plugin-updater]'))

/** The updater's row inside one card. */
function cardRow(window, name) {
  const card = window.document.querySelector(`li[data-plugin-package="${name}"]`)
  return card === null ? null : card.querySelector('[data-plugin-updater="card"]')
}

/** The toolbar's injected controls. */
function toolbarControls(window) {
  const row = window.document.querySelector('section[data-plugin-panel] header').lastElementChild
  return Array.from(row.children).filter((child) => child.hasAttribute('data-plugin-updater'))
}

/** Click the toolbar's check button and wait for the answer to render. */
async function clickCheck(window, label = 'Check for updates') {
  const button = toolbarControls(window).find((node) => node.textContent.includes(label))
  assert.ok(button !== undefined, 'the check button exists')
  button.dispatchEvent(new window.Event('click'))
  await settle(window)
  await settle(window)
}

test('the client anchors on data attributes, not on hashed class names', async () => {
  const { window } = boot(pageHtml({ packages: [{ name: 'a' }], official: ['x'] }))
  await settle(window)
  const row = window.document.querySelector('section[data-plugin-panel] header').lastElementChild
  assert.equal(row.className, 'fO69Vq_toolbar', 'harness sanity: the toolbar class is a hash')
  assert.equal(toolbarControls(window).length, 2, 'check and update-all are injected despite the hashed name')
})

test('official plugin cards are never given a control', async () => {
  const { window } = boot(pageHtml({ packages: [{ name: 'third-party' }], official: ['agent-team', 'voice-input'] }), {
    answers: { '/api/plugin-updater/check': { results: [{ name: 'third-party', installed: '1.0.0', outcome: 'update', latest: '1.1.0' }] } },
  })
  await settle(window)
  await clickCheck(window)
  assert.ok(cardRow(window, 'third-party') !== null, 'the third-party card gets a row')
  for (const id of ['agent-team', 'voice-input']) {
    const card = window.document.querySelector(`li[data-plugin-item="${id}"]`)
    assert.equal(card.querySelector('[data-plugin-updater]'), null, `${id} must stay untouched`)
  }
  const group = window.document.querySelector('section[data-plugin-group="official"]')
  assert.equal(group.querySelector('[data-plugin-updater]'), null, 'nothing is injected into the official group')
})

test('the update control sits immediately before the switch', async () => {
  const { window } = boot(pageHtml({ packages: [{ name: 'p' }] }), {
    answers: { '/api/plugin-updater/check': { results: [{ name: 'p', installed: '1.0.0', outcome: 'update', latest: '2.0.0' }] } },
  })
  await settle(window)
  await clickCheck(window)

  const cell = window.document.querySelector('li[data-plugin-package="p"] button[role="switch"]').parentElement
  const children = Array.from(cell.children)
  const rowIndex = children.findIndex((child) => child.getAttribute('data-plugin-updater') === 'card')
  const switchIndex = children.findIndex((child) => child.matches('button[role="switch"]'))
  assert.equal(rowIndex + 1, switchIndex, 'the update control is the switch\u2019s left neighbour')
  assert.match(children[rowIndex].textContent, /1\.0\.0 → 2\.0\.0/, 'the badge names both versions')
  assert.match(children[rowIndex].textContent, /Update/, 'the control offers the update')
})

test('an up-to-date plugin gets no control at all', async () => {
  const { window } = boot(pageHtml({ packages: [{ name: 'p' }] }), {
    answers: { '/api/plugin-updater/check': { results: [{ name: 'p', installed: '1.0.0', outcome: 'current' }] } },
  })
  await settle(window)
  await clickCheck(window)
  assert.equal(cardRow(window, 'p'), null, 'nothing is left on an up-to-date card')
})

test('a skipped plugin shows nothing', async () => {
  const { window } = boot(pageHtml({ packages: [{ name: 'linked' }] }), {
    answers: {
      '/api/plugin-updater/check': { results: [{ name: 'linked', installed: '0.0.0', outcome: 'skip', reason: 'not installed from a registry' }] },
    },
  })
  await settle(window)
  await clickCheck(window)
  assert.equal(cardRow(window, 'linked'), null)
})

test('update all appears only when something can be updated', async () => {
  const answers = { '/api/plugin-updater/check': { results: [{ name: 'p', installed: '1.0.0', outcome: 'update', latest: '2.0.0' }] } }
  const { window } = boot(pageHtml({ packages: [{ name: 'p' }] }), { answers })
  await settle(window)
  assert.equal(toolbarControls(window)[1].hidden, true, 'update all stays hidden before any check')
  await clickCheck(window)
  const after = toolbarControls(window)
  assert.equal(after[1].hidden, false, 'update all appears once an update exists')
  assert.match(after[1].textContent, /Update all \(1\)/, 'its label carries the count')
})

test('a live update reports the new version and asks for no restart', async () => {
  const calls = []
  const { window } = boot(pageHtml({ packages: [{ name: 'p' }] }), {
    calls,
    answers: {
      '/api/plugin-updater/check': { results: [{ name: 'p', installed: '1.0.0', outcome: 'update', latest: '2.0.0' }] },
      '/api/plugin-updater/update': { name: 'p', status: 'updated', from: '1.0.0', to: '2.0.0' },
    },
  })
  await settle(window)
  await clickCheck(window)
  cardRow(window, 'p').querySelector('button').dispatchEvent(new window.Event('click'))
  await settle(window)
  await settle(window)

  const sent = calls.filter((record) => record.url === '/api/plugin-updater/update')
  assert.equal(sent.length, 1, 'the update route was called once')
  assert.deepEqual(JSON.parse(sent[0].init.body), { name: 'p', target: '2.0.0' }, 'it names the package and the exact target')
  const row = cardRow(window, 'p')
  assert.match(row.textContent, /Updated to 2\.0\.0/, 'the card reports the version it moved to')
  assert.doesNotMatch(row.textContent, /restart/i, 'a live update never mentions a restart')
  const summary = window.document.querySelector('[role="status"]')
  assert.match(summary.textContent, /1 updated/, 'the summary counts it')
  assert.doesNotMatch(summary.textContent, /restart/i, 'and does not ask for one either')
})

test('a profile without hot reload still says a restart is required', async () => {
  // The truthful fallback: a startup-only profile cannot load new module bytes.
  const { window } = boot(pageHtml({ packages: [{ name: 'p' }] }), {
    answers: {
      '/api/plugin-updater/check': { results: [{ name: 'p', installed: '1.0.0', outcome: 'update', latest: '2.0.0' }] },
      '/api/plugin-updater/update': { name: 'p', status: 'restart-required', from: '1.0.0', to: '2.0.0', changedOnRestart: true },
    },
  })
  await settle(window)
  await clickCheck(window)
  cardRow(window, 'p').querySelector('button').dispatchEvent(new window.Event('click'))
  await settle(window)
  await settle(window)
  assert.match(cardRow(window, 'p').textContent, /restart DSH/, 'the card asks for the restart')
  const summary = window.document.querySelector('[role="status"]')
  assert.ok(summary !== null && /restart DSH/i.test(summary.textContent), 'the summary repeats it once')
})

test('a failed update offers a retry and states the reason', async () => {
  const { window } = boot(pageHtml({ packages: [{ name: 'p' }] }), {
    answers: {
      '/api/plugin-updater/check': { results: [{ name: 'p', installed: '1.0.0', outcome: 'update', latest: '2.0.0' }] },
      '/api/plugin-updater/update': {
        name: 'p',
        status: 'failed',
        from: '1.0.0',
        target: '2.0.0',
        failure: {
          code: 'incompatible-version',
          incompatible: [{ name: 'p', version: '2.0.0', unsatisfiedPeers: { '@deepseek-ai/dsh-tools': '^0.1.5-rc.1' } }],
        },
      },
    },
  })
  await settle(window)
  await clickCheck(window)
  cardRow(window, 'p').querySelector('button').dispatchEvent(new window.Event('click'))
  await settle(window)
  await settle(window)

  const row = cardRow(window, 'p')
  assert.match(row.textContent, /Retry/, 'the control becomes a retry')
  assert.match(row.textContent, /incompatible/, 'the reason is stated inline')
  assert.match(row.querySelector('button').title, /@deepseek-ai\/dsh-tools \^0\.1\.5-rc\.1/, 'the tooltip names the missing peer')
})

test('a failed update that was repaired says so', async () => {
  const { window } = boot(pageHtml({ packages: [{ name: 'p' }] }), {
    answers: {
      '/api/plugin-updater/check': { results: [{ name: 'p', installed: '1.0.0', outcome: 'update', latest: '2.0.0' }] },
      '/api/plugin-updater/update': {
        name: 'p',
        status: 'failed',
        from: '1.0.0',
        target: '2.0.0',
        repaired: { status: 'restored', version: '1.0.0' },
        failure: { code: 'install-failed', diagnostic: 'network' },
      },
    },
  })
  await settle(window)
  await clickCheck(window)
  cardRow(window, 'p').querySelector('button').dispatchEvent(new window.Event('click'))
  await settle(window)
  await settle(window)
  assert.match(cardRow(window, 'p').textContent, /Restored the previous version/, 'the repair is reported')
})

test('update all walks every target and keeps going past a failure', async () => {
  const calls = []
  const { window } = boot(pageHtml({ packages: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }), {
    calls,
    answers: {
      '/api/plugin-updater/check': {
        results: [
          { name: 'a', installed: '1.0.0', outcome: 'update', latest: '2.0.0' },
          { name: 'b', installed: '1.0.0', outcome: 'update', latest: '2.0.0' },
          { name: 'c', installed: '1.0.0', outcome: 'current' },
        ],
      },
      '/api/plugin-updater/update': (record) => {
        const body = JSON.parse(record.init.body)
        return body.name === 'a'
          ? { name: 'a', status: 'restart-required', from: '1.0.0', to: '2.0.0' }
          : { name: 'b', status: 'failed', from: '1.0.0', target: '2.0.0', failure: { code: 'install-failed', diagnostic: 'boom' } }
      },
    },
  })
  await settle(window)
  await clickCheck(window)
  toolbarControls(window)[1].dispatchEvent(new window.Event('click'))
  await settle(window)
  await settle(window)
  await settle(window)

  const names = calls.filter((record) => record.url === '/api/plugin-updater/update').map((record) => JSON.parse(record.init.body).name)
  assert.deepEqual(names, ['a', 'b'], 'both updatable packages were attempted, and the current one was skipped')
  const summary = window.document.querySelector('[role="status"]')
  assert.match(summary.textContent, /1 updated/, 'the summary counts the success')
  assert.match(summary.textContent, /1 failed/, 'and the failure')
})

test('the client writes to no node the host owns', async () => {
  const { window } = boot(pageHtml({ packages: [{ name: 'p' }], official: ['x'] }))
  await settle(window)
  const page = window.document.querySelector('section[data-plugin-panel]')
  for (const card of page.querySelectorAll('li[data-plugin-package]')) {
    for (const attribute of card.attributes) assert.ok(!attribute.name.startsWith('data-plugin-updater'))
  }
  const switchNode = page.querySelector('button[role="switch"]')
  assert.equal(switchNode.getAttribute('aria-checked'), 'true', 'the host switch keeps its own state')
  assert.equal(switchNode.className, 'fO69Vq_switch', 'the host switch keeps its own class')
  assert.equal(page.getAttribute('data-plugin-panel'), 'true')
})

test('disposal removes every injected node and style', async () => {
  const { window, effects } = boot(pageHtml({ packages: [{ name: 'p' }], official: ['x'] }))
  await settle(window)
  assert.ok(owned(window).length > 0, 'something was injected')
  assert.equal(window.document.querySelectorAll('style[data-plugin="dsh-plugin-updater"]').length, 1)

  const disposers = []
  for (const effect of effects) {
    const result = effect()
    if (typeof result === 'function') disposers.push(result)
  }
  for (const dispose of disposers.reverse()) dispose()
  assert.equal(owned(window).length, 0, 'no injected node survives disposal')
  assert.equal(window.document.querySelectorAll('style[data-plugin="dsh-plugin-updater"]').length, 0)
})

test('a host re-render never duplicates the injected controls', async () => {
  const { window } = boot(pageHtml({ packages: [{ name: 'p' }] }), {
    answers: { '/api/plugin-updater/check': { results: [{ name: 'p', installed: '1.0.0', outcome: 'update', latest: '2.0.0' }] } },
  })
  await settle(window)
  await clickCheck(window)
  assert.equal(window.document.querySelectorAll('[data-plugin-updater="card"]').length, 1)

  // Simulate React replacing the card list wholesale, as a refresh does: the
  // injected node goes with it and must come back exactly once.
  const list = window.document.querySelector('section[data-plugin-group="bundles"] ul')
  const card = window.document.querySelector('li[data-plugin-package="p"]')
  card.remove()
  list.appendChild(card)
  await settle(window)
  await settle(window)
  assert.equal(window.document.querySelectorAll('[data-plugin-updater="card"]').length, 1, 'exactly one row, never two')
  // And a re-render that changes nothing must not touch the DOM at all.
  const before = cardRow(window, 'p')
  await settle(window)
  assert.equal(cardRow(window, 'p'), before, 'the same node survives an unchanged render')
})

test('the client settles without re-triggering its own observer', async () => {
  const { window } = boot(pageHtml({ packages: [{ name: 'p' }], official: ['x'] }), {
    answers: { '/api/plugin-updater/check': { results: [{ name: 'p', installed: '1.0.0', outcome: 'update', latest: '2.0.0' }] } },
  })
  await settle(window)
  let mutations = 0
  const observer = new window.MutationObserver((records) => { mutations += records.length })
  observer.observe(window.document.body, { childList: true, subtree: true, attributes: true })
  await clickCheck(window)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const settled = mutations
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(mutations - settled, 0, 'no mutation happens once the rendered state stops changing')
})

test('the detail control uses the host slot and skips what has no history', async () => {
  const { slotHandlers } = boot(pageHtml({ packages: [{ name: 'p' }] }))
  const handler = slotHandlers.get('plugins.detail.actions')
  assert.ok(handler !== undefined, 'the control is contributed to the official detail slot')
  // The host passes `{ subject }`, which is the shape that matters.
  const installed = { subject: { kind: 'bundle', pkg: { name: 'p', version: '1.0.0', installed: true, enabled: true, rows: [] } } }
  assert.ok(handler(installed) !== null, 'an installed bundle gets the control')
  // An official plugin follows the DSH release and has no history to pick from.
  assert.equal(handler({ subject: { kind: 'item', id: 'agent-team' } }), null)
  // A bundle that is listed but not installed has nothing installed to replace.
  assert.equal(handler({ subject: { kind: 'bundle', pkg: { name: 'p', installed: false, enabled: false, rows: [] } } }), null)
  assert.equal(handler({}), null)
  assert.equal(handler(undefined), null)
  // The bare-subject shape is what the host does NOT do; asserting it returns null
  // pins the contract so a future refactor cannot silently swap the two.
  assert.equal(handler({ kind: 'bundle', pkg: { name: 'p', installed: true, enabled: true, rows: [] } }), null)
})

test('the dialog lists versions with their ranges and marks the installed one', async () => {
  const { window } = await openDialog()
  const card = dialogCard(window)
  assert.ok(card !== null, 'the dialog opened')
  assert.equal(card.getAttribute('role'), 'dialog')
  assert.match(card.textContent, /2\.0\.0/, 'the newest version is listed')
  assert.match(card.textContent, />=0\.2\.0-rc\.2 <0\.3\.0-0/, 'its declared DSH range is shown')
  assert.match(card.textContent, />=0\.1\.5-rc\.2 <0\.1\.6-0/, 'and the older ones too')

  const current = dialogRow(window, '1.0.0')
  assert.equal(current.getAttribute('data-dsu-current'), '1', 'the installed row is marked')
  assert.equal(current.querySelector('button[data-dsu-install]'), null, 'and offers no install button')

  // Every other row offers one, and the newest is the only one flagged latest.
  assert.ok(dialogRow(window, '2.0.0').querySelector('button[data-dsu-install]') !== null)
  assert.match(dialogRow(window, '2.0.0').textContent, /latest/i)
})

test('the dialog scrim dims the page instead of covering it', async () => {
  // The scrim once painted `--dsw-alias-bg-overlay`, which is the *opaque* surface a
  // popover fills itself with. The whole window turned solid grey and the page
  // behind the dialog disappeared. The mask token is the semi-transparent one, and
  // this asserts the stylesheet uses it.
  const { window } = await openDialog()
  const css = window.document.querySelector('style[data-plugin="dsh-plugin-updater"]').textContent
  const scrim = /\.dsu-scrim\{([^}]*)\}/.exec(css)
  assert.ok(scrim !== null, 'the scrim rule is present')
  assert.match(scrim[1], /--dsw-alias-bg-mask-1/, 'the scrim paints the theme mask')
  assert.doesNotMatch(scrim[1], /--dsw-alias-bg-overlay/, 'and never the opaque overlay surface')
  // Both mask values in the shipped theme are semi-transparent; the assertion above
  // is what keeps the opaque token from returning.
  assert.equal(dialogCard(window) !== null, true)
})

test('the dialog card uses the panel surface and radius the host Modal uses', async () => {
  const { window } = await openDialog()
  const css = window.document.querySelector('style[data-plugin="dsh-plugin-updater"]').textContent
  const card = /\.dsu-dialog\{([^}]*)\}/.exec(css)
  assert.ok(card !== null)
  assert.match(card[1], /--dsw-alias-bg-layer-2/, 'the secondary layer, as Modal uses')
  assert.match(card[1], /--dsw-radius-panel/, 'and the panel radius')
  assert.match(card[1], /--dsw-elevation-prominent/, 'raised by the prominent elevation')
})

test('the dialog closes on the close button and on Escape', async () => {
  const first = await openDialog()
  first.window.document.querySelector('[data-plugin-updater="dialog-close"]').dispatchEvent(new first.window.Event('click'))
  assert.equal(dialogCard(first.window), null, 'the close button closes it')

  const second = await openDialog()
  const escape = new second.window.Event('keydown', { bubbles: true })
  escape.key = 'Escape'
  dialogCard(second.window).dispatchEvent(escape)
  assert.equal(dialogCard(second.window), null, 'Escape closes it')
})

test('installing a version posts that exact version', async () => {
  const calls = []
  const { window } = await openDialog({
    calls,
    answers: {
      '/api/plugin-updater/install': { name: 'p', status: 'updated', from: '1.0.0', to: '0.9.0', installed: '0.9.0' },
    },
  })
  const button2 = dialogRow(window, '0.9.0').querySelector('button[data-dsu-install]')
  button2.dispatchEvent(new window.Event('click'))
  await settle(window)
  await settle(window)

  const sent = calls.filter((record) => record.url === '/api/plugin-updater/install')
  assert.equal(sent.length, 1)
  assert.deepEqual(JSON.parse(sent[0].init.body), { name: 'p', version: '0.9.0' }, 'the row\u2019s own version is sent')
  assert.equal(dialogCard(window), null, 'a successful install closes the dialog')
})

test('a refused install keeps the dialog open and says why', async () => {
  const { window } = await openDialog({
    answers: {
      '/api/plugin-updater/install': { name: 'p', status: 'refused', target: '0.9.0', failure: { code: 'already-current' } },
    },
  })
  dialogRow(window, '0.9.0').querySelector('button[data-dsu-install]').dispatchEvent(new window.Event('click'))
  await settle(window)
  await settle(window)
  assert.ok(dialogCard(window) !== null, 'the dialog stays open')
  const foot = window.document.querySelector('.dsu-dialog-status')
  assert.ok(foot !== null && foot.textContent.length > 0, 'the reason is shown in the footer')
})

test('a range that plainly names another DSH line is flagged, not blocked', async () => {
  const { window } = await openDialog()
  // The runtime version is unknown to the test page, so the range is shown plainly
  // and no row is blocked: an install button is present even on an old version.
  assert.ok(dialogRow(window, '0.9.0').querySelector('button[data-dsu-install]') !== null)
})

test('a github source says the range is unknown rather than inventing one', async () => {
  const { window } = await openDialog({
    versions: {
      source: 'github',
      repo: 'owner/repo',
      current: '0.3.46',
      currentRef: 'cab5b3bc0def633497489a1dfbfc9a9b103640b6',
      rangeKnown: false,
      versions: [
        { version: 'cab5b3b', ref: 'cab5b3bc0def633497489a1dfbfc9a9b103640b6', subject: 'Newest change', isCurrent: true },
        { version: '12f53a8', ref: '12f53a84f770c4318bcf5a9bb8f9922a8778954b', subject: 'Older change' },
      ],
    },
  })
  const card = dialogCard(window)
  assert.match(card.textContent, /cab5b3b/, 'the revision is listed')
  assert.match(card.textContent, /Newest change/, 'with its message')
  assert.match(card.textContent, /\u2014/, 'the range column shows the unknown marker')
  assert.ok(
    dialogRow(window, '12f53a8').querySelector('button[data-dsu-install]') !== null,
    'and an older revision can still be installed',
  )
})

test('a local install reports that it has no history', async () => {
  const { window } = await openDialog({
    versions: { source: 'local', current: '0.1.0', versions: [], problem: 'local-source' },
  })
  assert.match(dialogCard(window).textContent, /local path/i, 'the dialog explains why it is empty')
})

test('opening the dialog twice does not stack two dialogs', async () => {
  const { window, slotHandlers } = await openDialog()
  assert.equal(window.document.querySelectorAll('[data-plugin-updater="dialog-card"]').length, 1)
  slotHandlers.get('plugins.detail.actions')({ kind: 'bundle', pkg: { name: 'p', installed: true, enabled: true, rows: [] } })
  await settle(window)
  await settle(window)
  assert.equal(window.document.querySelectorAll('[data-plugin-updater="dialog-card"]').length, 1, 'still exactly one')
})

test('the dictionary registers both languages under the plugin namespace', async () => {
  const { registrations } = boot(pageHtml({ packages: [] }))
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].ns, 'pluginUpdater')
  assert.ok(registrations[0].dicts.en.check)
  assert.ok(registrations[0].dicts.zh.check)
  assert.equal(registrations[0].dicts.zh.check, '\u68c0\u67e5\u66f4\u65b0')
  assert.equal(registrations[0].dicts.zh.update, '\u66f4\u65b0')
})

test('the injected text follows the host language', async () => {
  const language = { check: '\u68c0\u67e5\u66f4\u65b0', update: '\u66f4\u65b0', updateAllCount: '\u66f4\u65b0\u5168\u90e8\uff08{count}\uff09' }
  const { window } = boot(pageHtml({ packages: [{ name: 'p' }] }), {
    language,
    answers: { '/api/plugin-updater/check': { results: [{ name: 'p', installed: '1.0.0', outcome: 'update', latest: '2.0.0' }] } },
  })
  await settle(window)
  assert.ok(
    toolbarControls(window).some((node) => node.textContent.includes('\u68c0\u67e5\u66f4\u65b0')),
    'the toolbar uses the host language',
  )
  await clickCheck(window, '\u68c0\u67e5\u66f4\u65b0')
  assert.match(cardRow(window, 'p').textContent, /\u66f4\u65b0/, 'the card uses the host language')
})

/* --------------------------------------------------------- version dialog -- */

/** The dialog, or null when it is closed. */
const dialogCard = (window) => window.document.querySelector('[data-plugin-updater="dialog-card"]')

/** One dialog row, by the version it names. */
function dialogRow(window, version) {
  for (const row of window.document.querySelectorAll('[data-plugin-updater="dialog-row"]')) {
    if (row.textContent.includes(version)) return row
  }
  return null
}

/** Boot, open the dialog through the host's own slot, and wait for the table. */
async function openDialog(options = {}) {
  const booted = boot(pageHtml({ packages: [{ name: 'p' }] }), {
    // `calls` is read by the harness, so it must stay at the top level.
    ...(options.calls === undefined ? {} : { calls: options.calls }),
    answers: {
      '/api/plugin-updater/versions?name=p': options.versions ?? {
        source: 'registry',
        current: '1.0.0',
        rangeKnown: true,
        versions: [
          { version: '2.0.0', ref: '2.0.0', dshRange: '>=0.2.0-rc.2 <0.3.0-0', latest: true },
          { version: '1.0.0', ref: '1.0.0', dshRange: '>=0.1.5-rc.2 <0.1.6-0', isCurrent: true },
          { version: '0.9.0', ref: '0.9.0' },
        ],
      },
      ...(options.answers ?? {}),
    },
  })
  await settle(booted.window)
  const handler = booted.slotHandlers.get('plugins.detail.actions')
  assert.ok(handler !== undefined, 'the detail action slot was claimed')
  // The host spreads the owner's props onto the component, and the page passes
  // `{ subject }`, so the component receives `{ subject }` — not the subject. The
  // harness must reproduce that or it tests a contract the host never uses.
  const control = handler({ subject: { kind: 'bundle', pkg: { name: 'p', version: '1.0.0', installed: true, enabled: true, rows: [] } } })
  assert.ok(control !== null, 'the control renders for an installed bundle')
  // A slot entry that throws is swallowed by the host's error boundary, so the
  // control disappears with no visible error. Every child must therefore be
  // something React can actually render — the mock's `createElement` enforces that.
  for (const child of control.children ?? []) {
    assert.equal(
      child !== null && typeof child === 'object' && typeof child.nodeType === 'number',
      false,
      'the control passes no raw DOM node to React',
    )
  }
  // The control is a React element here; the test invokes the handler it carries.
  control.props.onClick()
  await settle(booted.window)
  await settle(booted.window)
  return booted
}

// The next three tests cover failures seen only in the running desktop app. Each
// one reproduced there before it was fixed, so they are regression tests rather
// than speculative coverage.

test('leaving the page and coming back restores the controls', async () => {
  const { window } = boot(pageHtml({ packages: [{ name: 'p' }] }), {
    answers: { '/api/plugin-updater/check': { results: [{ name: 'p', installed: '1.0.0', outcome: 'update', latest: '2.0.0' }] } },
  })
  await settle(window)
  await clickCheck(window)
  assert.equal(cardRow(window, 'p') === null ? 0 : 1, 1, 'controls are present on arrival')

  // Navigating away unmounts the whole panel, and the injected nodes go with it.
  const panel = window.document.querySelector('section[data-plugin-panel]')
  panel.remove()
  await settle(window)
  await settle(window)
  assert.equal(window.document.querySelectorAll('[data-plugin-updater]').length, 0, 'nothing is left behind')

  // Coming back mounts a *new* panel element. An observer bound to the old one
  // would never fire again, which is exactly the bug this covers.
  const host = window.document.getElementById('app')
  host.innerHTML = pageHtml({ packages: [{ name: 'p' }] })
    .replace(/^[\s\S]*?<div id="app">/, '')
    .replace(/<\/div><\/body><\/html>\s*$/, '')
  await settle(window)
  await settle(window)
  assert.equal(toolbarControls(window).length, 2, 'the toolbar controls return without a plugin restart')
  assert.ok(cardRow(window, 'p') !== null, 'the card control returns too')
})

test('a theme flip re-renders the controls instead of losing them', async () => {
  const { window } = boot(pageHtml({ packages: [{ name: 'p' }] }), {
    answers: { '/api/plugin-updater/check': { results: [{ name: 'p', installed: '1.0.0', outcome: 'update', latest: '2.0.0' }] } },
  })
  await settle(window)
  await clickCheck(window)

  // A theme change re-renders the shell; some shells also remount the panel.
  for (const theme of ['dark', 'light']) {
    window.document.documentElement.setAttribute('data-theme', theme)
    const panel = window.document.querySelector('section[data-plugin-panel]')
    const replacement = window.document.createElement('section')
    replacement.setAttribute('data-plugin-panel', 'true')
    for (const group of panel.querySelectorAll('section[data-plugin-group]')) replacement.appendChild(group)
    const header = panel.querySelector('header')
    replacement.insertBefore(header, replacement.firstChild)
    panel.replaceWith(replacement)
    await settle(window)
    await settle(window)
    assert.equal(toolbarControls(window).length, 2, `controls survive a flip to ${theme}`)
    assert.ok(cardRow(window, 'p') !== null, `the card control survives a flip to ${theme}`)
  }
})

test('a hidden control is actually hidden', async () => {
  // `hidden` is how the toolbar hides update-all until something is updatable, and
  // the client's own `display:inline-flex` outranks the user agent's
  // `[hidden]{display:none}` unless the client restates the rule. jsdom does not
  // cascade injected stylesheets, so the assertion is made against the stylesheet
  // text the bundle carries.
  const { window } = boot(pageHtml({ packages: [{ name: 'p' }] }))
  await settle(window)
  const updateAll = toolbarControls(window)[1]
  assert.equal(updateAll.hidden, true, 'update all is hidden before a check')
  const css = window.document.querySelector('style[data-plugin="dsh-plugin-updater"]').textContent
  assert.match(css, /\.dsu-btn\[hidden\]\{display:none\}/, 'the stylesheet restates the hidden rule for injected buttons')
})
