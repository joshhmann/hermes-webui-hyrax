/**
 * Hyraxknot Division — QAT (human testing) Panel Controller (ES module)
 *
 * Registered through bootstrap.js as the `qat` extension panel
 * (window.HermesPanels). ONE screen for Josh's H-dimension testing: renders
 * the current QAT packet (M4 / M5.1 / M5.2 active, M5.3 gated) and lets him
 * record verdicts IN THE PAGE.
 *
 * Data flow:
 *   - GET  /api/hyrax/qat/packet    — committed packet JSON (hyrax-assets/qat/packet.json)
 *   - GET  /api/hyrax/qat/verdicts  — stored verdict rows (append-only JSONL)
 *   - POST /api/hyrax/qat/verdicts  — submit one PASS/FAIL/CAVEAT + one-line why
 *
 * Per-milestone render: engineering status, REQ-M-* requirements, prerequisite
 * setup (kit hytest / teleport mirage), numbered observable test steps with
 * PASS/FAIL criteria + feel ask, an overall-feel row, then verdict buttons.
 * Submitted verdicts appear in the per-milestone log AND the combined ledger
 * strip; everything loads from the API again on mount, so a submitted verdict
 * is visible on reload. Gated milestones render read-only with a lock note —
 * the backend rejects their verdicts too (fail-closed).
 *
 * Scoped classes: .qat-* (hyrax.css). Mount/unmount are idempotent; async
 * work is generation/abort guarded so a stale fetch cannot mutate a later
 * mount. No timers: the page is a test sheet, not a live dashboard.
 */
'use strict';

var _mounted = false;
var _gen = 0;
var _abort = null;
var _hostEl = null;

var VERDICT_VALUES = ['PASS', 'FAIL', 'CAVEAT'];

function _root() {
  return typeof window !== 'undefined' ? window : globalThis;
}

function _api(url, opts) {
  var w = _root();
  if (typeof w.api === 'function') return w.api(url, opts || {});
  if (typeof fetch === 'function') {
    return fetch(url, opts || {}).then(function(r) {
      if (!r.ok) {
        var err = new Error('HTTP ' + r.status);
        err.status = r.status;
        throw err;
      }
      return r.json();
    });
  }
  return Promise.reject(new Error('no transport'));
}

function _host(idOrEl) {
  if (typeof idOrEl === 'string') {
    return _root().document ? _root().document.getElementById('mainQat') : null;
  }
  return idOrEl || null;
}

function _el(tag, className, text) {
  var e = _root().document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = String(text);
  return e;
}

// ── Pure helpers (exported for the Node harness) ─────────────────────────

/** Full test id: milestone id + '-' + test id, e.g. M4-S1, M5.1-E1. */
function testId(milestoneId, testLocalId) {
  return String(milestoneId) + '-' + String(testLocalId);
}

/** Overall-feel id for a milestone, e.g. M4-OVERALL. */
function overallId(milestoneId) {
  return String(milestoneId) + '-OVERALL';
}

/** Index verdict rows by test_id (last row wins). */
function byTestId(items) {
  var idx = {};
  if (Array.isArray(items)) {
    for (var i = 0; i < items.length; i++) {
      var r = items[i];
      if (r && r.test_id) idx[r.test_id] = r;
    }
  }
  return idx;
}

/** Count verdicts per value: {PASS: n, FAIL: n, CAVEAT: n}. */
function verdictCounts(items) {
  var counts = { PASS: 0, FAIL: 0, CAVEAT: 0 };
  if (Array.isArray(items)) {
    for (var i = 0; i < items.length; i++) {
      var v = items[i] && items[i].verdict;
      if (VERDICT_VALUES.indexOf(v) !== -1) counts[v]++;
    }
  }
  return counts;
}

/** Milestone status from the packet: 'active' | 'gated' | 'unknown'. */
function milestoneStatus(packet, milestoneId) {
  if (!packet || !Array.isArray(packet.milestones)) return 'unknown';
  for (var i = 0; i < packet.milestones.length; i++) {
    if (packet.milestones[i] && packet.milestones[i].id === milestoneId) {
      return packet.milestones[i].status || 'active';
    }
  }
  return 'unknown';
}

/** Short age label from an epoch seconds timestamp. */
function ageLabel(seconds) {
  if (seconds == null) return '';
  var s = Number(seconds);
  if (!isFinite(s) || s <= 0) return '';
  var diff = Date.now() / 1000 - s;
  if (diff < 60) return 'now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  return Math.floor(diff / 86400) + 'd';
}

// ── Rendering ────────────────────────────────────────────────────────────

