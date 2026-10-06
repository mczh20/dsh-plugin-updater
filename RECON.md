# 插件更新插件 —— 技术侦察结论

## 一、目标页面

**`@deepseek-ai/dsh-client-ui-plugin-manager@0.2.0-rc.2`**
（桌面端 `app.asar` 内独有；全局 0.1.5-rc.3 里**没有**这个包 —— 印证「web 是老板本」）

- 侧边栏「插件」面板（`PANEL_ID = "plugins"`，locale NS `pluginManager`）
- 列表页 DOM 锚点：
  - 面板根：`[data-plugin-panel]`
  - 分组：`section[data-plugin-group="official" | "bundles"]`
  - 卡片：`li[data-plugin-package="<包名>"]`，属性 `data-plugin-status="running|disabled|problem"`
  - 官方插件卡片：`li[data-plugin-item="<id>"]`
  - 工具栏：`.toolbar`（内含刷新按钮 + `+ 添加插件` 主按钮）
  - 卡片末尾：`.cardEnd`（开关就在这里）
- 官方插件判定（源码 3342-3344 行）：
  ```js
  const listed   = state.packages.filter(p => !BUILTIN_PROFILE_BUNDLES.has(p.name) && (p.installed || p.optional || p.error !== undefined))
  const mine     = listed.filter(p => p.installed || !p.optional)   // 「已安装」
  const official = listed.filter(p => p.optional && !p.installed)   // 「官方」
  ```
  → **`li[data-plugin-package]` 才是可更新对象；`li[data-plugin-item]` 是官方插件，绝不放更新按钮。**

## 二、扩展点（关键约束）

| slot | kind | 位置 | 能否满足需求 |
|---|---|---|---|
| `plugins.detail.actions` | list | **详情页**页头 | 只能进详情页后操作 |
| `plugins.detail.badge` | list | 详情页标题旁 | 同上 |
| `plugins.detail.section` | list | 详情页底部 | 同上 |
| `plugins.item` | list | 官方插件卡片/详情 | 仅官方条目 |
| `plugins.bundle.config` / `plugins.row.config` | keyed | 详情页配置区 | 同上 |

**列表页（截图那一页）没有任何 slot。** 因此「每张卡片一个更新按钮」+「工具栏一个全部更新」
必须走 **DOM 注入**（在卡片 `.cardEnd` 的开关旁插入按钮、在 `.toolbar` 插入「更新全部」）。

> 这是唯一可行路径：官方只暴露了详情页 slot，而需求明确要求**列表页**的按钮。
> DOM 注入需处理 React 重渲染 —— 用 `MutationObserver` 持续校准，并在卸载时清理。

列表页结构（源码 3395-3554 行）：
```
section[data-plugin-panel]
├── header.pageHead
│   ├── div > h1.pageTitle + div.pageIntro
│   └── div.toolbar           ← 插「更新全部」
├── section[data-plugin-group="official"]  → ul.cards > li[data-plugin-item]      ← 不放按钮
└── section[data-plugin-group="bundles"]   → ul.cards > li[data-plugin-package]
                                                            └── .cardHead > .cardEnd ← 插「更新」
```

## 三、Host 能力

`pluginManager` Remote（typert，`@deepseek-ai/dsh-plugin-manager`）现成方法：

| 方法 | 用途 | 限制 |
|---|---|---|
| `listBundles()` | 已装组合包：name / version / description / enabled / installed / rows / error | **无「最新版本」字段** |
| `listPlugins()` | loader 条目与 fiber 阶段 | — |
| `inspect(spec, {registry})` | 查 spec 指向什么 | **对已安装包直接返回 `refused/already-installed`** → 不能用来查新版 |
| `installBundle(spec, {enabled, requestId, approvedBuilds, registry})` | 跑 `pnpm add <spec>` | **不检查是否已安装** → 这就是升级入口 |
| `setBundleEnabled` / `setPluginEnabled` / `removeBundle` | 启停/卸载 | — |
| `registries()` | 可用注册表 | — |
| `plugin-manager/changed` 事件 | 变更广播 | — |

