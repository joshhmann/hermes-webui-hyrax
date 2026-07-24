# Rei Live QA v2: Post-Fix Panel Rendering and Chat Bleed

**Date:** 2026-07-23
**Target:** http://192.168.0.187:8787 (Deployed Hyrax WebUI)
**Scope:** Post-fix verification of panel rendering, chat bleed, sidebar hygiene, console errors, HQ/chibi interaction
**Mode:** Read-only — no edits, no restarts

---

## Executive Summary

The previous round (t_4027e441) found 4 issues: critical (VN not opening from chibi click), high (panel aria-expanded bleed), medium (CSP report-only, missing security headers). This post-fix pass finds:

- **Sidebar stale-panel issue: RESOLVED ✅** — all 11 `.panel-view` divs properly hidden (display=none)
- **Chat bleed: PARTIALLY RESOLVED 🟡** — chat is positioned off-screen (top=-38px) but still in render tree as display=flex, visible=true alongside active panel
- **VN chibi click: STILL BROKEN 🔴** — "Connecting to Rei…" loading state never transitions to conversation
- **Nav aria-expanded bleed: STILL PRESENT 🟠** — 7 buttons show expanded=true simultaneously
- **JS errors: 0 across all transitions ✅**
- **Main panels: correct showing-X class applied for every transition ✅**

---

## 1. Chat Panel

| Check | Result |
|-------|--------|
| Renders correctly | ✅ Yes — full agent UI visible |
| Input field | ✅ "Message Nei…" placeholder |
| JS errors | ✅ 0 |
| Console messages | ✅ 0 |
| Content cached in DOM | ✅ 50,849 chars persisted |

**Verdict: OPERATIONAL**

---

## 2. HQ Panel

| Check | Result |
|-------|--------|
| 3D Tai Loft canvas | ✅ Renders on first visit (three.js r170) |
| 2D Division HQ map | ✅ Renders on subsequent visits — labeled areas + 4 chibi buttons |
| Chat visible underneath? | 🔴 Yes — mainChat at top=-38px, display=flex, visible=true |
| CSS class | ✅ `main showing-hq` |
| mainHq content | ✅ 98 chars (VN loading state after chibi click) |

**Verdict: PARTIALLY OPERATIONAL — chat bleed still present, 3D→2D map state not preserved on revisit**

---

## 3. Secondary Panels (Projects, War Room, Dispatch, Verify, Promises)

| Panel | CSS Class | Content | Visible? | Chat Bleed? |
|-------|-----------|---------|----------|-------------|
| Projects | ✅ `showing-projects` | 198 chars "coming soon" | ✅ Correct | 🔴 mainChat visible |
| War Room | ✅ `showing-warroom` | 197 chars "coming soon" | ✅ Correct | 🔴 mainChat visible |
| Dispatch | ✅ `showing-dispatch` | 198 chars "coming soon" | ✅ Correct | 🔴 mainChat visible |
| Verify | ✅ `showing-verify` | 192 chars "coming soon" | ✅ Correct | 🔴 mainChat visible |
| Promises | ✅ `showing-promises` | 198 chars "coming soon" | ✅ Correct | 🔴 mainChat visible |

**Verdict: OPERATIONAL (placeholder content)** — all panels render correctly with proper CSS classes. No JS errors across transitions. Content is "coming soon" stubs, not actual panel content.

---

## 4. Sidebar Panel Hygiene ✅ IMPROVED

| Check | Previous Audit (t_4027e441) | This Audit |
|-------|----------------------------|------------|
| Stale panels visible | 4 panels showing expanded=true simultaneously | 0 panels visible |
| Sidebar `.panel-view` display | Mixed | All 11: `display=none` |
| Sidebar visible? | N/A | ✅ None |

**Verdict: RESOLVED** — sidebar panels are properly cleaned up.

---

## 5. Console Errors

| Source | Count | Details |
|--------|-------|---------|
| JS errors | 0 | Clean across all transitions |
| Console messages | 0 (non-VRMA) | No warnings, no CSP violations |
| VRMA debug logs | 2 | Expected for 3D rendering — not errors |
| CSP violations | 0 | None detected |
| Network errors | 0 | All API calls return 2xx |

**Verdict: CLEAN** — no JS errors across login, Chat, HQ, Projects, War Room, Dispatch, Verify, Promises, and chibi click.

---

## 6. Chibi Click (HQ 2D Map) 🔴 STILL BROKEN

| Check | Result |
|-------|--------|
| Click "Talk with Rei" | ✅ Map replaced with loading indicator |
| Loading state | "Connecting to Rei…" — aria-busy="true" |
| VN ever loads? | 🔴 No — stuck indefinitely |
| SSE/EventSource connection | ❌ Never established |
| VN profiles API | ✅ 200 OK, returns valid data |
| VN conversations API | ✅ 200 OK, 578B response |
| VN module loaded | ✅ vn.js loaded in 57ms |
| Network errors | ✅ None |
| JS errors | ✅ None |

**Root cause:** The VN module completes its API calls (profiles, conversations) but never transitions from the loading state to the active conversation view. No SSE stream is opened. The parent task identified "missing event listener for `hyrax:open-conversation`" (hq.js:189) — this fix appears to have been partially applied (the loading state now triggers) but the SSE connection/event stream never establishes.

---

## 7. Regression Check

| Area | Previous State | Current State | Delta |
|------|---------------|---------------|-------|
| JS errors | 0 | 0 | ✅ Same |
| Sidebar stale panels | 4 visible | 0 visible | ✅ Fixed |
| Chat bleed | Visible/overlapping | Off-screen (-38px) but in render tree | 🟡 Partially improved |
| VN from chibi click | Silent failure | Shows "Connecting…" loading | 🟡 Partially improved |
| Nav aria-expanded | 4+ expanded | 7 expanded | 🔴 Worse (more panels visited) |
| CSP mode | Report-Only | Report-Only | 🟡 Same |
| Security headers | Missing | Missing | 🟡 Same |
| All API endpoints | Working | Working | ✅ Same |

