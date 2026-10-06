# dsh-plugin-updater

[English](README.md) | 中文

在侧边栏「插件」页更新已安装的 DSH 插件 —— 每个插件开关旁一个「更新」按钮、工具栏一键「更新全部」，以及一个可安装或回退到任意已发布版本的「历史版本」选择器。官方插件不动，因为它们跟随 DSH 版本更新。

适配 **DSH 0.2.0-rc.2 Web**（桌面端与 Web 端共用同一份运行时）。

## 功能

- **每个第三方插件卡片上都有「更新」按钮**，位于其开关左侧。仅在有新版本时出现，旁边一个徽标同时写明两个版本（`1.2.0 → 1.3.0`）。已是最新的插件完全不显示任何东西。
- 工具栏的**「检查更新」**，以及检查出结果后的**「更新全部 (N)」**。更新逐个执行，单个失败不会中断其余。
- 插件详情页的**「历史版本」**打开一张表，列出可安装的每个版本、该版本声明的确切 DSH 范围，以及每行的安装按钮。回退一次失败的升级是一等操作，不是变通手段。
- **更新立即生效。** 安装结束时重新加载 profile，所以新代码就是正在运行的代码 —— 无需重启。
- **官方插件永不出现更新入口。** 它们随 DSH 发布；更新器排除的正是官方页面排除的那一组内置包。
- 明暗双主题，以及宿主提供的两种语言（中英），都跟随页面自身设置。

## 安装

从 GitHub：

```sh
dsh plugin --profile <profile> add github:mczh20/dsh-plugin-updater
```

本地目录也可以：

```sh
dsh plugin --profile <profile> add file:/路径/dsh-plugin-updater
```

安装后重启一次 DSH，然后打开侧边栏的**插件**页。

> **尚未发布到 npm。** 在发布之前 `dsh plugin add dsh-plugin-updater` 无法解析，请使用上面的 GitHub 形式。

## 会动什么、不会动什么

| 插件 | 更新按钮 | 历史版本按钮 |
|---|---|---|
| 第三方，从 registry 安装 | ✅ 有更新版本时 | ✅ 每个已发布版本 |
| 第三方，从 `github:` 安装 | ✅ 仓库有新提交时 | ✅ 它的 tag；无 tag 时列 commit |
| 第三方，从 `link:` / `file:` 安装 | ❌ 没有 registry 版本可比 | ❌ 没有历史可列 |
| DSH 内置（`@deepseek-ai/dsh-base` 等） | ❌ 永不 | ❌ 永不 |
| 随附的可选组合包（「官方」分组） | ❌ 永不 | ❌ 永不 |

## 安全

更新器会执行本机代码：一次更新会运行 pnpm，而 pnpm 会运行目标包的安装脚本。它对此的处理是：

- **每条路由都限制在 loopback。** 请求必须来自 loopback socket、`Host` 必须是 loopback、且带同源浏览器标记。**从不信任 `X-Forwarded-For`。** 其它来源的页面无法驱动它。
- **安装版本只能指向已安装的包**，且它声明的版本必须出现在 Host 刚刚读取的列表里。浏览器无法安装一个新包；`github:` 安装始终解析到该包**原本来自的仓库**，绝不是请求里指定的仓库。
- **包名与版本先按形状校验**才会交给 pnpm，任何请求都无法构造出被 pnpm 当作选项解析的 token。
- **所有写操作都经官方管理器的 `installBundle`。** 更新器绝不自己拿 pnpm 改 profile；管理器会在每次运行前后快照并恢复 profile 清单。
- **中断的安装会被修复。** 若下载中途失败，pnpm 可能删掉 `node_modules` 里的包而清单仍写着它 —— 而管理器自身的恢复命令 `pnpm install --frozen-lockfile` **修不回**缺失的顶层链接。更新器会重新加上**原来的确切版本**，这才修得回来。
- **更新绝不改变插件的启用状态。** 关着的插件更新后仍然关着。

## 配置

无需配置。更新器复用当前 profile 自己的包管理器与 registry 配置，因此镜像源或私有源的行为与正常安装完全一致。

## 实现方式

两个半区，都是普通的 DSH 插件：

- **Host 半区**（`lib/index.js`）在官方 `pluginManager` 服务之上注册六条 loopback 门禁路由：`check`、`state`、`update`、`update-all`、`versions`、`install`。
- **Client 半区**（`lib/client.js`）渲染这些控件。**「历史版本」按钮走官方 `plugins.detail.actions` slot**；列表页的控件则注入进页面 DOM，因为列表页**没有暴露任何 slot**。两者都锚定在 `data-*` 属性与 ARIA role 上，而不是会随构建变化的类名。

一次检查只向 profile 自己的 registry 要**一个**精简 packument，它就答出了每个已发布版本**以及各版本声明的 DSH 范围** —— 所以版本表只花一次请求。`github:` 插件读它的 tag；没有 tag 时读 commit。两者都不带兼容性范围，而逐行读取会按行消耗 GitHub 的匿名限流，因此那一列在那里**按设计留空**。

## 开发

```sh
npm install
npm test        # 先构建客户端 bundle，再跑 73 项测试
npm run build   # 从 src/ 重建 lib/client.js
```

`lib/client.js` 是生成物。宿主会把所有客户端 bundle 拼成一个 classic script 交给页面，因此 bundle 里**不能有顶层 `import` / `export`**；`scripts/build-client.mjs` 把 `src/` 下的普通脚本包进加载器期望的信封里。**改完 `src/` 务必执行 `npm run build`** —— 构建陈旧时测试会失败。

## 许可证

MIT
