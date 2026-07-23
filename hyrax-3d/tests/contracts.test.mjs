import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const packageRoot = new URL('../', import.meta.url)
const builtModule = new URL('../static/hyrax/3d/embodiment-bundle.js', packageRoot)

test('production defaults are explicit in the public mount API', async () => {
  const entrySource = await readFile(new URL('src/index.ts', packageRoot), 'utf8')

  assert.match(entrySource, /vrmUrl:\s*['"]\/api\/hyrax\/assets\/tai\.embodiment\.vrm['"]/)
  assert.match(entrySource, /development:\s*false/)
})

test('the production bundle is statically importable and exports the mount API', async () => {
  const source = await readFile(builtModule, 'utf8')
  const encoded = Buffer.from(source, 'utf8').toString('base64')
  const module = await import(`data:text/javascript;base64,${encoded}`)

  assert.equal(typeof module.mountTaiLoft, 'function')
})
