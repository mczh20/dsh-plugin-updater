# dsh-plugin-updater

English | [中文](README.zh.md)

Update installed DSH plugins from the sidebar **Plugins** page — a per-plugin update button beside each switch, one-click update-all in the toolbar, and a version picker for installing or reverting to any published version. Official plugins are left alone, because they follow the DSH release.

Built for **DSH 0.2.0-rc.2 Web** (Desktop and Web share the same runtime).

## Features

- **Update button on every third-party plugin card**, placed left of its switch. It appears only when a newer version exists, next to a badge naming both versions (`1.2.0 → 1.3.0`). A plugin that is already current shows nothing at all.
- **Check for updates** in the page toolbar, and **Update all (N)** once a check finds something. Updates run one at a time, and one failure never stops the rest.
- **Versions** on each plugin's detail page opens a table of every version that can be installed, with the exact DSH range each one declares and an install button per row. Reverting a broken upgrade is a first-class action, not a workaround.
- **Updates take effect immediately.** An install finishes by reloading the profile, so the new code is the running code — no restart.
- **Official plugins are never offered an update.** They ship with DSH; the updater excludes the same built-in set the official page does.
- Light and dark themes, and both languages the host offers (English and Chinese), follow the page's own settings.

## Install

From npm:

```sh
dsh plugin --profile <profile> add dsh-plugin-updater
```

From GitHub:

```sh
dsh plugin --profile <profile> add github:mczh20/dsh-plugin-updater
```

Restart DSH once after installing, then open the sidebar's **Plugins** page.

## What it will and will not touch

| Plugin | Update button | Versions button |
|---|---|---|
| Third-party, installed from a registry | ✅ when a newer version exists | ✅ every published version |
| Third-party, installed from `github:` | ✅ when the repository moved on | ✅ its tags, or its commits when it has no tags |
| Third-party, installed from `link:` / `file:` | ❌ no registry version to compare | ❌ no history to list |
| Built into DSH (`@deepseek-ai/dsh-base` and friends) | ❌ never | ❌ never |
| Shipped optional bundles (the "Official" group) | ❌ never | ❌ never |

## Safety

The updater performs local code execution: an update runs pnpm, which runs the target package's install scripts. What it does about that:

- **Every route is fenced to loopback.** A request must come from a loopback socket, name a loopback `Host`, and carry same-origin browser markers. `X-Forwarded-For` is never consulted. A page on another origin cannot drive it.
- **A version install can only aim at a package that is already installed**, and the version it names must appear in the history the Host just read. A browser cannot install something new, and a `github:` install always resolves to the repository that package already came from — never one a request names.
- **Names and versions are validated by shape** before they reach pnpm, so no request can produce a token pnpm reads as an option.
- **Every write goes through the official manager's own `installBundle`.** The updater never runs pnpm against a profile itself; the manager snapshots and restores the profile manifest around each run.
- **An interrupted install is repaired.** If a download fails midway, pnpm can leave a package missing from `node_modules` while the manifest still names it — and the manager's own `pnpm install --frozen-lockfile` recovery does not restore a missing top-level link. The updater re-adds the exact previous version, which does.
- **An update never changes whether a plugin is enabled.** A plugin switched off stays off.

## Configuration

None. The updater reuses the running profile's own package manager and registry configuration, so a mirrored or private registry behaves exactly as it does during a normal install.

## How it works

Two halves, both ordinary DSH plugins:

- **Host half** (`lib/index.js`) registers six loopback-fenced routes over the official `pluginManager` service: `check`, `state`, `update`, `update-all`, `versions`, and `install`.
- **Client half** (`lib/client.js`) renders the controls. The **Versions** button rides the official `plugins.detail.actions` slot; the list controls are injected into the page's DOM, because the list exposes no slot at all. Both anchor on `data-*` attributes and ARIA roles rather than on class names, which change between builds.

A check asks the profile's own registry for one abbreviated packument, which answers every published version *together with each version's declared DSH range* — so the version table costs one request. A `github:` plugin is read from its tags, or from its commits when it has no tags; neither carries a compatibility range, and reading one per row would spend a request per row against GitHub's anonymous limit, so that column stays empty there by design.

## Development

```sh
npm install
npm test        # builds the client bundle, then runs 71 tests
npm run build   # rebuilds lib/client.js from src/
```

`lib/client.js` is generated. The host concatenates every client bundle into one classic script for the page, so a bundle may not contain a top-level `import` or `export`; `scripts/build-client.mjs` wraps the plain scripts under `src/` in the module envelope the loader expects. **Run `npm run build` after editing `src/`** — the test suite fails if the build is stale.

## License

MIT
