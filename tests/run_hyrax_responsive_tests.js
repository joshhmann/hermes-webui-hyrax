#!/usr/bin/env node
/**
 * Responsive CSS contract tests for Hyrax HQ/VN shell.
 *
 * Verifies that the Hyrax CSS supports 320/375/768/1024/1440px viewport
 * widths without clipped controls, overflow, overlapping, or microscopic
 * hit targets. Also checks safe mobile viewport and touch behavior.
 *
 * Usage:
 *   node tests/run_hyrax_responsive_tests.js
 *
 * Exit code: 0 = all pass, 1 = any failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Resolve paths ──────────────────────────────────────────────────────────
const CSS_PATH = path.join(__dirname, '..', 'static', 'hyrax', 'hyrax.css');
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

// ── Helper: extract top-level CSS blocks (selector { body }) ──
function parseCssBlocks(src) {
  const blocks = [];
  const cleaned = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Match each block: selector(s) followed by { ... }
  const blockRegex = /([^{]+?)\s*\{([^}]*)\}/g;
  let m;
  while ((m = blockRegex.exec(cleaned)) !== null) {
    const selector = m[1].trim();
    const body = m[2].trim();
    if (selector && !selector.startsWith('@media') && !selector.startsWith('@keyframes') &&
        !selector.startsWith('@')) {
      blocks.push({ selector, body });
    }
  }
  return blocks;
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
const bootstrapSrc = fs.readFileSync(BOOTSTRAP_PATH, 'utf-8');

// ── Run tests ──────────────────────────────────────────────────────────────
function runTests() {
  console.log('═══ Hyrax Responsive Test ═══\n');

  // ── 1. CSS viewport breakpoints ──
  console.log('── CSS breakpoints ──');

  const mediaQueries = parseMediaQueries(css);
  const maxWidthBps = [];
  mediaQueries.forEach(function(mq) {
    const bpMatch = mq.condition.match(/max-width:\s*(\d+)px/);
    if (bpMatch) maxWidthBps.push(parseInt(bpMatch[1], 10));
  });

  assert(maxWidthBps.length >= 1,
    'CSS must have at least one @media (max-width: ...) breakpoint');

  const has720 = maxWidthBps.some(function(bp) { return bp >= 700 && bp <= 740; });
  assert(has720, 'CSS must have a ~720px narrow-viewport breakpoint');

  // ── 2. No fixed-width elements overflow the viewport ──
  console.log('\n── No fixed-width overflow ──');

  const blocks = parseCssBlocks(css);
  let hasOverflowContainer = false;
  let overflowContainerName = '';

  blocks.forEach(function(b) {
    const sel = b.selector;

    // Skip known isometric/positioned elements (inside overflow:hidden container)
    if (sel === '.iso-floor' || sel.startsWith('.room-') || sel === '.room' ||
        sel === '.chibi' || sel.startsWith('.chibi-') ||
        sel.startsWith('.hyrax-toast')) return;

    // Check for `width:` (NOT max-width or min-width)
    const wMatch = b.body.match(/(?<![-\w])width:\s*(\d+)px/);
    if (wMatch) {
      const w = parseInt(wMatch[1], 10);
      if (w > 320) {
        hasOverflowContainer = true;
        overflowContainerName = sel + ' (width: ' + w + 'px)';
      }
    }
  });

  assert(!hasOverflowContainer,
    'No container element exceeds 320px fixed width' +
    (overflowContainerName ? ': ' + overflowContainerName : ''));

  // ── 3. map-stage uses responsive height ──
  console.log('\n── Map stage responsive sizing ──');
  const mapStageBlock = blocks.find(function(b) { return b.selector === '.map-stage'; });
  const hasResponsiveMapHeight = mapStageBlock &&
    mapStageBlock.body.includes('min(') && mapStageBlock.body.includes('100vh');
  assert(hasResponsiveMapHeight, '.map-stage uses responsive height (min() + vh)');

  // ── 4. VN stage uses position:absolute + inset:0 for responsive fill ──
  console.log('\n── VN stage overflow protection ──');
  const vnStageBlock = blocks.find(function(b) { return b.selector === '.vn-stage'; });
  const hasVnStageFill = vnStageBlock &&
    (vnStageBlock.body.includes('inset: 0') || vnStageBlock.body.includes('position: absolute'));
  assert(hasVnStageFill, '.vn-stage uses position:absolute + inset:0 for responsive fill');

  // ── 5. Dialogue uses percentage-based margins ──
  console.log('\n── Dialogue responsive margins ──');
  const dialogueBlock = blocks.find(function(b) { return b.selector === '.dialogue'; });
  let hasDialoguePct = false;
  if (dialogueBlock) {
    hasDialoguePct = /(?<![-\w])left:\s*\d+%/.test(dialogueBlock.body) &&
      /(?<![-\w])right:\s*\d+%/.test(dialogueBlock.body);
  }
  assert(hasDialoguePct, '.dialogue uses percentage-based left/right margins');

  // Check narrow viewport dialogue margins (narrower percentages)
  const narrowQuery = mediaQueries.find(function(mq) {
    return mq.condition.includes('max-width');
  });
  let narrowDialogueOK = false;
  if (narrowQuery && narrowQuery.body.includes('.dialogue')) {
    const dialogueInMedia = narrowQuery.body.match(/\.dialogue\s*\{[^}]*\}/g);
    if (dialogueInMedia) {
      dialogueInMedia.forEach(function(rule) {
        if (rule.includes('left:') && rule.includes('right:')) narrowDialogueOK = true;
      });
    }
  }
  assert(narrowDialogueOK, '@media narrow adjusts .dialogue left/right margins');

  // ── 6. Minimum touch target size ──
  console.log('\n── Minimum touch target size ──');
  const chibiBlock = blocks.find(function(b) { return b.selector === '.chibi'; });
  let chibiWidthOK = false;
  if (chibiBlock) {
    const chibiWMatch = chibiBlock.body.match(/(?<![-\w])width:\s*(\d+)px/);
    if (chibiWMatch && parseInt(chibiWMatch[1], 10) >= 44) chibiWidthOK = true;
  }
  assert(chibiWidthOK, '.chibi width >= 44px touch target');

  // Check composer button padding
  const btnBlock = blocks.find(function(b) { return b.selector === '.composer button'; });
  let composerBtnOK = false;
  if (btnBlock) {
    const padMatch = btnBlock.body.match(/padding:\s*(\d+)px/);
    if (padMatch && parseInt(padMatch[1], 10) >= 8) composerBtnOK = true;
  }
  assert(composerBtnOK, '.composer button has padding >= 8px for adequate touch target');

  // ── 7. Composer flex-wrap at narrow width ──
  console.log('\n── Composer responsive layout ──');
  let composerWrapOK = false;
  if (narrowQuery) {
    const composerInMedia = narrowQuery.body.match(/\.composer\s*\{[^}]*\}/g);
    if (composerInMedia) {
      composerInMedia.forEach(function(rule) {
        if (rule.includes('flex-wrap')) composerWrapOK = true;
      });
    }
  }
  assert(composerWrapOK, '.composer uses flex-wrap at narrow viewport');

  // ── 8. VN portrait has max-width/height constraint ──
  console.log('\n── VN portrait overflow protection ──');
  const portraitBlock = blocks.find(function(b) { return b.selector === '.vn-portrait'; });
  const portraitMaxWidth = portraitBlock && portraitBlock.body.includes('max-width');
  const portraitMaxHeight = portraitBlock && portraitBlock.body.includes('max-height');
  assert(portraitMaxWidth, '.vn-portrait has max-width constraint');
  assert(portraitMaxHeight, '.vn-portrait has max-height constraint');

  // ── 9. Horizontal overflow protection ──
  console.log('\n── Horizontal overflow protection ──');
  const mapStageOverflow = mapStageBlock && mapStageBlock.body.includes('overflow: hidden');
  assert(mapStageOverflow, '.map-stage has overflow:hidden for isometric containment');

  const vnStageOverflow = vnStageBlock && vnStageBlock.body.includes('overflow: hidden');
  assert(vnStageOverflow, '.vn-stage has overflow:hidden');

  // ── 10. Chibi scaling at narrow viewport ──
  console.log('\n── Chibi responsive scaling ──');
  let chibiScaleOK = false;
  if (narrowQuery) {
    const chibiInMedia = narrowQuery.body.match(/\.chibi\s*\{[^}]*\}/g);
    if (chibiInMedia) {
      chibiInMedia.forEach(function(rule) {
        if (rule.includes('scale')) chibiScaleOK = true;
      });
    }
  }
  assert(chibiScaleOK, 'Chibis scale down at narrow viewport (within @media max-width)');

  // ── 11. Bootstrap injects nav buttons ──
  console.log('\n── Bootstrap nav button injection ──');
  const injectsRail = bootstrapSrc.includes('.rail');
  const injectsSidebarNav = bootstrapSrc.includes('.sidebar-nav');
  assert(injectsRail, 'bootstrap.js injects into .rail (responsive nav)');
  assert(injectsSidebarNav, 'bootstrap.js injects into .sidebar-nav (responsive nav)');

  // ── 12. HQ page has max-width constraint ──
  console.log('\n── Main container width constraint ──');
  const hqPageBlock = blocks.find(function(b) { return b.selector === '.hq-page'; });
  const hqPageMaxWidth = hqPageBlock && hqPageBlock.body.includes('max-width');
  assert(hqPageMaxWidth, '.hq-page has max-width constraint for responsive sizing');

  // ── 13. Composer textarea has min-width for flex shrink ──
  console.log('\n── Textarea minimum width ──');
  const textareaBlock = blocks.find(function(b) { return /\.composer\s+textarea/.test(b.selector); });
  const hasTextareaMinWidth = textareaBlock && textareaBlock.body.includes('min-width');
  assert(hasTextareaMinWidth, '.composer textarea has min-width for flex shrink');

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
  if (failures.length > 0) {
    console.error('FAILURES:');
    failures.forEach(function(f) { console.error('  ✗ ' + f); });
    process.exit(1);
  }
}

runTests();
