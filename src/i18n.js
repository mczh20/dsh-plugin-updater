/**
 * Dictionary for the updater's own text.
 *
 * A plain script on purpose: the client bundle is served as one concatenated
 * classic script, so its parts declare their own bindings instead of importing
 * each other. `scripts/build-client.mjs` places this file above `client.js` inside
 * the module factory, which is what makes `UPDATER_NS`, `UPDATER_EN` and
 * `UPDATER_ZH` visible there.
 */

/** Locale namespace; the client half binds this. */
const UPDATER_NS = 'pluginUpdater'

/** English source strings. */
const UPDATER_EN = {
  check: 'Check for updates',
  checking: 'Checking…',
  update: 'Update',
  updateAll: 'Update all',
  updateAllCount: 'Update all ({count})',
  updating: 'Updating…',
  updated: 'Updated',
  updatedTo: 'Updated to {version}',
  retry: 'Retry',
  dismiss: 'Dismiss',

  versionFrom: '{from} → {to}',
  restartNotice: 'Updated to {version} · restart DSH',
  restartSummary: '{count} updated · restart DSH to take effect',

  allCurrent: 'All plugins are up to date.',
  foundCount: '{count} updates available.',
  checkFailed: 'Could not check for updates.',
  busy: 'Another update is already running.',

  summaryOk: '{count} updated.',
  summaryFailed: '{count} failed.',
  repaired: 'Restored the previous version.',
  repairFailed: 'Restoring the previous version failed; reinstall the plugin.',

  failedIncompatible: '{name} is incompatible with this DSH version.',
  failedIncompatiblePeers: 'Requires: {peers}',
  failedBuildBlocked: 'Package scripts were blocked: {packages}',
  failedNotApplied: 'The registry version did not replace the installed one.',
  failedNotNewer: 'That version is not newer than the installed one.',
  failedAhead: 'That version is not published yet.',
  failedUnknownPackage: 'That plugin is not installed.',
  failedNotRegistry: 'Installed from a path or git address; update it at its source.',
  failedBuiltin: 'Ships with DSH and follows the DSH release.',
  failedGeneric: 'The update could not be completed.',

  updateOne: 'Update {name}',

  // Version history dialog.
  history: 'Versions',
  historyTitle: 'Versions — {name}',
  historyLoading: 'Reading version history…',
  historyEmpty: 'This plugin publishes no other versions.',
  historyColVersion: 'Version',
  historyColRange: 'Works with DSH',
  historyColAction: 'Install',
  historyRangeUnknown: '—',
  historyRangeMissing: 'not declared',
  historyCurrent: 'Installed',
  historyLatest: 'latest',
  historyInstall: 'Install',
  historyInstalling: 'Installing…',
  historyInstalled: 'Installed {version}',
  historyCommit: 'revision',
  historySubject: 'revision',
  historySourceRegistry: 'npm registry',
  historySourceGithub: 'GitHub',
  historySourceRepo: 'repository: {repo}',
  historyRangeOurs: 'This runtime',
  historyRangeOther: 'Other runtime',
  historyRangeNote: 'Compatibility is what the version declares; a mismatch is a warning, not a block.',
  historyClose: 'Close',
  historyCount: '{count} versions',
  historyRateLimited: 'GitHub is rate-limiting this machine; try again later.',
  historyLocal: 'Installed from a local path; it has no version history.',

  installAlreadyCurrent: 'That version is already installed.',
  installUnknownVersion: 'That version is not published.',
  installLocalSource: 'This plugin was installed from a local path.',
}

/** Chinese strings, matching the host page's own vocabulary. */
const UPDATER_ZH = {
  check: '检查更新',
  checking: '检查中…',
  update: '更新',
  updateAll: '更新全部',
  updateAllCount: '更新全部（{count}）',
  updating: '更新中…',
  updated: '已更新',
  updatedTo: '已更新到 {version}',
  retry: '重试',
  dismiss: '关闭',

  versionFrom: '{from} → {to}',
  restartNotice: '已更新到 {version} · 重启 DSH 后生效',
  restartSummary: '已更新 {count} 个 · 重启 DSH 后生效',

  allCurrent: '所有插件都是最新版。',
  foundCount: '发现 {count} 个可更新。',
  checkFailed: '检查更新失败。',
  busy: '已有更新正在进行。',

  summaryOk: '已更新 {count} 个。',
  summaryFailed: '{count} 个失败。',
  repaired: '已恢复到更新前的版本。',
  repairFailed: '恢复更新前的版本失败，请重新安装该插件。',

  failedIncompatible: '{name} 与当前 DSH 版本不兼容。',
  failedIncompatiblePeers: '要求：{peers}',
  failedBuildBlocked: '安装脚本被拦截：{packages}',
  failedNotApplied: 'registry 上的版本没有替换掉已安装的版本。',
  failedNotNewer: '该版本不比已安装的版本新。',
  failedAhead: '该版本尚未发布。',
  failedUnknownPackage: '该插件未安装。',
  failedNotRegistry: '来自本地路径或 git 地址，请在来源处更新。',
  failedBuiltin: '随 DSH 一起发布，跟随 DSH 版本更新。',
  failedGeneric: '更新未能完成。',

  updateOne: '更新 {name}',

  // 历史版本弹窗。
  history: '历史版本',
  historyTitle: '历史版本 — {name}',
  historyLoading: '正在读取版本历史…',
  historyEmpty: '该插件没有发布其它版本。',
  historyColVersion: '版本',
  historyColRange: '适配 DSH',
  historyColAction: '安装',
  historyRangeUnknown: '—',
  historyRangeMissing: '未声明',
  historyCurrent: '当前',
  historyLatest: '最新',
  historyInstall: '安装',
  historyInstalling: '安装中…',
  historyInstalled: '已安装 {version}',
  historyCommit: '修订',
  historySubject: '修订',
  historySourceRegistry: 'npm 源',
  historySourceGithub: 'GitHub',
  historySourceRepo: '仓库：{repo}',
  historyRangeOurs: '适配当前',
  historyRangeOther: '不适配当前',
  historyRangeNote: '兼容性按该版本自己的声明显示；不匹配只是提醒，不会阻止安装。',
  historyClose: '关闭',
  historyCount: '共 {count} 个版本',
  historyRateLimited: 'GitHub 正在限制本机的请求频率，请稍后再试。',
  historyLocal: '该插件从本地路径安装，没有版本历史。',

  installAlreadyCurrent: '该版本已经安装。',
  installUnknownVersion: '该版本不存在。',
  installLocalSource: '该插件是从本地路径安装的。',
}
