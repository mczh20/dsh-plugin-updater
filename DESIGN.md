# DSH 插件更新器 —— 设计文档（开发依据）

> 状态：**阶段一（更新）已实机验证；阶段二（历史版本）已实现并通过 63 项测试**。本文档是唯一开发依据；实现偏离本文档时必须先回来改文档。
> 项目目录：`F:\代码项目\deepseek Harness\dsh-plugin-updater\`

---

## 0. 一句话目标

在 DSH 桌面端侧边栏「插件」页（`main` 面板 key = `plugins`）上，为**每个第三方插件卡片**加一个「更新」按钮，并在页头工具栏加一个「更新全部 / 检查更新」按钮，让用户不卸载重装就能把插件升到 registry 最新版；**官方插件（随 DSH 版本更新）绝不出现更新按钮**。

**阶段二**：插件详情页加「历史版本」按钮，打开一个弹窗列出该插件的所有历史版本（版本号 + 适配的 DSH 范围 + 安装按钮），支持 npm 源与 `github:用户名/仓库名` 源，可安装/回退到任一历史版本。

---

## 0.5 阶段二：历史版本选择（本次升级）

### 0.5.1 用户确认的决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | GitHub 源的「版本」 | **优先 tag/release；无 tag 时退回列 commit**（该仓库无 tag，故列 3 个 commit） |
| 2 | 适配信息怎么取 | **npm 用 packument 一次请求拿全**；GitHub **只用列表接口自带元数据，不做逐版本额外请求**（避免 60/小时限流） |
| 3 | 弹窗实现 | **自绘弹窗**（官方 Modal 未导出 React 组件，primitives 只有 CSS），严格对齐官方 token 与尺寸 |
| 4 | 安装行为 | **保持原有启用状态，装完自动 reload 立即生效**（复用 §5.8 的 `#applyLive`） |

### 0.5.2 已验证的数据能力

**npm 源（一次请求拿全部版本 + 各自适配范围）**：

```
GET <registry>/<name>          accept: application/vnd.npm.install-v1+json
```
实测 `dsh-plugin-smooth-stream`：297ms、6.5KB、7 个版本，**每个版本各自带 peerDependencies**：

| 版本 | 适配 DSH |
|---|---|
| 1.0.0 ~ 1.1.2 | 未声明 |
| 1.2.0 | `>=0.1.5-rc.2 <0.1.6-0` |
| 1.3.0 | `>=0.2.0-rc.2 <0.3.0-0` |

→ 表格第二列可做，且只花一次请求。

**GitHub 源**：

```
GET https://api.github.com/repos/<owner>/<repo>/tags?per_page=100      → tag 列表
GET https://api.github.com/repos/<owner>/<repo>/releases?per_page=100  → release 列表
GET https://api.github.com/repos/<owner>/<repo>/commits?per_page=100   → 无 tag 时的退回
```
实测 `Loliyer520/dsh-codex-ui`：tags=**0**、releases=**0**、commits=**3**（未鉴权限流 60/小时）。

GitHub 源表格的「适配 DSH」列**留空并注明**（遵守决策 2），避免逐版本请求打爆限流。

### 0.5.3 源的识别

已安装包属于哪种源，从 profile 的两处读取：

1. **`package.json` 的 dependencies 字符串**：`github:` / `git+https://` / `git@` → GitHub 源；`link:` / `file:` → 本地源（**不给历史版本按钮**）；普通 semver range → npm 源。
2. **`pnpm-lock.yaml` 的 `importers['.'].dependencies[name].version`**：git 源在这里带**精确 commit**（如 `git+https://github.com/…git#cab5b3bc…`），可用于标出"当前安装的就是这一版"。

### 0.5.4 弹窗设计（按用户给的图）

```
┌────────────────────────────────────────────────────────────┐
│ 历史版本 — dsh-plugin-smooth-stream                    [×] │
├────────────────────────────────────────────────────────────┤
│  版本          适配 DSH              操作                   │
│  1.3.0 (最新)  >=0.2.0-rc.2 <0.3.0-0   [安装]  ← 当前       │
│  1.2.0         >=0.1.5-rc.2 <0.1.6-0   [安装]               │
│  1.1.2         —                        [安装]               │
│  …                                                          │
└────────────────────────────────────────────────────────────┘
```

- 右上角关闭按钮；表格三列：**版本 / 适配 DSH / 安装按钮**（按用户描述）
- 当前已安装的那一行标出「当前」，其按钮禁用
- 适配范围与当前运行时**不匹配**的行，标警告色并在按钮旁提示（**不阻止安装** —— 回退本来就是冒险操作，但必须让用户看见风险）
- 安装中：该行按钮内联 spinner；完成后关闭弹窗并复用列表页的汇总提示

### 0.5.5 新增 Host 路由

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|---|
| GET | `/api/plugin-updater/versions?name=<pkg>` | 包名 | `{ source, versions: [{ version, ref, dshRange, isCurrent, latest?, subject? }], repo?, currentRef?, rangeKnown }` |
| POST | `/api/plugin-updater/install` | `{ name, version }` | 同 `/update` 的返回形状 |

`install` 与 `update` 的区别：`update` 只允许**向上升级到 latest**；`install` 允许**安装任一历史版本**（含降级），但仍须：
- 包名合法且**已安装在 profile 中**
- github 源必须是**已安装包自身的源仓库**（不接受任意仓库，防 SSRF/任意安装）
- 非官方、非内置
- **版本/ref 必须出现在引擎刚刚重新读取的列表里** —— 请求体里的字符串从不直接进 pnpm

### 0.5.7 已实现（本节为最终实现记录）

| 文件 | 职责 |
|---|---|
| `lib/versions.js` | 纯函数：源识别、`owner/repo` 解析、lockfile commit 读取、三种兼容性声明位置的读取、packument/GitHub 列表 → 表格行 |
| `lib/github.js` | GitHub REST 薄封装；**403/429 区分 `rate-limited` 与 `forbidden`**（否则会把限流误报成"仓库不存在"） |
| `lib/version-source.js` | registry packument 与 GitHub tag/commit 的取数；`AbortSignal.any` 不可用，故手工组合超时信号 |
| `lib/engine.js` | `versions(name)` 与 `install(name, version)` |
| `src/client.js` | `dialog` 状态 + `renderDialog()` + `versionTable()` + `versionRow()`；详情页 slot 的 `detailAction()` |