/** Rows for a milestone: active tests + synthetic overall row. */
function _milestoneRows(ms) {
  var rows = [];
  var tests = (ms && Array.isArray(ms.tests)) ? ms.tests : [];
  var i, t;
  for (i = 0; i < tests.length; i++) {
    t = tests[i];
    rows.push({
      id: testId(ms.id, (t && t.id) || ('T' + (i + 1))),
      step: (t && t.step) || '',
      pass: (t && t.pass) || '',
      feel: (t && t.feel) || '',
      optional: !!(t && t.optional),
      overall: false,
    });
  }
  if (ms && ms.overall) {
    rows.push({
      id: overallId(ms.id),
      step: (ms.overall.label) || ('OVERALL ' + ms.id + ' FEEL'),
      pass: (ms.overall.reqs) ? 'Verdict per ' + ms.overall.reqs : '',
      feel: 'The milestone-wide feel verdict',
      optional: false,
      overall: true,
    });
  }
  return rows;
}

/** Build the requirements + setup + status block for a milestone. */
function _milestoneMeta(ms, verdicts) {
  var wrap = _el('div', 'qat-ms-meta');

  // Engineering status
  if (ms.engineering_status) {
    var eng = _el('p', 'qat-ms-eng', ms.engineering_status);
    wrap.appendChild(eng);
  }

  // Requirements (REQ-M-*)
  var reqs = (ms.requirements && ms.requirements.length) ? ms.requirements : [];
  if (reqs.length) {
    var reqHead = _el('h4', 'qat-sub', 'TESTING REQUIREMENTS');
    var reqList = _el('ul', 'qat-req-list');
    for (var i = 0; i < reqs.length; i++) {
      var li = _el('li', 'qat-req');
      li.appendChild(_el('code', 'qat-req-id', reqs[i].req));
      li.appendChild(document.createTextNode(' — ' + (reqs[i].mechanic || '')));
      reqList.appendChild(li);
    }
    wrap.appendChild(reqHead);
    wrap.appendChild(reqList);
  }

  // Prerequisite setup
  var setup = (ms.setup && ms.setup.length) ? ms.setup : [];
  if (setup.length) {
    var setupHead = _el('h4', 'qat-sub', 'PREREQUISITE SETUP');
    var pre = _el('pre', 'qat-setup');
    pre.textContent = setup.join('\n');
    wrap.appendChild(setupHead);
    wrap.appendChild(pre);
  }

  // Fixed point (M4 canonical math)
  if (ms.fixed_point) {
    var fp = _el('p', 'qat-fixed', ms.fixed_point);
    wrap.appendChild(fp);
  }

  return wrap;
}

/** Build the verdict input row for a single test (active milestone). */
function _verdictComposer(row, onSubmit) {
  var box = _el('div', 'qat-composer');

  var why = _el('input', 'qat-why');
  why.type = 'text';
  why.name = 'why-' + row.id;
  why.placeholder = 'one line why…';
  why.maxLength = 500;

  var btnRow = _el('div', 'qat-btns');
  for (var i = 0; i < VERDICT_VALUES.length; i++) {
    (function(v) {
      var b = _el('button', 'qat-btn qat-' + v.toLowerCase(), v);
      b.type = 'button';
      b.addEventListener('click', function() {
        var whyText = (why.value || '').trim();
        if (!whyText) {
          why.focus();
          why.style.borderColor = '#f85149';
          setTimeout(function() { why.style.borderColor = ''; }, 1200);
          return;
        }
        b.setAttribute('disabled', 'true');
        onSubmit({ test_id: row.id, verdict: v, why: whyText }, b);
      });
      btnRow.appendChild(b);
    })(VERDICT_VALUES[i]);
  }

  box.appendChild(btnRow);
  box.appendChild(why);
  return box;
}

