/**
 * Hyraxknot Division — Projects Panel Controller (ES module)
 *
 * Registered through bootstrap.js as the native `projects` extension panel
 * (window.HermesPanels). Aggregates the NATIVE kanban surface by project
 * (GET /api/kanban/board — the same endpoint the native Kanban panel uses),
 * so the panel is a presentation slice over existing native data. No donor
 * gateway, no donor routes.
 *
 * Scoped classes: .panel-page / .page-header / .panel-content (hyrax.css).
 * Failures are visible and actionable (inline error + Retry), never silent.
 *
 * Mount/unmount are idempotent; all async work is generation/abort guarded
 * so a stale fetch cannot mutate a later mount.
 */
'use strict';

var _mounted = false;
var _gen = 0;
var _abort = null;
var _hostEl = null; // host element retained between mount/unmount (panel id
                    // strings are the HermesPanels hook arg; the element is
                    // resolved at mount and released at unmount)

var COLUMNS = ['triage', 'todo', 'ready', 'running', 'blocked', 'done'];

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
    return _root().document ? _root().document.getElementById('mainProjects') : null;
  }
  return idOrEl || null;
}

function _el(tag, className, text) {
  var e = _root().document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = String(text);
  return e;
}

// Pure aggregation: columns → per-project rows. Only tasks that carry a
// project name are listed — the panel is a Projects overview, unassigned
// tasks stay on the native kanban board.
function aggregateByProject(payload) {
  var byProject = {};
  var columns = (payload && Array.isArray(payload.columns)) ? payload.columns : [];
  columns.forEach(function(col) {
    var colName = col && typeof col.name === 'string' ? col.name : '';
    (col.tasks || []).forEach(function(t) {
      if (!t || typeof t !== 'object') return;
      var project = (typeof t.project_id === 'string' && t.project_id.trim())
        ? t.project_id.trim() : null;
      if (!project) return; // unassigned tasks are not a project
      if (!byProject[project]) {
        byProject[project] = {
          name: project,
          total: 0,
          counts: {},
        };
      }
      byProject[project].total++;
      byProject[project].counts[colName] = (byProject[project].counts[colName] || 0) + 1;
    });
  });
  var rows = Object.keys(byProject).map(function(key) {
    return {
      name: byProject[key].name,
      total: byProject[key].total,
      counts: byProject[key].counts,
      unassigned: false,
    };
  });
  rows.sort(function(a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  return rows;
}

function _statusSummary(counts) {
  var bits = [];
  COLUMNS.forEach(function(c) {
    var n = counts[c] || 0;
    if (n > 0) bits.push(n + ' ' + c);
  });
  return bits.join(' · ') || '0 tasks';
}

function _render(host, rows, error) {
  host.replaceChildren();

  var page = _el('div', 'panel-page');
  var header = _el('div', 'page-header');
  var title = _el('h2', 'page-title', 'Projects');
  var meta = _el('p', 'page-subtitle',
    'Kanban tasks grouped by project — from the native board.');
  header.appendChild(title);
  header.appendChild(meta);
  page.appendChild(header);

  var content = _el('div', 'panel-content');

  if (error) {
    var errBox = _el('div', 'panel-error');
    errBox.setAttribute('role', 'alert');
    errBox.appendChild(_el('p', null, error));
    var retry = _el('button', 'panel-retry', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', function() {
      _load(host);
    });
    errBox.appendChild(retry);
    content.appendChild(errBox);
  } else if (!rows.length) {
    content.appendChild(_el('p', 'panel-empty',
      'No projects yet — create kanban tasks with a project name and they will appear here.'));
  } else {
    var list = _el('ul', 'project-list');
    rows.forEach(function(row) {
      var item = _el('li', 'project-row');
      item.setAttribute('data-project', row.unassigned ? 'unassigned' : row.name);
      var name = _el('strong', 'project-name',
        row.unassigned ? 'Unassigned' : row.name);
      var summary = _el('span', 'project-summary', _statusSummary(row.counts));
      var total = _el('span', 'project-total', row.total + ' task' + (row.total === 1 ? '' : 's'));
      item.appendChild(name);
      item.appendChild(summary);
      item.appendChild(total);
      list.appendChild(item);
    });
    content.appendChild(list);
  }

  page.appendChild(content);
  host.appendChild(page);
}

function _load(host) {
  var gen = ++_gen;
  var w = _root();
  // Abort any in-flight request from a previous mount/refresh.
  if (_abort) { try { _abort.abort(); } catch (_) {} }
  if (typeof AbortController === 'function') {
    _abort = new AbortController();
  } else {
    _abort = null;
  }
  _render(host, [], null);

  var opts = {};
  if (_abort) opts.signal = _abort.signal;
  _api('/api/kanban/board', opts).then(function(payload) {
    if (gen !== _gen || !_mounted) return; // stale — a newer mount owns the host
    _render(host, aggregateByProject(payload), null);
  }).catch(function() {
    if (gen !== _gen || !_mounted) return;
    _render(host, [], 'Could not load the kanban board.');
  });
}

/**
 * Mount the projects panel into its host (accepts the panel id string or a
 * host element — the HermesPanels hook passes the panel id).
 */
function mount(idOrEl) {
  var host = _host(idOrEl);
  if (!host) return;
  _hostEl = host;
  if (_mounted) {
    // Idempotent re-mount: refresh data in place.
    _load(host);
    return;
  }
  _mounted = true;
  _load(host);
}

/** Unmount: abort in-flight work, clear the host, release state. */
function unmount(idOrEl) {
  _gen++;
  _mounted = false;
  if (_abort) {
    try { _abort.abort(); } catch (_) {}
    _abort = null;
  }
  // The host element is retained from mount so an unmount with only the
  // panel id (HermesPanels contract) still clears the exact node it owns.
  var host = _hostEl || _host(idOrEl);
  _hostEl = null;
  if (host) {
    try { host.replaceChildren(); } catch (_) {}
  }
}

export { mount, unmount, aggregateByProject };