**实测数据（真实仓库/真实注册表）**：

```
=== GitHub 源 (dsh-codex-ui) ===
source: github  repo: Loliyer520/dsh-codex-ui  current: 0.3.46  currentRef: cab5b3b
rangeKnown: false
  cab5b3b  current=true   Add Codex-style settings menu with DeepSeek API balance
  12f53a8  current=false  Fix root spacing and replace outer frame border with shadow
  62b1801  current=false  Rename plugin to dsh-codex-ui and use Codex application icon

=== npm 源 (dsh-plugin-smooth-stream) ===
  1.3.0  range=>=0.2.0-rc.2 <0.3.0-0  current=true  latest=true
  1.2.0  range=>=0.1.5-rc.2 <0.1.6-0
  1.1.2 / 1.1.1 / 1.1.0 / 1.0.1 / 1.0.0  range=(未声明)
```

**兼容性判断的取舍**：不引入 semver range 解析器。`rangeCovers()` 只把 range 里的字面量版本与当前运行时的 major.minor 行做粗比对，**仅用于把明显不匹配的行标黄，永不阻止安装** —— 回退本来就是冒险操作，用户需要看见风险而不是被拦住。

### 0.5.6 详情页入口（官方 slot）

`plugins.detail.actions` 是**官方 list slot**（非 DOM 注入），渲染契约已验证：

```js
renderSlot("plugins.detail.actions", { subject })
// subject = { kind: 'bundle', pkg: { name, version, installed, enabled, rows } }
```

→ 「历史版本」按钮放这里，**比列表页的 DOM 注入干净得多**。仅对 `subject.kind === 'bundle'` 且该包有历史版本可列时渲染。

---

## 1. 已确认的侦察事实（实现的前提）

### 1.1 目标页面

包：`@deepseek-ai/dsh-client-ui-plugin-manager@0.2.0-rc.2`（桌面端 `app.asar` 内）
源码 dump：`<workspace>\.dsh-tmp\asar-dump\dsh-client-ui-plugin-manager\lib\client.js`

列表页 DOM 结构（`client.js:3395-3554`）：

```
section[data-plugin-panel]                 ← 面板根
├── header.pageHead  [data-window-drag]
│   ├── div > h1.pageTitle + div.pageIntro
│   └── div.toolbar                        ← ★ 插「检查更新 / 更新全部」
├── section[data-plugin-group="official"]  ← 官方插件
│   └── ul.cards > li[data-plugin-item="<id>"]     ← ✗ 绝不放更新按钮
└── section[data-plugin-group="bundles"]   ← 已安装第三方
    └── ul.cards > li[data-plugin-package="<包名>"] [data-plugin-status="running|disabled|problem"]
        └── div.cardHead
            ├── span.cardIcon
            ├── div.cardMain > div.titleRow + span.cardDesc
            └── div.cardEnd                ← ★ 插「更新」按钮（开关左侧）
                └── EnableSwitch
```

官方分组判定（`client.js:3342-3344`）：

```js
const listed   = state.packages.filter(p => !BUILTIN_PROFILE_BUNDLES.has(p.name) && (p.installed || p.optional || p.error !== undefined))
const mine     = listed.filter(p => p.installed || !p.optional)   // 「已安装」→ li[data-plugin-package]
const official = listed.filter(p => p.optional && !p.installed)   // 「官方」  → li[data-plugin-item]
```

→ **只对 `li[data-plugin-package]` 注入按钮，天然排除官方插件。**
（`BUILTIN_PROFILE_BUNDLES` 已在官方侧过滤：`@deepseek-ai/dsh-base` / `dsh-web-app` / `dsh-headless` / `dsh-sdk-app` / `dsh-acp-app` / `dsh-sdk-minimal`。）

### 1.2 扩展点约束（最关键的架构事实）

| slot | kind | 位置 | 能否满足需求 |
|---|---|---|---|
| `plugins.detail.actions` | list | **详情页**页头 | 只能进详情页后操作 |
| `plugins.detail.badge` | list | 详情页标题旁 | 同上 |
| `plugins.detail.section` | list | 详情页底部 | 同上 |
| `plugins.item` | list | 仅官方插件卡片 | 官方条目专用 |

**列表页没有任何 slot。** 因此卡片级 + 工具栏级按钮**只能 DOM 注入**（`MutationObserver` 持续校准 + 卸载清理）。
详情页的 `plugins.detail.actions` 可作**补充**（官方 slot，正当用法），但列表页按钮是需求主体。

### 1.3 Host 能力

`pluginManager`（typert Remote，`@deepseek-ai/dsh-plugin-manager`）现有方法：

| 方法 | 用途 | 关键限制 |
|---|---|---|
| `listBundles()` | 已装组合包：`name` / `version` / `installed` / `enabled` / `optional` / `removable` / `rows` / `error` | **无「最新版本」字段** |
| `listPlugins()` | loader 条目 + fiber 阶段 | — |
| `inspect(spec, {registry}, signal)` | 查 spec 指向什么 | **对已安装包直接 `refused/already-installed`** → 不能用来查新版 |
| `installBundle(spec, {enabled, requestId, approvedBuilds, registry})` | 跑 `pnpm add <spec>` | **不检查是否已安装** → 这就是升级入口 |
| `cancelInstall(requestId)` / `waitForInstall(requestId)` | 取消 / 断线恢复 | — |
| `registries()` | 配置的注册表集合 + pnpm 自身指向 | — |
| `setBundleEnabled` / `removeBundle` / `setPluginEnabled` | 启停 / 卸载 | — |
| 事件 `plugin-manager/changed`、`plugin-manager/install-log`、`plugin-manager/install-state` | 变更与进度广播 | Client 用 `ctx.remote.$on(...)` 订阅 |

**「查最新版本」不能走 `inspect`**（见上），必须另查 registry。

### 1.4 升级执行语义（来自源码 `lib/index.js:1691-1812`）