/** A test row: id, step, pass criteria + feel ask, and (if active) verdict UI. */
function _testRow(row, recorded, active, onSubmit) {
  var card = _el('div', 'qat-test' + (row.overall ? ' qat-overall' : '') + (row.optional ? ' qat-optional' : ''));

  var head = _el('div', 'qat-test-head');
  head.appendChild(_el('code', 'qat-test-id', row.id));
  if (row.optional) head.appendChild(_el('span', 'qat-badge', 'optional'));
  if (row.overall) head.appendChild(_el('span', 'qat-badge', 'OVERALL FEEL'));
  card.appendChild(head);

  card.appendChild(_el('p', 'qat-step', row.step));

  var crit = _el('div', 'qat-crit');
  crit.appendChild(_el('span', 'qat-crit-label', 'PASS '));
  crit.appendChild(document.createTextNode(row.pass || ''));
  card.appendChild(crit);

  if (row.feel) {
    var feelRow = _el('div', 'qat-crit qat-feel');
    feelRow.appendChild(_el('span', 'qat-crit-label', 'FEEL '));
    feelRow.appendChild(document.createTextNode(row.feel));
    card.appendChild(feelRow);
  }

  if (recorded) {
    var rec = _el('div', 'qat-recorded qat-rec-' + String(recorded.verdict || '').toLowerCase());
    rec.appendChild(_el('strong', '', recorded.verdict || ''));
    rec.appendChild(document.createTextNode(' — ' + (recorded.why || '')));
    var ago = ageLabel(recorded.at);
    if (ago) rec.appendChild(_el('span', 'qat-ago', ' · ' + ago));
    card.appendChild(rec);
  } else if (active) {
    card.appendChild(_verdictComposer(row, onSubmit));
  } else {
    card.appendChild(_el('p', 'qat-locked', 'Gated — verdicts locked until this section activates.'));
  }

  return card;
}

/** Ledger strip: counts per verdict across all submitted rows. */
function _ledgerStrip(verdicts, total) {
  var strip = _el('div', 'qat-ledger');
  var counts = verdictCounts(verdicts);
  strip.appendChild(_el('span', 'qat-ledger-title', 'VERDICT LEDGER · ' + total + ' recorded'));
  var order = ['PASS', 'FAIL', 'CAVEAT'];
  for (var i = 0; i < order.length; i++) {
    (function(v) {
      var cell = _el('span', 'qat-ledger-cell qat-rec-' + v.toLowerCase());
      cell.appendChild(_el('strong', '', String(counts[v])));
      cell.appendChild(document.createTextNode(' ' + v));
      strip.appendChild(cell);
    })(order[i]);
  }
  return strip;
}

/** Full milestone section. */
function _milestoneSection(ms, verdicts, active, onSubmit) {
  var sec = _el('section', 'qat-ms' + (active ? '' : ' qat-gated'));

  var head = _el('div', 'qat-ms-head');
  var h3 = _el('h3', '', ms.title || ms.id);
  var badge = _el('span', 'qat-ms-status ' + (active ? 'qat-active' : 'qat-gated-badge'), active ? 'ACTIVE' : 'GATED');
  head.appendChild(h3);
  head.appendChild(badge);
  sec.appendChild(head);

  var idx = byTestId(verdicts);
  sec.appendChild(_milestoneMeta(ms, idx));

  if (!active && ms.gate_note) {
    sec.appendChild(_el('p', 'qat-gate-note', ms.gate_note));
  }

  var rows = _milestoneRows(ms);
  if (rows.length) {
    sec.appendChild(_el('h4', 'qat-sub', 'TEST STEPS + PASS/FAIL'));
    for (var i = 0; i < rows.length; i++) {
      sec.appendChild(_testRow(rows[i], idx[rows[i].id] || null, active, onSubmit));
    }
  }

  return sec;
}

/** Master sheet: verdict format block + ledger landing note. */
function _masterSheet(packet) {
  var sheet = _el('section', 'qat-ms qat-master');
  sheet.appendChild(_el('h3', '', 'VERDICT FORMAT / LEDGER LANDING'));
  var ms = (packet && Array.isArray(packet.milestones)) ? packet.milestones : [];
  for (var i = 0; i < ms.length; i++) {
    var fmt = (ms[i] && Array.isArray(ms[i].verdict_format)) ? ms[i].verdict_format : [];
    if (!fmt.length) continue;
    var pre = _el('pre', 'qat-setup');
    pre.textContent = fmt.join('\n');
    sheet.appendChild(pre);
    if (ms[i].ledger) sheet.appendChild(_el('p', 'qat-fixed', 'Ledger: ' + ms[i].ledger));
  }
  var masters = (packet && packet.master_sheet) ? packet.master_sheet : null;
  if (masters) {
    if (masters.header) sheet.appendChild(_el('p', 'qat-fixed', masters.header));
    if (masters.ledger_landing) sheet.appendChild(_el('p', 'qat-fixed', masters.ledger_landing));
  }
  return sheet;
}

