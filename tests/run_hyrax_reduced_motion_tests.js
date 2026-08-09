#!/usr/bin/env node
/**
 * Reduced-motion contract tests for Hyrax HQ/VN shell.
 *
 * Verifies:
 * - @media (prefers-reduced-motion: reduce) query exists in CSS
 * - All nonessential CSS animations/transitions are disabled when matched
 * - JS-driven animations (blink timer) can be suppressed
 * - Content/navigation remain fully visible with reduced motion
 * - 2D fallback has no motion-heavy effects
 *
 * Usage:
 *   node tests/run_hyrax_reduced_motion_tests.js
 *
 * Exit code: 0 = all pass, 1 = any failure.
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

// ── Helper: extract @media rules ──
function parseMediaQueries(src) {
  const queries = [];
  const cleaned = src.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < cleaned.length) {
    const mediaStart = cleaned.indexOf('@media', i);
    if (mediaStart === -1) break;
    const braceOpen = cleaned.indexOf('{', mediaStart);
    if (braceOpen === -1) break;
    let depth = 1;
    let j = braceOpen + 1;
    while (j < cleaned.length && depth > 0) {
      if (cleaned[j] === '{') depth++;
      else if (cleaned[j] === '}') depth--;
      j++;
    }
    if (depth !== 0) break;
    const condition = cleaned.substring(mediaStart + 6, braceOpen).trim();
    const body = cleaned.substring(braceOpen + 1, j - 1);
    queries.push({ condition, body });
    i = j;
  }
  return queries;
}

// ── Load sources ───────────────────────────────────────────────────────────
const css = fs.readFileSync(CSS_PATH, 'utf-8');
const vnSrc = fs.readFileSync(VN_PATH, 'utf-8');
const hqSrc = fs.readFileSync(HQ_PATH, 'utf-8');

// ── Run tests ──────────────────────────────────────────────────────────────
function runTests() {
  console.log('═══ Hyrax Reduced Motion Tests ═══\n');

  // ── 1. CSS has prefers-reduced-motion: reduce media query ──
  console.log('── CSS reduced-motion query ──');
  const hasReduceMotionQuery = css.includes('prefers-reduced-motion: reduce');
  assert(hasReduceMotionQuery,
    'CSS must have @media (prefers-reduced-motion: reduce) query');

  // ── 2. Extract the reduced-motion block ──
  const mqList = parseMediaQueries(css);
  const reduceMotionBlock = mqList.find(function(mq) {
    return mq.condition.includes('prefers-reduced-motion: reduce');
  });

  assert(reduceMotionBlock !== undefined,
    'Reduced-motion @media block found via parser');

  // ── 3. Animation/transition properties are disabled ──
  console.log('\n── Animation/transition suppression ──');
  if (reduceMotionBlock) {
    const body = reduceMotionBlock.body;

    // Check for transition: none
    assert(body.includes('transition: none'),
      'Reduced-motion block must disable transitions (transition: none)');

    // Check for animation: none
    assert(body.includes('animation: none'),
      'Reduced-motion block must disable animations (animation: none)');

    // These class names must appear in the reduced-motion block body
    // (they may be comma-separated selectors, not necessarily starting a new rule)
    const requiredCoverage = ['chibi', 'vn-portrait', 'hyrax-toast'];
    requiredCoverage.forEach(function(cls) {
      const covered = body.includes(cls);
      assert(covered,
        'Reduced-motion block must cover .' + cls);
    });
  }

  // ── 4. Keyframe animations exist and are suppressible ──
  console.log('\n── Keyframe animations ──');
  const keyframeNames = [];
  const kfRegex = /@keyframes\s+([a-zA-Z0-9_-]+)\s*\{/g;
  let m;
  while ((m = kfRegex.exec(css)) !== null) {
    keyframeNames.push(m[1]);
  }

  // The CSS defines: vn-enter, vn-blink, toast-in
  assert(keyframeNames.length >= 2,
    'CSS must define at least 2 keyframe animations (found: ' + keyframeNames.join(', ') + ')');

  // Check that each keyframe is used somewhere (CSS animation property or JS)
  keyframeNames.forEach(function(name) {
    const escaped = name.replace(/-/g, '\\-');
    // Count how many times the keyframe name appears outside its @keyframes definition
    // (i.e. in animation: or animation-name: CSS properties)
    const cssUsage = new RegExp('(animation|animation-name)\\s*:\\s*[^;}]*' + escaped, 'g');
    const cssMatches = css.match(cssUsage) || [];
    // Count JS references to the keyframe name (for inline styles)
    const jsRegex = new RegExp(escaped, 'g');
    const jsMatches = ((vnSrc + hqSrc).match(jsRegex) || []).length;

    // The keyframe is "used" if it appears in at least one CSS animation property or JS assignment
    const isUsed = cssMatches.length >= 1 || jsMatches >= 1;
    assert(isUsed,
      'Keyframe "' + name + '" must be used by at least one element ' +
      '(CSS animation refs: ' + cssMatches.length +
      ', JS refs: ' + jsMatches + ')');
  });

  // ── 5. Retired vn-blink animation is fully removed ──
  // The old monolithic vn.js drove a vn-blink cursor animation. The vn2
  // surface (vnShell/vnDialogue/vnStage) does not implement it — the dead
  // keyframe was removed from hyrax.css. Nothing may ship an orphan blink
  // animation that the reduced-motion contract cannot cover.
  console.log('\n── JS animation suppression ──');
  const hasBlinkTimer = vnSrc.includes('_scheduleBlink') || vnSrc.includes('vn-blink');
  assert(!hasBlinkTimer,
    'vn.js has no blink timer animation (retired with the old surface)');
  assert(!css.includes('vn-blink'),
    'hyrax.css has no dead vn-blink keyframe');

  // ── 6. Content remains visible when motion is disabled ──
  console.log('\n── Content visibility ──');
  if (reduceMotionBlock) {
    const body = reduceMotionBlock.body;
    assert(!body.includes('display: none'),
      'Reduced-motion block must NOT hide content (no display:none)');
    assert(!body.includes('visibility: hidden'),
      'Reduced-motion block must NOT hide content (no visibility:hidden)');
    assert(!body.includes('opacity: 0'),
      'Reduced-motion block must NOT hide content (no opacity:0)');
  }

  // ── 7. 2D fallback has no heavy animations ──
  console.log('\n── 2D fallback restraint ──');
  // Check that hq.js doesn't add inline animation styles
  const hqAnimRefs = (hqSrc.match(/\.style\.animation/g) || []).length +
    (hqSrc.match(/animation:/g) || []).length;
  assert(hqAnimRefs < 3,
    'hq.js 2D fallback should avoid inline animations (got ' + hqAnimRefs + ' refs)');

  // ── 8. No excessive motion in 2D fallback CSS ──
  console.log('\n── 2D fallback CSS motion ──');
  // The iso-floor transform uses rotateX/Z — this is a static visual style,
  // not a motion animation. The .chibi:hover has a transition that IS covered.
  const hasChibiTransition = css.includes('.chibi') && css.includes('transition');
  assert(hasChibiTransition,
    'Chibi hover transition exists in CSS (covered by reduced-motion)');

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
  if (failures.length > 0) {
    console.error('FAILURES:');
    failures.forEach(function(f) { console.error('  ✗ ' + f); });
    process.exit(1);
  }
}

runTests();