- `installBundle` 用 `pnpm add <spec> [--registry=<url>]`；`pnpm add name@latest` 天然完成升级。
- 每次尝试前快照 `package.json` + `pnpm-lock.yaml`；失败/取消会**还原**这两个文件。
- 成功后：`result.bundle = name`；`configure()` 里 `selectBundle(name, true)`。
  - **`if (Object.hasOwn(before, name)) return "restart-required"`** ← 已装过的包（即升级场景）**返回 `restart-required`，且不触发 `reload()`**。
  - 新装包才会走 `reload()` 热挂载。
- 失败分类：`result.packageResult.kind`、`result.failedAt`、`result.pendingBuilds`；不兼容抛 `ManagementFailure("incompatible-version", [incompatiblePlugin(...)])`，Client 侧映射为 `error.code === "incompatible-version"`、`error.incompatible[]`（每项含 `name`/`version`/`runtimeVersion`/`unsatisfiedPeers`）。

> ⚠️ **对用户「不需要重启」设想的正式结论**：
> 卸载→重装**同样**是已存在的包，仍走 `Object.hasOwn(before, name)` 分支 → **同样返回 `restart-required`**，不会热加载新模块。
> 官方 README「已知限制」原文亦写明：*Package replacements require restarting the process to load a fresh JavaScript module generation.*
> 所以「不重启」在**官方语义下不可行**，除非我们自己做进程内模块失效（见 §7 备选方案 D，风险高）。**默认按 §6.4 的「重启后生效」处理**，并保留一键重启入口（拿不到就只留提示）。

### 1.5 其他已验证的机制

- **Host ↔ Client 通信**：自定义 loopback HTTP 路由（`ctx.inject(['webServer'])` → `webServer.register({kind:'exact', path, handler})`）。参考实现 `dsh-workbuddy-connect`、`@linxin666/dsh-client-ui-plugin-manager`（后者有完整 loopback 四重门禁：socket 地址 + Host 头 + Origin + `sec-fetch-site`）。
- **Client 插件信封**（`dsh-plugin-smooth-stream` 实证）：
  ```js
  window.__ModuleLoader__.load({
    id: '<包名>',
    factory: (require) => { const React = require('react'); return { inject: [...], apply(ctx) {...} } }
  })
  ```
  可 `ctx.get('slots'|'locale'|'modules'|'timer')`、`ctx.effect(fn)` 注册清理、`ctx.interval`。
- **package.json 契约**（`dsh-plugin-smooth-stream` 实证）：
  ```json
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale", ...] }
  }
  ```
  `cordis.patch.yml` 用 `- insert: [{ id, name }]` 把行插进 profile roster。
- **桌面 profile**：`C:\Users\Administrator\.dsh\profiles\desktop\`（`package.json` 的 `dsh.profile.bundles` 是选中列表）。
- **桌面包管理器**：`process.execPath` + `runtime/pnpm/bin/pnpm.mjs`（`--expose-internals`，`ELECTRON_RUN_AS_NODE=1`）。官方 `installBundle` 已经拿得到它 → **我们不必自己 spawn pnpm**。

---

## 2. 已确认的产品决策（用户拍板）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 最新版本判定 | 查 registry **`dist-tags.latest`**；**latest 是 rc 预发布也照样提示更新**（rc 生态） |
| 2 | 注册表 | **复用宿主配置**：`pluginManager.registries()` 的 `registry` + `fallbackRegistries` 依次询问（私有源/代理/鉴权生效） |
| 3 | 「更新全部」范围 | **只更新已安装的第三方 bundle**（即 `li[data-plugin-package]`）；官方与内置一律不动 |
| 4 | 卡片按钮形态 | **有新版才显示**「更新」按钮 + 版本徽标（`v0.6.5 → v0.7.0`）；无新版时隐藏 |
| 5 | 进度反馈 | 按钮内联 spinner + 行内状态文字 + 结束后**顶部汇总提示**（失败项标红、可单独重试）；不弹模态 |
| 6 | 自动检查 | **不做自动检查**；工具栏提供显式「检查更新」按钮 |
| 7 | 安装形态 | **标准 npm 包**，发布后从 registry 安装 |
| 8 | 查询位置 | **Host 端发起**（自定义 loopback HTTP 路由），查询手段经 R3 定为 `pnpm view` |
| 9 | 重启 | **已确证不可行**（R2 无重启入口 + 官方源码 `Object.hasOwn(before, name)` 使升级/重装都返回 `restart-required`）→ 显示「已更新 · 重启后生效」文字提示，**不给按钮** |
| 10 | 兼容性拒绝 | **已确证官方无授权界面**（R1 零命中）→ 行内显示兼容性错误与缺失 peer + 「让 Agent 修复」转交；**绝不自动绕过** |
| 11 | 按钮位置 | 插在**开关的左边**（锚点：`button[role="switch"]` 之前） |
| 12 | 多语言 | **中英双语**，按宿主 locale 自动切换（`ctx.locale.register` + `bind`） |
| 13 | 批量失败策略 | **继续更新其余**，最后汇总（失败项可单独重试） |
| 14 | V1 范围 | 只做：检查更新 + 单个更新 + 更新全部 + 进度/错误反馈。（**不做** changelog、忽略此版本、版本选择器、详情页按钮） |
| 15 | 包名 | `dsh-plugin-updater` |
| 16 | 调试方式 | 先本地 `link:` 装到 desktop profile 调试，验收后再发布 npm |

---

## 3. 交付物与目录布局

用户要求「创建一个文件夹专门做这个」。目录：`F:\代码项目\deepseek Harness\dsh-plugin-updater\`

```
dsh-plugin-updater/
├── DESIGN.md                     ← 本文档（开发依据）
├── RECON.md                      ← 已有侦察结论（保留作历史）
├── README.md                     ← 对外说明（中英，最终交付时写）
├── package.json                  ← 标准 npm 包元数据（含 dsh.bundle / dsh.client）
├── cordis.patch.yml              ← profile 层插入行
├── lib/
│   ├── index.js                  ← Host 半区：loopback HTTP 路由 + registry 查询 + 升级编排
│   ├── client.js                 ← Client 半区：DOM 注入 + 按钮 + 状态 + i18n
│   └── i18n.js                   ← 中英词典（被 client.js 引用或内联）
├── src/                          ← 可读源码（若采用构建步骤）
└── test/
    ├── host.test.mjs             ← 路由/版本比较/安全检查 单测
    └── client.test.mjs           ← DOM 注入 单测（jsdom）
