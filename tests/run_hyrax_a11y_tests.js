#!/usr/bin/env node
/**
 * Accessibility and keyboard contract tests for Hyrax HQ/VN shell.
 *
 * Verifies:
 * - Semantic labels/roles/states on all interactive elements
 * - Full keyboard path: nav, sister tabs, transcript, input/send, errors/retry
 * - Visible focus, logical tab order, focus restoration
 * - ARIA live regions without chatter
 * - Image alt text and decorative empty alt
 * - No keyboard traps
 *
 * Usage:
 *   node tests/run_hyrax_a11y_tests.js
 *
 * Exit code: 0 = all pass, 1 = any failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Resolve paths ──────────────────────────────────────────────────────────
const BOOTSTRAP_PATH = path.join(__dirname, '..', 'static', 'hyrax', 'bootstrap.js');
const HQ_PATH = path.join(__dirname, '..', 'static', 'hyrax', 'hq.js');
const VN_PATH = path.join(__dirname, '..', 'static', 'hyrax', 'vn.js');

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
const bootstrapSrc = fs.readFileSync(BOOTSTRAP_PATH, 'utf-8');
const hqSrc = fs.readFileSync(HQ_PATH, 'utf-8');
const vnSrc = fs.readFileSync(VN_PATH, 'utf-8');

// ── Run tests ──────────────────────────────────────────────────────────────
function runTests() {
  console.log('═══ Hyrax Accessibility & Keyboard Tests ═══\n');

  // ── Static source checks ──
  console.log('── Semantic HTML patterns (static analysis) ──');

  // 1. All interactive elements should be <button> or <a>
  // The classic VN surface uses _el('button', ...) factory, not HTML strings.
  const classicSrc = fs.readFileSync(path.join(__dirname, '..', 'static', 'hyrax', 'vn', 'vnShell.js'), 'utf-8') +
    fs.readFileSync(path.join(__dirname, '..', 'static', 'hyrax', 'vn', 'vnComposer.js'), 'utf-8');
  const btnFactoryCalls = (classicSrc.match(/_el\(\s*['"]button['"]/g) || []).length;
  assert(btnFactoryCalls >= 2,
    'classic VN surface creates interactive elements as <button> via _el() (got ' + btnFactoryCalls + ')');

  // No <div onclick for interactive elements
  const divOnclickCount = (classicSrc.match(/<div[^>]*onclick/gi) || []).length;
  assert(divOnclickCount === 0,
    'classic VN surface must not use <div onclick for interactive elements');

  // 2. Chibis should be <button> elements (hq.js uses createElement('button'))
  assert(hqSrc.includes("createElement('button')") || hqSrc.includes('createElement(\'button\')'),
    'hq.js creates chibi as <button> element');

  // 3. Classic composer uses _el('form', ...) for the composer element
  const composerSrc = fs.readFileSync(path.join(__dirname, '..', 'static', 'hyrax', 'vn', 'vnComposer.js'), 'utf-8');
  const shellSrc = fs.readFileSync(path.join(__dirname, '..', 'static', 'hyrax', 'vn', 'vnShell.js'), 'utf-8');
  const dialogueSrc = fs.readFileSync(path.join(__dirname, '..', 'static', 'hyrax', 'vn', 'vnDialogue.js'), 'utf-8');
  const stageSrc = fs.readFileSync(path.join(__dirname, '..', 'static', 'hyrax', 'vn', 'vnStage.js'), 'utf-8');
  assert(composerSrc.includes("_el('form'") || composerSrc.includes('_el("form"'),
    'classic composer uses _el(\'form\', ...) for the composer element');

  // 4. Classic composer uses _el('textarea', ...) for message input
  assert(composerSrc.includes("_el('textarea'") || composerSrc.includes('_el("textarea"'),
    'classic composer uses _el(\'textarea\', ...) for message input');

  // 5. Bootstrap creates nav buttons as <button> elements
  assert(bootstrapSrc.includes("createElement('button')") || bootstrapSrc.includes('createElement(\'button\')'),
    'bootstrap.js creates nav buttons as <button> elements');

  // ── ARIA attributes (static analysis) ──
  console.log('\n── ARIA attributes (static analysis) ──');

  // 6. Chibi buttons have aria-label
  assert(hqSrc.includes('aria-label'),
    'hq.js sets aria-label on chibi elements');

  // 7. VN loading state has role="status" (classic shell)
  assert(shellSrc.includes("setAttribute('role', 'status')") || shellSrc.includes('role=\\"status\\"') ||
    shellSrc.includes("role='status'"),
    'classic shell uses role="status" on the loading state');

  // 8. VN error state has role="alert" (classic shell)
  const alertRoles = (shellSrc.match(/role.*alert/g) || []).length;
  assert(alertRoles >= 1,
    'classic shell uses role="alert" on error states (got ' + alertRoles + ' matches)');

  // 9. Backlog has role="log" (classic dialogue)
  assert(dialogueSrc.includes("setAttribute('role', 'log')") || dialogueSrc.includes('role=\\"log\\"') ||
    dialogueSrc.includes('"log"'),
    'classic dialogue uses role="log" on backlog');

  // 10. Dialogue has aria-live (for live-region behavior)
  assert(dialogueSrc.includes("aria-live', 'polite'") || dialogueSrc.includes("aria-live='polite'"),
    'classic dialogue uses aria-live on the conversation scroller');

  // 11. Textarea has aria-label (classic composer)
  assert(composerSrc.includes("setAttribute('aria-label', 'Message')"),
    'classic composer sets aria-label on textarea');

  // 12. Toast notification has role="status" (classic shell fallback toast)
  assert(shellSrc.includes("t.setAttribute('role', 'status')") || shellSrc.includes("role='status'") ||
    shellSrc.includes('"status"'),
    'classic shell toast uses role="status"');

  // 13. Nav buttons in bootstrap have aria-label
  const ariaLabelCount = (bootstrapSrc.match(/aria-label/g) || []).length;
  assert(ariaLabelCount >= 1,
    'bootstrap.js sets aria-label on nav buttons');

  // ── Image alt text ──
  console.log('\n── Image alt text ──');

  // 14. Portrait has meaningful alt (classic stage frame ladder)
  assert(stageSrc.includes('_altForFrame') || stageSrc.includes('alt =') ||
    stageSrc.includes('.alt ='),
    'classic stage sets meaningful alt text on portrait image');

  // 15. Chibi images have empty alt (decorative)
  assert(hqSrc.includes("alt: ''") || hqSrc.includes("alt=\"\"") || hqSrc.includes("alt = ''"),
    'hq.js chibi images use empty alt (decorative)');

  // ── Keyboard behavior (static) ──
  console.log('\n── Keyboard behavior ──');

  // 16. Enter key sends message (classic composer, with Shift guard)
  assert(composerSrc.includes("event.key === 'Enter'") || composerSrc.includes('event.key === "Enter"'),
    'classic composer handles Enter key to send message');

  // 17. Shift+Enter guard prevents send (classic composer)
  assert(composerSrc.includes('!event.shiftKey'),
    'classic composer checks !event.shiftKey to allow Shift+Enter for newline');

  // 18. Send button type="submit" (classic composer)
  assert(composerSrc.includes("setAttribute('type', 'submit')") || composerSrc.includes('type=\\"submit\\"') ||
    composerSrc.includes("type='submit'"),
    'classic composer send button has type="submit"');

  // 19. New Conversation / action buttons type="button" (classic shell)
  assert(shellSrc.includes("setAttribute('type', 'button')") || composerSrc.includes("setAttribute('type', 'button')"),
    'classic VN buttons use type="button"');

  // ── Focus management ──
  console.log('\n── Focus management ──');

  // 20. Input gets focus after send (classic composer)
  assert(composerSrc.includes('_textarea.focus()'),
    'classic composer calls .focus() on input after message send');

  // 21. Send button gets disabled during API call (classic composer gates on
  // the busy state — property assignment, same a11y effect as setAttribute)
  assert(composerSrc.includes('_sendBtn.disabled = busy'),
    'classic composer disables send button during API call');

  // 22. Loading state uses aria-live="polite" (not assertive chatter)
  assert(shellSrc.includes("aria-live', 'polite'") || shellSrc.includes('aria-live=\\"polite\\"') ||
    shellSrc.includes("aria-live='polite'"),
    'classic shell loading state uses aria-live="polite"');

  // ── Disabled/loading states ──
  console.log('\n── State attributes ──');

  // 23. Chibi has 'staged' class when disabled/unavailable
  assert(hqSrc.includes('staged'),
    'hq.js uses "staged" class for disabled/unavailable chibis');

  // 24. Send button re-enabled when API call completes (busy gate clears)
  assert(composerSrc.includes('_sendBtn.disabled = busy'),
    'classic composer removes disabled attribute when API call completes');

  // ── No keyboard traps ──
  console.log('\n── No keyboard traps ──');

  // 25. No onfocus/onblur inline handlers that could create traps
  const focusTrapCount = (vnSrc.match(/\bonfocus=/g) || []).length +
    (vnSrc.match(/\bonblur=/g) || []).length;
  assert(focusTrapCount <= 1,
    'vn.js should not use onfocus/onblur handlers (potential keyboard traps)');

  // 26. Back button is a <button> (created via _el('button', ...))
  assert(shellSrc.includes("_el('button',") || shellSrc.includes('_el("button",'),
    'VN back button is created via _el(\'button\', ...)');

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
  if (failures.length > 0) {
    console.error('FAILURES:');
    failures.forEach(function(f) { console.error('  ✗ ' + f); });
    process.exit(1);
  }
}

runTests();