---

## Findings Summary

| # | Severity | Title | File/Component | Evidence |
|---|----------|-------|---------------|----------|
| 1 | 🔴 **Critical** | VN from chibi click — stuck on "Connecting to Rei…" | hq.js:189, vn.js | Click triggers loading state and API calls (profiles 200, conversations 200) but never establishes SSE stream; no `__HYRAX_VN_STATE` global found |
| 2 | 🟠 **High** | Nav aria-expanded bleed — 7 buttons show expanded=true simultaneously | panels.js switchPanel() | Chat, Projects, War Room, Dispatch, Verify, Promises, HQ all have aria-expanded=true |
| 3 | 🟠 **High** | Chat content persists in render tree on all non-Chat panels | panels.js | mainChat: display=flex, top=-38px, visible=true on all panels; 50K chars in DOM; 2 panels visible simultaneously |
| 4 | 🟡 **Medium** | mainHq content cleared on navigation away | hq.js / panels.js | 529 chars → 0 chars when leaving HQ; all other panels preserve content in DOM |
| 5 | 🟡 **Medium** | Large DOM persistence — mainSettings (79K chars) never cleaned | panels.js | All non-active panel content persists indefinitely; settings panel alone is 79K chars |
| 6 | 🟢 **Low** | All 5 secondary panels show placeholder-only content | projects.js, warroom.js, dispatch.js, verify.js, promises.js | "coming soon" stubs — expected for now, not a regression |

---

## Evidence Details

### Finding 1: VN Chibi Click — Stuck Loading
- **DOM after click:** `<div class="vn-loading" role="status" aria-live="polite" aria-busy="true">Connecting to Rei…</div>`
- **API calls:** `GET /api/hyrax/vn/profiles` → 200 OK (611B), `GET /api/hyrax/vn/conversations` → 200 OK (578B)
- **Asynchronous check:** No SSE stream or EventSource connection was created after API responses
- **Window globals:** No `__HYRAX_VN_STATE` or other VN state variables found on `window`
- **Console:** 0 errors at any point during the operation

### Finding 2: Nav aria-expanded Bleed
```
btn-0=Chat=true        (visited)
btn-1=Tasks=null       (not visited in this session)
btn-2=Kanban=null
btn-3=Skills=null
...
btn-9=Projects=true    (visited)
btn-10=War Room=true   (visited)
btn-11=Dispatch=true   (visited)
btn-12=Verify=true     (visited)
btn-13=Promises=true   (visited)
btn-14=HQ=true         (currently active)
btn-15=Logs=null
btn-16=Settings=null
```

### Finding 3: Chat Bleed (Partial)
- `mainChat`: `getBoundingClientRect()` → `{top: -38.6, left: 348, width: 931, height: 228.8}`
- Positioned off-screen above viewport (top < 0)
- `display: flex`, `position: static`, `offsetParent !== null`
- Co-exists with active panel (e.g. `mainPromises`: `{top: 190.2, left: 348, width: 931, height: 228.8}`)
- No `transform`, `position: absolute`, or `visibility: hidden` to properly remove from render flow

---

## Architecture State (DOM snapshot)

```
main.main (class: "main showing-{panel}")
├── mainChat       (display: flex,   visible: true,   50,849 chars) ← off-screen bleed
├── mainSkills     (display: none,   visible: false,   2,687 chars)
├── mainMemory     (display: none,   visible: false,   2,458 chars)
├── mainTasks      (display: none,   visible: false,   4,466 chars)
├── mainKanban     (display: none,   visible: false,   3,554 chars)
├── mainWorkspaces (display: none,   visible: false,   3,158 chars)
├── mainProfiles   (display: none,   visible: false,   2,722 chars)
├── mainInsights   (display: none,   visible: false,     435 chars)
├── mainLogs       (display: none,   visible: false,     723 chars)
├── mainPlugin     (display: none,   visible: false,     219 chars)
├── mainHq         (display: block,   visible: true,      98 chars) ← active panel
├── mainSettings   (display: none,   visible: false,  79,233 chars)
├── mainProjects   (display: none,   visible: false,     198 chars)
├── mainWarroom    (display: none,   visible: false,     197 chars)
├── mainDispatch   (display: none,   visible: false,     198 chars)
├── mainVerify     (display: none,   visible: false,     192 chars)
└── mainPromises   (display: none,   visible: false,     198 chars)
```

sidebar panels: all 11 display:none ✅

---

## Recommendations (evidence only — Tai/Josh triage)

1. **Fix VN SSE stream connection** — the chibi click `hyrax:open-conversation` event handler was partially fixed (loading state now shows), but the SSE stream is never opened. Check `vn.js` for where `EventSource` or fetch-to-stream transition occurs after the conversations API returns.

2. **Clean chat visibility on panel switch** — either set `display:none` instead of pushing off-screen, or use `visibility:hidden` + `position:absolute` to remove from render flow.

3. **Clean aria-expanded on navigation** — `switchPanel()` should set `aria-expanded=false` on the previous button when setting `true` on the new one.

4. **Consider DOM cleanup strategy** — 79K chars for settings in persistent DOM is a memory baseline. Either destroy/recreate panel content when switching away from non-chat tabs, or accept it as intentional caching and make HQ follow the same pattern (currently it's the only one cleared).

---

*Evidence collected via browser_console DOM inspection, browser_snapshot, and performance entry analysis at 16:35 UTC, 2026-07-23. 0 JS errors, 0 CSP violations, 0 network errors across all transitions.*

— Rei