```

**包名（待用户确认，见 §10 Q1）**：建议 `dsh-plugin-updater`（与 `dsh-plugin-smooth-stream` 同风格，未占用）。

---

## 4. 架构

```
┌─────────────────────────── Browser (Client 半区) ───────────────────────────┐
│  lib/client.js                                                              │
│   ├─ ctx.effect: 注入 <style data-plugin="dsh-plugin-updater">              │
│   ├─ MutationObserver 盯着 section[data-plugin-panel]                       │
│   │    ├─ .toolbar           → 注入 [检查更新] [更新全部]                    │
│   │    └─ li[data-plugin-package] > .cardHead > .cardEnd                    │
│   │                          → 在 EnableSwitch 左侧注入 [更新] + 版本徽标    │
│   ├─ 状态 store（每个包：idle/checking/updating/updated/failed/skipped）     │
│   └─ fetch('/api/plugin-updater/…')  ← loopback 同源                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │  HTTP (loopback 门禁)
┌────────────────────────────────────▼────────────────────────────────────────┐
│  lib/index.js  (Host 半区, ctx.inject(['webServer', 'pluginManager']))      │
│   ├─ GET  /api/plugin-updater/check      → 批量查最新版（并发有上限）        │
│   ├─ POST /api/plugin-updater/update     → 升级一个包（name + targetVersion）│
│   ├─ POST /api/plugin-updater/update-all → 顺序升级一批                      │
│   ├─ GET  /api/plugin-updater/state      → 当前进度快照（断线恢复 / 重连）    │
│   └─ POST /api/plugin-updater/cancel     → 取消当前升级                      │
│                                                                             │
│  版本查询：pluginManager.registries() → 依次 GET <registry>/<name> 取        │
│           dist-tags.latest（或走 pnpm view，二选一，见 §5.2）                │
│  升级执行：pluginManager.installBundle(`${name}@${latest}`, {...})           │
│            + cancelInstall / waitForInstall                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

**为什么 Host 端查询而不是浏览器直接 fetch**：私有源/代理/pnpm `.npmrc` 鉴权只在 Host 侧生效；且避开 CORS。

---

## 5. Host 半区设计

### 5.1 路由清单

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|---|
| GET | `/api/plugin-updater/check` | — | `{ checkedAt, results: [{ name, current, latest, hasUpdate, registry, problem? }] }` |
| POST | `/api/plugin-updater/update` | `{ name, target }` | `{ name, status: 'updated'\|'restart-required'\|'failed'\|'cancelled', from, to, failure? }` |
| POST | `/api/plugin-updater/update-all` | `{ names[], targets{} }` | `{ results: [...] }`（顺序执行） |
| GET | `/api/plugin-updater/state` | — | `{ running: {name, phase, attempt}[], lastRun }` |
| POST | `/api/plugin-updater/cancel` | `{ name }` | `{ status: 'cancelled'\|'too-late'\|'not-running' }` |

**门禁（强制）**：每条路由都要 loopback 四重校验——socket 地址 ∈ 127/8 或 ::1、`Host` 头是 loopback、`Origin` 同源、`sec-fetch-site` 非跨站。非 loopback 返回 403。
> 这是「本机代码执行」面：`pnpm add` 会跑依赖的 install 脚本。**绝不可**暴露到 loopback 之外。

### 5.2 版本查询（经 R3 修正为 `pnpm view`）

1. `const regs = await ctx.pluginManager.registries()` → `{ registry, fallbackRegistries, resolved }`。
2. 组装询问顺序：`[resolved ?? registry, ...fallbackRegistries]`（去重、规范化，与官方 `registryPlan` 同语义）。
3. 对每个 registry：跑
   ```
   pnpm view <name> version --json --registry=<registry>
   ```
   （**同官方 `viewProfilePackage` 路径**：继承 profile 的 `.npmrc`/代理/鉴权；`--registry` 显式指定；
   单个 registry 一次请求、不自带 pnpm 重试，超时即换下一个。）
   - 桌面 profile 实测配置：`registry = https://registry.npmmirror.com`、`nodeLinker = hoisted`、`autoInstallPeers = false`。
   - 用 `this.profile.packageManager`（桌面端 = `process.execPath` + `pnpm.mjs`，由启动器注入）来跑，
     **不要**自己假设 `pnpm` 在 PATH 上。
   - 第一个**可达且含该包**的 registry 即为答案（`registry` 字段回填）。
   - 网络失败/超时/404 → 试下一个；全部失败 → `problem: 'network' | 'not-found'`，不阻塞其它包。
4. 超时：每 registry 8s；整批并发上限 4（避免同时开太多 pnpm 进程）。
5. 该命令同时返回 `dist-tags`，**直接取 `latest`**；若 latest 是预发布版（`-rc.`/`-alpha.`）也照常采用（用户决策 #1）。

### 5.3 版本比较（semver，含预发布）

用户选择「latest 是 rc 也算更新」，所以**不做 prerelease 排斥**。规则：

- `hasUpdate = compareSemver(latest, current) > 0`，`compareSemver` 实现为标准 semver 优先级（含 prerelease 段比较：`1.0.0-rc.2 < 1.0.0-rc.10 < 1.0.0`）。
- `current === latest` → 无更新（按钮隐藏）。
- `current` 不是合法 semver（如 `link:` 本地包、`git` 源）→ `problem: 'not-semver'` → **按钮隐藏**（本地 link 包没有 registry 版本可比）。
- 本地 link 包识别：`listBundles()` 的 `name` 在 profile `package.json` 里是 `link:` / `file:` / `workspace:` → 直接跳过检查。
  > 实证：桌面 profile 里 `@yuxianglin/dsh-bridge-browser` 就是 `link:C:/Users/Administrator/.dsh/dsh-browser/packages/browser/bridge-browser`。

### 5.4 升级编排

