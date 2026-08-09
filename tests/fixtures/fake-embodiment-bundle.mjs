/**
 * Test fixture — fake embodiment bundle for the Hyrax migration Node harness.
 *
 * Mirrors the production contract of static/hyrax/3d/embodiment-bundle.js:
 *   export async function mountTaiLoft(host, onExit, configuration)
 *     → Promise<() => void>  (cleanup, called exactly once by the caller)
 *
 * Records every call on globalThis so tests/run_hyrax_migration_tests.js can
 * assert exact production mount arguments and exact-once cleanup.
 */
'use strict';

export async function mountTaiLoft(host, onExit, configuration) {
  globalThis.__FAKE_LOFT_CALLS = globalThis.__FAKE_LOFT_CALLS || [];
  globalThis.__FAKE_LOFT_CALLS.push({ host, onExit, configuration });
  globalThis.__FAKE_LOFT_MOUNTED = true;
  // Simulate a mounted loft shell.
  const shell = document.createElement('section');
  shell.className = 'tai-loft';
  if (host && typeof host.appendChild === 'function') host.appendChild(shell);
  let cleaned = false;
  return function cleanup() {
    if (cleaned) return;
    cleaned = true;
    globalThis.__FAKE_LOFT_CLEANUPS = (globalThis.__FAKE_LOFT_CLEANUPS || 0) + 1;
    if (shell && shell.remove) { try { shell.remove(); } catch (_) {} }
    globalThis.__FAKE_LOFT_MOUNTED = false;
  };
}