**`inspect` 不能查新版**是核心难点：它一见已安装就拒绝。所以「查最新版本」必须另找路径。

### 可行方案：宿主端查 registry

`listBundles()` 给出已装 `name` + `version`；最新版本通过注册表元数据（`npm view` 或
`GET <registry>/<name>` 的 `dist-tags`）取得，再做 semver 比较。
参考实现：`dsh-workbuddy-connect` 的 `checkWorkBuddyUpdate()` —— 用
`https://registry.npmjs.org/-/package/<name>/dist-tags`，只取 dist-tags 判定。

### 升级执行

`installBundle(`${name}@${latest}`)` → 跑 `pnpm add name@latest`，天然完成升级；
完成后 `plugin-manager/changed` 触发页面刷新。

## 四、Host ↔ Client 通信

两条可行的桥：

1. **自定义 HTTP 路由**（`dsh-workbuddy-connect` 用法，已验证）
   ```js
   ctx.inject(["webServer"], (webCtx) => {
     webCtx.webServer.register({ kind: "exact", path, handler: (req, res) => {...} })
   })
   ```
   握手要点：`req.method` 校验 → `loopbackRequest(req)` 校验 → `json(res, code, body)`

2. **typert Remote**（官方插件用法）：需要代码生成，第三方插件过重。

→ **用方案 1**（HTTP 路由），客户端用 `fetch()` 调用。

## 五、Client 插件契约（已验证）

模块信封（`dsh-plugin-smooth-stream` 实证）：
```js
window.__ModuleLoader__.load({
  id: '<包名>',
  factory: (require) => {
    const React = require('react')
    return { inject: [...], apply(ctx) {...} }
  }
})
```
- 可 `ctx.get('slots')` / `ctx.get('locale')` / `ctx.get('modules')` / `ctx.get('timer')`
- `ctx.effect(fn)` 注册清理
- 样式：自建 `<style data-plugin="<id>">` 注入

## 六、主题与 UI 规范（必须遵守）

**只用 `--dsw-*` 语义 token，自动适配明暗**（已确认页面共 37 个 token）：

```
背景    --dsw-alias-bg-layer-1 / -2 / -3 / -skeleton
文字    --dsw-alias-label-primary / -secondary / -tertiary / -caption
边框    --dsw-alias-border-l1 / l2 / l3 / l4
交互    --dsw-alias-interactive-bg-hover / -active
主按钮  --dsw-alias-button-primary-fill / -hover, --dsw-alias-label-primary-foreground
工具条  --dsw-alias-button-tool-bar-fill / -hover
状态    --dsw-alias-state-success-primary / -secondary, --dsw-alias-state-warn-primary / -label / -tertiary,
        --dsw-alias-state-error-primary, --dsw-alias-state-business-primary
焦点    --dsw-focus-ring-color / -width
圆角    --dsw-radius-xs / sm / md / lg / xl
字体    --dsw-font-mono, --dsw-font-markdown-code-block-small
其它    --dsw-elevation-prominent, --dsw-elevation-stroke-color
```

官方 Button 规格（`Button.module.css`）：
- `.sm`：height 28px；font-size 12px；line-height 18px；padding 0 10px；`border-radius: var(--dsw-radius-sm)`
- 变体：`.primary` / `.ghost`（hover 用 `--dsw-alias-interactive-bg-hover`）/ `.outline`（`0.5px solid var(--dsw-alias-border-l3)`）
- `:disabled` → `opacity: .4; cursor: not-allowed`

→ 更新按钮直接对齐 `.sm` + `.ghost`/`.outline` 规格，**不引第三方样式**。

## 七、官方插件必须排除

「官方」分组 = `pkg.optional && !pkg.installed`（安装随附、默认关闭）。
这些随 DSH 版本更新，**不放更新按钮**。
DOM 上它们渲染为 `li[data-plugin-item]`，因此选择器只认 `li[data-plugin-package]` 即天然排除。