```
updateOne(name, target):
  1. 前置校验
     - name 必须出现在 pluginManager.listBundles() 中，且 installed===true
     - 必须不在 BUILTIN 名单、不是 optional（官方）→ 否则 400 refuse
     - name 必须是合法 npm 包名（正则），防命令注入
     - target 必须是合法 semver，且 > 当前版本
  2. 并发保护：同一时刻只允许一个包在升级（队列串行）；已有任务 → 409
  3. spec = `${name}@${target}`
  4. requestId = randomUUID()
  5. result = await pluginManager.installBundle(spec, { requestId, enabled: true })
     - 订阅 plugin-manager/install-log 转发为 SSE/轮询日志（可选，V1 只转发 install-state 阶段）
  6. 判定：
     - 成功 + 版本确实变了 + 包已存在 → status = 'restart-required'（官方语义）
     - 抛 incompatible-version → failure = { code, incompatible[] }
     - 抛其它 → failure = { code, diagnostic, pendingBuilds?, failedAt? }
  7. 清理：readState() 更新，广播变更
```

**幂等与恢复**：进程内维护 `runs: Map<name, {requestId, phase, result}>`；`GET /state` 让浏览器刷新后能恢复进度；断线用 `waitForInstall(requestId)` 拾回。

### 5.5 安全清单

- [ ] 包名/版本严格正则：`^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$`、semver `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`
- [ ] 拒绝含 shell 元字符、空白、控制字符、`-` 开头、`:`、`/`（除 scope）的输入
- [ ] 只允许升级**已安装且在 profile 中声明**的包（白名单来自 `listBundles()`，不从请求体信任）
- [ ] target 必须来自我们自己刚查到的 registry 结果（或 ≥ 当前版本），不接受任意 spec
- [ ] 每条路由 loopback 四重门禁
- [ ] 不做 `rm -rf` 类操作；不直接写 profile 文件（一切经官方 `installBundle`）
- [ ] **`link:` / `file:` / `workspace:` / `git` 源一律跳过**（没有 registry 版本可比）

### 5.6 失败自愈（R4 实测新增，必需）

**问题**：升级**中断**（下载超时/断网）会让 pnpm 删掉旧包的顶层链接，而官方失败恢复用的
`pnpm install --frozen-lockfile` 在此时**无效**（报 "Already up to date" 但链接仍缺失）。
后果：manifest 写着该包、`node_modules` 里却没有 → **下次启动加载失败**。

**自愈流程**（`updateOne` 的 `finally`，无论成败都跑）：

```
1. 记录升级前的 version（current）
2. 调 installBundle(name@target)
3. 若失败或取消：
   a. 检查 resolveBundleDir(name) 的 package.json 是否存在
   b. 若不存在（顶层链接被删）→ 修复：
      - 首选：pnpm add <name>@<current>   （实测秒级恢复，虚拟存储 .pnpm/ 里的包还在，无需重新下载）
      - 若失败：删 node_modules 后 pnpm install --frozen-lockfile（实测可恢复，代价是全量重链接）
   c. 若修复成功 → 按「原版本未变」正常报失败；若修复也失败 → 上报 `repair-failed` 并给出人工指引
4. 修复用的 pnpm 调用同样走 this.profile.packageManager 与 profile 目录
```

**报告要求**：自愈成功后，UI 上仍是「更新失败」，但**不得**让用户以为包坏了；错误详情里注明「已恢复到 v原版本」。

### 5.7 Host 半区调用契约（Q1–Q4 已验证）

- **服务名**：`pluginManager`（`class PluginManager extends _classSuper { ... }` → `super(ctx, "pluginManager")`）。
- **注入写法**：`ctx.inject(['webServer', 'pluginManager'], (ctx) => {...})`，之后 `ctx.pluginManager.listBundles()` 直接调。
- **无额外审批**：官方的审批门禁挂在 `plugin_manager` **工具**上（工具调用要走 sandbox/approval），
  **直接调服务方法没有审批层** → 所以**本插件的路由门禁就是唯一防线**，必须严格执行 §5.1 的 loopback 四重校验。
- `installBundle(spec, { requestId, enabled, approvedBuilds, registry })` —— options 字段全集如上。
- **没有重启入口**（R2）：asar 内 grep `dsh-desktop-host` / `dsh-host-plugin-inventory` 的
  `app.relaunch` / `relaunch()` / `restartProfile` / `restart()` **零命中** → UI 只给文字提示，不给重启按钮。

---

## 6. Client 半区设计（UI 是重点）

### 6.1 注入点与结构

**A. 工具栏**（`.toolbar` 内，「添加插件」按钮**左侧**，`gap:16px` 已有）：

```
[⟳ 检查更新]  [+ 添加插件]
```
- 「检查更新」= `outline` 或 `ghost` 变体、`size="sm"`，与官方 `.sm` 规格完全对齐。
- 「更新全部」在**存在可更新项时**才出现，`primary` 变体，文字含数量：`更新全部 (3)`。
  - 顺序：`[检查更新] [更新全部 (3)] [+ 添加插件]`

**B. 卡片**（`.cardEnd` 内，`EnableSwitch` **左侧**）：

```
… [v0.6.5 → v0.7.0]  [更新]  ( 开关 )
     版本徽标         按钮
```
- 版本徽标：`Tag` 风格（`tone: "info"`），`10px/18px`，与官方 `.statusTag` 一致。
- 「更新」按钮：`outline` + `size="sm"`（高度 28px、字号 12px、`--dsw-radius-sm`）。
- 无更新 / 非 semver / 官方条目 → **不渲染任何东西**（零痕迹）。
- 更新中：按钮内联 spinner（复用官方 `StateDot state="ongoing" size={18}` 观感），文字变「更新中…」，禁用；旁边行内状态文字。
- 成功：按钮变「已更新 ✓」（`state-success-primary`），徽标消失；顶部汇总 toast。
- 失败：按钮变「重试」，行内红字错误（`state-error-primary`），hover/点击展开详情（含 incompatible peers）。

### 6.2 与 React 共存的注入策略

