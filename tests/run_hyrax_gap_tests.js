#!/usr/bin/env node
/**
 * Gap tests — features that should exist but currently don't.
 *
 * These tests should FAIL (RED) before implementation, then PASS (GREEN) after.
 *
 * Gaps identified:
 * 1. Very-narrow viewport breakpoint (320-375px)
 * 2. Escape key handler to return from VN to HQ map
 * 3. Toast timer tracked and cleared on unmount
 * 4. aria-busy on loading states
 * 5. touch-action: manipulation on interactive elements
 * 6. aria-disabled on staged/disabled chibis
 * 7. Focus management on VN close (return focus to chibi/HQ)
 *
 * Usage:
 *   node tests/run_hyrax_gap_tests.js
 *
 * Exit code: 0 = all pass (full coverage), 1 = some gaps remain.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Resolve paths ──────────────────────────────────────────────────────────
const CSS_PATH = path.join(__dirname, '..', 'static', 'hyrax', 'hyrax.css');
const VN_PATH = path.join(__dirname, '..', 'static', 'hyrax', 'vn.js');
const HQ_PATH = path.join(__dirname, '..', 'static', 'hyrax', 'hq.js');

// ── Helpers ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(ok, msg) {
  if (ok) { passed++; return; }
  failed++;
  const e = new Error();
  const stack = (e.stack || '').split('\n').slice(2, 4).join(' → ').trim();
  failures.push(`${msg}  [${stack || '?'}]`);
}

// ── Load sources ───────────────────────────────────────────────────────────
const css = fs.readFileSync(CSS_PATH, 'utf-8');
const vnSrc = fs.readFileSync(VN_PATH, 'utf-8');
const hqSrc = fs.readFileSync(HQ_PATH, 'utf-8');

// ── Run tests ──────────────────────────────────────────────────────────────
function runTests() {
  console.log('═══ Hyrax Gap Tests (RED phase) ═══\n');

  // ── Gap 1: Very-narrow viewport breakpoint ──
  console.log('── Gap 1: Responsive at 320px ──');
  // The CSS has a 720px breakpoint but not one for very-narrow phones
  const hasNarrowBreakpoint = css.includes('max-width: 480px') ||
    css.includes('max-width: 375px') || css.includes('max-width: 320px');
  assert(hasNarrowBreakpoint,
    'CSS must have a very-narrow @media breakpoint (max-width: 480px or tighter)');

  // ── Gap 2: Escape key handler ──
  console.log('\n── Gap 2: Escape key returns to HQ ──');
  // VN should handle Escape key to go back to HQ map
  const hasEscapeHandler = vnSrc.includes('Escape') || vnSrc.includes("'Escape'") ||
    vnSrc.includes('"Escape"') || vnSrc.includes('keydown') ||
    vnSrc.includes('keyup');
  // We need an Escape handler specifically for returning to HQ
  const hasEscapeReturn = vnSrc.match(/['"]Escape['"]/);
  assert(hasEscapeReturn !== null,
    'vn.js must handle Escape key to return to HQ map');

  // ── Gap 3: Toast timer is tracked for cleanup ──
  console.log('\n── Gap 3: Toast timer tracking ──');
  // The setTimeout that removes the toast should be tracked so it can be cleared
  const hasToastTimerTracking = vnSrc.includes('_toastTimer') ||
    vnSrc.includes('clearTimeout(toastTimer') ||
    vnSrc.includes('_toastTimeout');
  assert(hasToastTimerTracking,
    'vn.js must track toast removal timer for cleanup on unmount');

  // ── Gap 4: aria-busy on loading states ──
  console.log('\n── Gap 4: aria-busy on loading ──');
  const hasAriaBusy = vnSrc.includes('aria-busy') || vnSrc.includes('aria-busy');
  assert(hasAriaBusy,
    'vn.js should indicate busy state (aria-busy) during loading/processing');

  // ── Gap 5: touch-action: manipulation ──
  console.log('\n── Gap 5: touch-action: manipulation ──');
  const hasTouchAction = css.includes('touch-action: manipulation') ||
    css.includes('touch-action');
  assert(hasTouchAction,
    'CSS should set touch-action: manipulation on interactive elements for mobile');

  // ── Gap 6: aria-disabled on staged chibis ──
  console.log('\n── Gap 6: aria-disabled on staged chibis ──');
  const hasAriaDisabled = hqSrc.includes('aria-disabled') ||
    hqSrc.includes('aria-disabled');
  assert(hasAriaDisabled,
    'hq.js should set aria-disabled on staged/unavailable chibis');

  // ── Gap 7: Focus management on VN → HQ return ──
  console.log('\n── Gap 7: Focus restoration on VN close ──');
  // When returning from VN to HQ, focus should go somewhere sensible
  const hasFocusRestore = vnSrc.includes('.focus()') || vnSrc.includes('focus');
  assert(hasFocusRestore,
    'vn.js should restore focus when returning to HQ');

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
  if (failures.length > 0) {
    console.error('GAPS REMAINING (RED):');
    failures.forEach(function(f) { console.error('  ▸ ' + f); });
    process.exit(1);
  }
  console.log('All gaps closed. GREEN phase complete.');
}

runTests();
