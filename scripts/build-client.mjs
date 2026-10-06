/**
 * Build `lib/client.js` — the client bundle the host serves to the browser.
 *
 * The host composes a client bundle into one concatenated classic script for the
 * whole page (`ClientModuleRegistry.buildComboScript` joins bundle sources with
 * `;\n`), so a bundle may not contain a top-level `import` or `export`: it must be
 * a self-contained script that registers a factory. This build therefore does the
 * only transformation needed — it wraps the plain scripts under `src/` in the
 * `window.__ModuleLoader__.load({ id, factory })` envelope, with the dictionary
 * placed above the client body inside the same closure so the two can share
 * bindings without an import.
 *
 * No bundler and no dependencies: the input files are already valid classic
 * scripts, so concatenation inside a closure is the whole build.
 *
 * @module dsh-plugin-updater/scripts/build-client
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** The package name the loader keys the factory by; it must match the patch row. */
const ID = 'dsh-plugin-updater'

/**
 * Strip the `export` keyword from a plain script's top-level declarations.
 *
 * The sources are written as ES modules so they stay lintable and importable by
 * tests; only the emitted bundle has to be a classic script. Only the `export `
 * prefix at the start of a line is removed, which is exactly the shape these
 * files use.
 * @param source - one source file's text.
 * @returns the same text without top-level export keywords.
 */
function stripExports(source) {
  return source.replace(/^export\s+(?=(?:const|let|var|function|class)\b)/gm, '')
}

/**
 * Read one source file and make it a classic script.
 * @param name - file name under `src/`.
 * @returns the transformed source.
 */
async function part(name) {
  const source = await readFile(join(root, 'src', name), 'utf8')
  return stripExports(source)
}

const i18n = await part('i18n.js')
const client = await part('client.js')

const bundle = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(ID)},
  factory: (require) => {
    const React = require('react');
${indent(i18n, 4)}
${indent(client, 4)}
    return createUpdaterClient(React);
  }
});
`

/**
 * Indent a block so the emitted closure stays readable.
 * @param text - the block.
 * @param spaces - indentation width.
 * @returns the indented block.
 */
function indent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line))
    .join('\n')
}

await mkdir(join(root, 'lib'), { recursive: true })
await writeFile(join(root, 'lib', 'client.js'), bundle, 'utf8')
process.stdout.write(`built lib/client.js (${String(Buffer.byteLength(bundle))} bytes)\n`)