/** Render the whole page into the host. */
function _render(host, packet, verdicts, err) {
  var page = _el('div', 'qat-page');
  var root = _root();

  var title = _el('div', 'qat-header');
  title.appendChild(_el('h2', '', 'QAT — Human Test Packet'));
  if (packet && packet.id) title.appendChild(_el('span', 'qat-packet-id', packet.id));
  if (packet && packet.date) title.appendChild(_el('span', 'qat-packet-date', ' · ' + packet.date));
  page.appendChild(title);

  if (err) {
    var errBox = _el('div', 'qat-error');
    errBox.appendChild(_el('p', '', err));
    var retry = _el('button', 'qat-btn', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', function() {
      _load(host);
    });
    errBox.appendChild(retry);
    page.appendChild(errBox);
  } else if (!packet) {
    page.appendChild(_el('p', 'qat-error', 'No packet data.'));
  } else {
    var items = Array.isArray(verdicts) ? verdicts : [];
    page.appendChild(_ledgerStrip(items, items.length));

    // How-it-works intro
    if (Array.isArray(packet.how_it_works) && packet.how_it_works.length) {
      var intro = _el('div', 'qat-how');
      intro.appendChild(_el('h4', 'qat-sub', 'HOW THIS PACKET WORKS'));
      var introP = _el('p', '', packet.how_it_works.join(' '));
      intro.appendChild(introP);
      page.appendChild(intro);
    }

    var ms = packet.milestones || [];
    var active = [];
    var gated = [];
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].status === 'active') active.push(ms[i]);
      else gated.push(ms[i]);
    }

    var onSubmit = function(body, btn) {
      _api('/api/hyrax/qat/verdicts', {
        method: 'POST',
        body: JSON.stringify(body),
      }).then(function() {
        if (typeof root.showToast === 'function') {
          try { root.showToast('Verdict recorded: ' + body.test_id + ' ' + body.verdict); } catch (_) {}
        }
        _load(host); // refresh ledger + rows from the API
      }).catch(function(e) {
        btn.removeAttribute('disabled');
        var why = e && e.message ? e.message : 'Failed to record';
        if (typeof root.showToast === 'function') {
          try { root.showToast('Verdict failed: ' + why); } catch (_) {}
        } else {
          if (typeof console !== 'undefined') console.error(why);
        }
      });
    };

    for (var a = 0; a < active.length; a++) {
      page.appendChild(_milestoneSection(active[a], items, true, onSubmit));
    }
    for (var g = 0; g < gated.length; g++) {
      page.appendChild(_milestoneSection(gated[g], items, false, null));
    }

    page.appendChild(_masterSheet(packet));

    if (Array.isArray(packet.sources) && packet.sources.length) {
      var src = _el('div', 'qat-sources');
      src.appendChild(_el('h4', 'qat-sub', 'SOURCES'));
      var srcP = _el('p', '', packet.sources.join(' '));
      src.appendChild(srcP);
      page.appendChild(src);
    }
  }

  host.replaceChildren(page);
}

/** Fetch packet + verdicts and render (generation-guarded). */
function _load(host) {
  var gen = ++_gen;
  if (_abort) { try { _abort.abort(); } catch (_) {} }
  if (typeof AbortController === 'function') {
    _abort = new AbortController();
  } else {
    _abort = null;
  }
  var opts = {};
  if (_abort) opts.signal = _abort.signal;

  var packetP = _api('/api/hyrax/qat/packet', opts);
  var verdictP = _api('/api/hyrax/qat/verdicts', opts).catch(function() { return { items: [] }; });

  Promise.all([packetP, verdictP]).then(function(res) {
    if (gen !== _gen || !_mounted) return; // stale — a newer mount owns the host
    var packet = res[0] && res[0].packet ? res[0].packet : null;
    var items = res[1] && Array.isArray(res[1].items) ? res[1].items : [];
    _render(host, packet, items, packet ? null : 'Could not load the QAT packet.');
  }).catch(function() {
    if (gen !== _gen || !_mounted) return;
    _render(host, null, [], 'Could not load the QAT page — is the WebUI API up?');
  });
}

/** Mount the QAT panel into its host (panel id string or host element). */
function mount(idOrEl) {
  var host = _host(idOrEl);
  if (!host) return;
  _hostEl = host;
  if (_mounted) {
    _load(host);
    return;
  }
  _mounted = true;
  _load(host);
}

/** Unmount: abort in-flight work and clear the host. */
function unmount(idOrEl) {
  _gen++;
  _mounted = false;
  if (_abort) {
    try { _abort.abort(); } catch (_) {}
    _abort = null;
  }
  var host = _hostEl || _host(idOrEl);
  _hostEl = null;
  if (host) {
    try { host.replaceChildren(); } catch (_) {}
  }
}

export {
  mount,
  unmount,
  testId,
  overallId,
  byTestId,
  verdictCounts,
  milestoneStatus,
  ageLabel,
};