/**
 * ESM module loader hook that redirects `three` and `@pixiv/three-vrm`
 * imports to test fakes during `node --test`.
 *
 * Usage: node --experimental-loader ./tests/loader.mjs --test ...
 */
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const baseDir = new URL('./', import.meta.url).pathname
const fakeThree = pathToFileURL(resolvePath(baseDir, 'fakes/three.js')).href
const fakeVrm = pathToFileURL(resolvePath(baseDir, 'fakes/vrm.js')).href

export function resolve(specifier, context, nextResolve) {
  // Redirect 'three' and its sub-paths to the fake
  if (specifier === 'three' || specifier.startsWith('three/')) {
    return { url: fakeThree, shortCircuit: true }
  }
  // Redirect @pixiv/three-vrm
  if (specifier === '@pixiv/three-vrm') {
    return { url: fakeVrm, shortCircuit: true }
  }
  return nextResolve(specifier)
}