**必须做的**：
1. `MutationObserver` 观察 `[data-plugin-panel]` 子树（`childList: true, subtree: true`）+ 属性 `data-plugin-status`。
2. 注入前用 `data-updater="1"` 标记自己的节点，**幂等**：已存在就只更新内容，不重复插入。
3. React 重渲染会**移除**我们的节点 → observer 回调里重新注入（用 `requestAnimationFrame` 或微任务去抖）。
4. 卸载（`ctx.effect` 清理）：`observer.disconnect()`、移除所有 `[data-updater]` 节点、移除 `<style>`。
5. **绝不修改** React 管理的节点属性/文本（只 append 自己的子节点到 `.cardEnd` / `.toolbar`），避免 React 对账报错或丢内容。
6. 只 append 到**已存在**的容器；容器本身还没渲染就等下一轮 observer。

**去抖**：observer 回调里合并同一帧的多次变更，避免批量渲染时抖。

### 6.3 主题与视觉规范（严格只用 `--dsw-*`）

已确认存在的 token（`Theme.listTokens` + 官方 CSS 实读）：

```
背景   --dsw-alias-bg-base / -bg-layer-1 / -2 / -overlay / -skeleton
文字   --dsw-alias-label-primary / -secondary / -tertiary / -caption
边框   --dsw-alias-border-l1 / l2 / l3 / l4
交互   --dsw-alias-interactive-bg-hover / -active
主按钮 --dsw-alias-button-primary-fill / -hover, --dsw-alias-label-primary-foreground
工具条 --dsw-alias-button-tool-bar-fill / -hover
状态   --dsw-alias-state-success-primary, -state-warn-primary / -label / -tertiary,
       -state-error-primary, -state-business-primary, -state-idle-primary
品牌   --dsw-alias-brand-primary, --dsw-alias-accent-primary
焦点   --dsw-focus-ring-color / -width
圆角   --dsw-radius-xs / sm / md / lg / xl
字体   --dsw-font-mono, --dsw-font-markdown-code-block-small
其它   --dsw-elevation-prominent, --dsw-elevation-stroke-color
```

官方 Button 规格（`Button.module.css`，需在实现时核对到具体文件）：
- `.sm`：`height 28px; font-size 12px; line-height 18px; padding 0 10px; border-radius: var(--dsw-radius-sm)`
- `.outline`：`0.5px solid var(--dsw-alias-border-l3)`
- `.ghost` hover：`background: var(--dsw-alias-interactive-bg-hover)`
- `:disabled`：`opacity:.4; cursor:not-allowed`

**明暗适配原则**：
- 所有颜色走 `var(--dsw-*)`，**不写死任何色值**。
- 需要半透明时用 `color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)`（官方 CSS 已用此写法）。
- 焦点环：`outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color)`（核对官方写法后对齐）。
- 深色/浅色各截图验证一次（见 §9 验收）。

### 6.4 「重启后生效」的呈现（R2 修正）

升级成功且官方返回 `restart-required` 时：
- 卡片行内提示：`已更新到 v0.7.0 · 重启 DSH 后生效`（`state-warn-primary`，`13px/20px`）。
- 顶部汇总：`已更新 N 个插件，重启 DSH 后生效`。
- **不显示「重启 DSH」按钮** —— R2 已确证桌面端没有任何可被插件调用的重启入口。
- **不做**任何强制重启或自动重启。

### 6.5 兼容性错误呈现（R1 修正）

官方**没有**可复用的授权界面（R1 零命中），因此：
- 卡片行内渲染与官方同款的错误文字：`{plugin} 与 DSH {runtime} 不兼容（要求 {peers}）`，
  用 `state-error-primary`；hover/点击展开缺失 peer 明细。
- 给一个 **「让 Agent 修复」** 转交按钮（跳到一个以该插件安装根为工作区的新会话）。
- **绝不自动调 `setVersionExemption`**：官方要求用户对确切的「包@版本 × DSH 版本」组合显式确认风险
  （`acceptRisk: true`），自动绕过是数据丢失级风险。
- 残留的 `pnpm 11` 构建脚本拦截（`pendingBuilds`）→ 同样只如实呈现，提示去 `pnpm-workspace.yaml` 的 `allowBuilds` 放行。

---

## 7. 备选方案 D（若用户坚持「绝对不重启」）

进程内模块失效：清掉 Node 的 `require.cache` / ESM loader 缓存再重新 import 插件入口。
**风险**：官方 README 明确「替换包需要重启进程以加载新的 JS 模块代」，说明当前架构不保证安全；会造成同一进程内新旧模块实例共存、Cordis fiber 重复挂载、`duplicate prefix route` 等故障（`@linxin666` 插件的 README 就记录了这类事故）。
**结论**：**不默认做**。若要做，必须单独开一期，且要有回滚开关。文档保留此节仅作备案。

---

## 8. 待验证项 —— 已全部清零（实测结论）

### R4 ✅ 通过（但查明一个必须处理的副作用）

**结论：`pnpm add <name>@latest` 对已安装的包确实执行升级。**
实测：`is-odd@3.0.0` → `pnpm add is-odd@latest` → manifest 与 `node_modules` 均变为 `3.0.1`。

**但发现一个真实副作用，必须处理**：

| 失败类型 | manifest | `node_modules` | 可恢复性 |
|---|---|---|---|
| **干净失败**（版本不存在、注册表明确拒绝） | 不变 ✅ | 不变 ✅ | 无需恢复 |
| **中断失败**（下载超时、网络断） | 不变 ✅ | **包被删除** ❌ | `pnpm install --frozen-lockfile` / `pnpm install` / `--force` **全部修不回来**（都报 "Already up to date"，但顶层链接已消失） |

> 因为 pnpm 先删旧链接、再建新的；下载中途失败时旧链接已没了。
> 而官方 `installBundle` 的失败恢复恰好用的就是 `--frozen-lockfile`（`lib/index.js:649`）→ **官方恢复路径在这个场景下是无效的**。

**已验证可用的修复**（本插件必须在升级失败后自动补做）：
- `pnpm add <name>@<原版本>`（精确重钉）→ ✅ 秒级恢复顶层链接（虚拟存储 `.pnpm/` 里的包还在，无需重新下载）
- `pnpm add <name>`（不带版本）→ ✅ 同样恢复
- 兜底：删掉 `node_modules` 再 `pnpm install --frozen-lockfile` → ✅ 能恢复（但要全量重链接）

→ **设计补充 §5.6「失败自愈」**。

### R5 ✅ 通过

