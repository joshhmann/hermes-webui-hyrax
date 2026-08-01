/**
 * Node test-harness resolve hook (module.registerHooks).
 *
 * Maps WebUI-origin absolute imports (`/api/hyrax/3d/...`) to the real
 * files under the hyrax-3d package root, so debug/StudioProfileRuntime.js
 * can be imported under `node --test` without a live WebUI. The production
 * page keeps its served absolute URLs unchanged — this hook only exists in
 * the test process, registered via `--import` before test discovery.
 */
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('/api/hyrax/3d/')) {
      const rel = specifier.split('?')[0].slice('/api/hyrax/3d/'.length)
      return { url: pathToFileURL(path.join(packageRoot, rel)).href, shortCircuit: true }
    }
    return nextResolve(specifier)
  },
})