桌面端 PID 7680 的命令行证明：它跑的就是 `app.asar/dsh` 内的 `@deepseek-ai/dsh-desktop-host/lib/index.js`，
Web 服务监听 `127.0.0.1:19387`，**与 Web 版共用同一份生产代码**。
因此 `.dsh-tmp/asar-dump/` 里的源码 **就是** 运行中的代码，DOM 结构由构造保证一致。

**但 class 名带 CSS-module hash**（如 `fO69Vq_toolbar`），不能直接当选择器。**改用稳定锚点**：

| 目标 | ❌ 不可用 | ✅ 稳定锚点 |
|---|---|---|
| 面板根 | `.page` | `section[data-plugin-panel]` |
| 分组 | `.group` | `section[data-plugin-group="official"\|"bundles"]` |
| 第三方卡片 | `.card` | `li[data-plugin-package]` |
| 官方卡片 | `.card` | `li[data-plugin-item]` |
| 开关 | `.switch` | `button[role="switch"][aria-checked]` |
| **卡片 `.cardEnd`** | `.cardEnd` | **`li[data-plugin-package] button[role="switch"]` 的 `parentElement`** |
| **工具栏 `.toolbar`** | `.toolbar` | **`section[data-plugin-panel] > header > :last-child`**（header 是该 section 的首个元素子节点，其第二个子节点即 toolbar） |

`Switch` 组件的真实 DOM（`dsh-client-ui-primitives/lib/index.js`）：
```js
jsx("button", { type: "button", role: "switch", "aria-checked": checked, "aria-label": label,
                 title, disabled, className: clsx(css.switch, className), onClick: () => onChange(!checked),
                 children: jsx("span", { className: css.thumb }) })
```
→ **`button[role="switch"]` 是可靠的注入锚点**，插在它前面即可实现「按钮在开关左侧」。

### R6 ✅ 通过（拿到权威样式源码）

`dsh-client-ui-primitives/lib/*.module.css` 已在 asar 内读到全文。**关键规格**：

```css
/* Button.module.css —— 官方按钮权威规格 */
.button { border-radius: var(--dsw-radius-md); font-size:14px; line-height:22px;
          color: var(--dsw-alias-label-primary); background: transparent; padding: 0 14px; }
.button:disabled { cursor:not-allowed; opacity:.4; }
.sm     { height:28px; font-size:12px; line-height:18px; padding:0 10px; border-radius: var(--dsw-radius-sm); }
.primary{ background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.ghost:hover:not(:disabled)   { background: var(--dsw-alias-interactive-bg-hover); }
.ghost:active:not(:disabled)  { background: var(--dsw-alias-interactive-bg-active); }
.outline{ border: 0.5px solid var(--dsw-alias-border-l3); background: transparent; }
.outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.icon   { display:inline-flex; width:16px; height:16px; align-items:center; justify-content:center; }

/* Tag.module.css —— 徽标权威规格（tone 决定配色） */
.tag { border-radius:999px; corner-shape:round; padding:1px 8px; font-size:11px; line-height:17px; font-weight:500; white-space:nowrap; }
.tag[data-tone='success'] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); color: var(--dsw-alias-state-success-primary); }
.tag[data-tone='info']    { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); color: var(--dsw-alias-state-business-primary); }
.tag[data-tone='warning'] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); color: var(--dsw-alias-state-warn-primary); }
.tag[data-tone='danger']  { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); color: var(--dsw-alias-state-error-primary); }

/* StateDot.module.css —— spinner 权威规格（ongoing 态） */
.spinner { color: var(--dsw-alias-label-tertiary); }
.spinnerMotion { transform-origin:center; animation: dsh-state-dot-spin 1.5s linear infinite; }
.spinnerTrack { opacity:.25; }  .spinnerArc { stroke-dasharray: 12 150; animation: dsh-state-dot-dash 1.5s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .spinnerMotion, .spinnerArc { animation: none; } }
```

→ **徽标直接复刻 `Tag` 的 `data-tone` 公式**；spinner 直接复刻 `StateDot` 的 1.5s 周期与 dash 动画；
按钮直接复刻 `.sm` + `.outline`。**不引第三方样式，不硬编码颜色。**

### R1 ✅ 通过（答案与预期相反，需改设计）

**官方安装器界面*没有*任何「授权豁免」入口。**
全库 grep `setVersionExemption` / `allowVersion` / `exempt` 于官方 client 半区 → **零命中**。
`listVersionExemptions` / `setVersionExemption` 只存在于 Host 服务的 **Remote**（供 `plugin_manager` **工具**用），
官方页面撞到 `incompatible-version` 时**只渲染错误文字**（`client.js:2634-2642`），不给用户任何一键授权按钮。

→ 所以「调用官方安装器的界面来授权」**做不到**。改为：
- 卡片行内渲染与官方同款的兼容性错误文字（含缺失 peer）；
- 旁边给一个 **「让 Agent 修复」** 转交按钮（与 `@linxin666` 插件同思路，但走我们自己的会话入口）；
- **绝不**自动调 `setVersionExemption`（官方要求用户对**确切的包@版本 × DSH 版本**组合显式确认风险，且 `acceptRisk: true`）。

### R2 ✅ 通过（结论：没有重启入口）

在 asar 内 grep `dsh-desktop-host` 与 `dsh-host-plugin-inventory` 的 `app.relaunch` / `relaunch()` / `restartProfile` / `restart()` → **零命中**。

→ **不显示「重启 DSH」按钮**，只显示文字提示「已更新 · 重启 DSH 后生效」。

### R3 ✅ 通过（结论：走 pnpm，不走裸 HTTP）

桌面 profile 的 pnpm 配置：`registry = https://registry.npmmirror.com`、`nodeLinker = hoisted`、`autoInstallPeers = false`。
裸 `GET <registry>/<name>` 拿不到 pnpm 的 `.npmrc` 链 / 代理 / 私有源鉴权。
官方自己的做法就是 `pnpm view <name> --json --registry=<r>`（`lib/index.js` 的 `viewProfilePackage`）。

→ **版本查询改为复用 `pnpm view`**（与官方 `inspect` 同一实现路径），
`registry` 从 `pluginManager.registries()` 取，按 `[resolved ?? registry, ...fallbackRegistries]` 依次询问。

### ★ 顺带发现：这个需求在当前生态里价值极高

实测桌面 profile 现状（`C:\Users\Administrator\.dsh\profiles\desktop\package.json`）：

| 包 | 已装 | npm latest | 可更新 | 新版是否兼容 0.2.0-rc.2 |
|---|---|---|---|---|
| `@michengai/dsh-codex-ui` | 1.1.25 | **1.1.28** | ✅ | ✅ peer 已含 `0.2.0-rc.2` |
| `dsh-plugin-smooth-stream` | 1.2.0 | **1.3.0** | ✅ | ✅ peer `>=0.2.0-rc.2 <0.3.0-0` |
| `dsh-workbuddy-connect` | 0.6.5 | **0.7.1** | ✅ | ✅ peer 精确 `0.2.0-rc.2` |
| `dsh-better-sidebar` | 0.24.1 | 0.24.1 | — | 已是最新 |
| `@yuxianglin/dsh-bridge-browser` | `link:` | — | ❌ 跳过 | 本地 link 包，无 registry 版本 |

**当前就有 3 个可更新项**，且新版都已适配 0.2.0-rc.2 —— 功能一上线即可用。
（注：`dsh-codex-ui@1.1.28` 等新版的 peer 已升级到 `^0.2.0-rc.1`，**升级本身就解决了兼容性问题**，
这正是本插件最大的实用价值：web profile 里那批 `^0.1.5-rc.1` 时代的包，正是靠更新才能恢复兼容。）

---

## 9. 验收标准

**功能**
- [ ] 侧边栏「插件」页工具栏出现「检查更新」；点击后逐个包显示检查中 → 出结果
- [ ] 存在可更新项时工具栏出现「更新全部 (N)」；点击后顺序升级
- [ ] 每个**第三方**插件卡片在开关左侧出现「更新」按钮 + 版本徽标（`v旧 → v新`）
- [ ] **官方插件卡片（`li[data-plugin-item]`）绝无更新按钮**（自动化断言）
- [ ] 无更新 / `link:` 包 / 无法解析版本 → 卡片上零痕迹
- [ ] 单个更新成功 → 徽标消失、状态「已更新 · 重启后生效」、顶部汇总
- [ ] 单个更新失败 → 行内红字错误 + 「重试」；`incompatible-version` 显示缺失 peer
- [ ] **升级中断导致包被删时自动自愈恢复**（§5.6），且仍如实报「更新失败」
- [ ] 更新中可取消（走 `pluginManager.cancelInstall`）
- [ ] 浏览器刷新/重连后进度不丢（`GET /state`）
- [ ] 桌面 profile 实测：`@michengai/dsh-codex-ui`、`dsh-plugin-smooth-stream`、`dsh-workbuddy-connect` 三个可更新项被正确识别（且 `@yuxianglin/dsh-bridge-browser` 这个 `link:` 包被跳过）

**UI**
- [ ] 100% 使用 `--dsw-*` token，无硬编码色值
- [ ] 深色模式截图 ✓、浅色模式截图 ✓（每个都对比官方按钮的尺寸/圆角/字重）
- [ ] 按钮 `height:28px; font-size:12px; border-radius:var(--dsw-radius-sm)` 与官方 `.sm` 一致
- [ ] hover / active / focus-visible / disabled 四态齐备
- [ ] 键盘可达（Tab 顺序自然，Enter/Space 可触发，有 `aria-label`）
- [ ] `aria-busy` / `role="status"` / `role="alert"` 与官方同款语义
- [ ] `prefers-reduced-motion` 下 spinner 降级

**工程**
- [ ] 单测：semver 比较（含 rc）、包名/版本校验、loopback 门禁、DOM 注入幂等、清理彻底
- [ ] 卸载插件后 DOM 无残留节点、无残留 `<style>`、无残留 observer
- [ ] `pnpm add` 期间不阻塞 UI 线程
- [ ] 不改动任何官方包文件（只做注入与 Remote 调用）

---

## 10. 仍需用户确认的问题

| # | 问题 | 建议默认 |
|---|---|---|
| **Q1** | npm 包名？ | `dsh-plugin-updater`（与 `dsh-plugin-smooth-stream` 同风格） |
| **Q2** | 是否能提供 npm 发布账号/token，还是先本地 `link:` 装好、验完再发布？ | 先本地 `link:` 装到 desktop profile 调试，验收后再发布 |
| **Q3** | 「更新全部」失败时的策略：**继续更新其余**，还是**出错即停**？ | 继续更新其余，最后汇总 |
| **Q4** | 是否要显示 changelog / release notes？ | V1 不做 |
| **Q5** | 是否要「固定版本 / 忽略此更新」功能？ | V1 不做 |

---

## 11. 实施顺序（确认后按此执行）

1. **清零 §8 待验证项**（尤其 R4、R5）→ 回填本文档
2. 搭包骨架：`package.json` + `cordis.patch.yml` + `lib/index.js` 空实现 + `lib/client.js` 空实现；`link:` 装到 desktop profile，确认能在插件页看到自己（先只注入一个占位按钮验证注入通道）
3. Host 半区：loopback 门禁 → `/check` → 版本查询与比较 → 单测
4. Host 半区：`/update` → 编排 + 失败分类 + 单测
5. Client 半区：i18n + 状态 store
6. Client 半区：工具栏按钮注入
7. Client 半区：卡片按钮 + 徽标注入 + 四态 + 明暗适配
8. 打磨：spinner、汇总提示、错误详情、键盘可达、reduced-motion
9. 双主题截图验收 + 全量单测 + 卸载残留检查
10. 更新本文档与 `README.md`

---

## 附：实现不得违反的红线

1. **官方插件（`li[data-plugin-item]`）与内置包永不出现更新按钮。**
2. **一切写操作只经官方 `pluginManager.installBundle`**，不自己 spawn pnpm、不自己改 profile 文件。
3. **只允许升级 `listBundles()` 里真实存在的、已安装的、非官方非内置的包。**
4. **每条 Host 路由都要 loopback 四重门禁。**
5. **只用 `--dsw-*` token，不硬编码颜色**，明暗双主题都要过。
6. **注入必须幂等且卸载彻底**，绝不修改 React 管理的节点内容。
