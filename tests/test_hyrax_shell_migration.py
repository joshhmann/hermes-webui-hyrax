"""Structural gate for the Hyrax shell/VN migration to native panel lifecycle
(card t_b91c5672).

Contracts enforced here (execution-level behaviour lives in
tests/run_hyrax_migration_tests.js):

1. index.html loads exactly ONE Hyrax integration script (bootstrap.js, defer)
   and keeps exactly one #mainHq host; no direct projects/hq/vn script tags.
2. bootstrap.js registers exactly the working panels projects + hq through
   window.HermesPanels.register — no switchPanel wrapper/reassignment, no
   MAIN_VIEW_PANELS mutation, no inline onclick, no polling/observer.
3. Old private wrappers and dead placeholders are gone from the changed scope.
4. hq.js / vn.js / projects.js are ES modules (export a controller contract).
5. VN surface uses only the native /api/hyrax/vn/* adapter endpoints; no
   /api/v1, donor URLs, or second state model.
6. CSS: #mainHq hidden by default, shown only under main.main.showing-hq,
   chat hidden under showing-hq, scoped .panel-page/.page-header/.panel-content
   containment for the projects panel, responsive / reduced-motion / focus
   contracts, no global element overrides, no horizontal overflow.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
INDEX = REPO / "static" / "index.html"
BOOTSTRAP = REPO / "static" / "hyrax" / "bootstrap.js"
HQ_JS = REPO / "static" / "hyrax" / "hq.js"
VN_JS = REPO / "static" / "hyrax" / "vn.js"
PROJECTS_JS = REPO / "static" / "hyrax" / "projects.js"
CSS = REPO / "static" / "hyrax" / "hyrax.css"

# Classic VN modules that vn.js must lazily load (production, not editable in
# this card) — they are the working VN surface and must keep using the native
# adapter only.
VN_CLASSIC = [
    "vnEvents.js", "vnSession.js", "essenceState.js", "essenceFrames.js",
    "essenceIntents.js", "vnStage.js", "vnActions.js", "vnSidebar.js",
    "vnDialogue.js", "vnComposer.js", "vnApprovals.js", "vnTechDrawer.js",
    "vnShell.js",
]

CHANGED_SCOPE = [BOOTSTRAP, HQ_JS, VN_JS, PROJECTS_JS, CSS]

BANNED_PATTERNS = [
    "__hyraxSwitchPanelPatched",
    "_origSwitchPanel",
    "origSwitchPanel",
    "MAIN_VIEW_PANELS",
    "/api/v1",
    "CT112",
    "192.168.0.96",
    "postMessage",
    "8770",                 # donor division-gateway port
    "division-gateway",     # donor service
    "gestalt-control-plane",
]

# Dead War Room / Dispatch / Verify / Promises placeholder DOM ids — banned
# anywhere in the changed scope (including index.html Hyrax region).
DEAD_PLACEHOLDER_IDS = [
    "panelWarroom", "panelDispatch", "panelVerify", "panelPromises",
    "hyrax-warroom-content", "hyrax-dispatch-content",
    "hyrax-verify-content", "hyrax-promises-content",
    "mainWarroom", "mainDispatch", "mainVerify", "mainPromises",
]


def _index() -> str:
    return INDEX.read_text(encoding="utf-8")


def _src(p: Path) -> str:
    return p.read_text(encoding="utf-8")


# ══════════════════════════════════════════════════════════════════════
# 1. Index: one script, one host
# ══════════════════════════════════════════════════════════════════════


class TestIndexShell:
    def test_exactly_one_hyrax_script_tag(self):
        src = _index()
        tags = re.findall(
            r'<script[^>]*src="static/hyrax/[^"]+"[^>]*></script>', src
        )
        assert len(tags) == 1, f"expected exactly 1 hyrax script tag, got {len(tags)}: {tags}"

    def test_the_one_script_is_bootstrap_with_defer(self):
        src = _index()
        tags = re.findall(
            r'<script([^>]*?)src="static/hyrax/([^"]+)"([^>]*)></script>', src
        )
        assert len(tags) == 1
        src_name = tags[0][1]
        attrs = tags[0][0] + " " + tags[0][2]
        assert "bootstrap.js" in src_name
        assert "defer" in attrs

    def test_no_direct_module_script_tags(self):
        src = _index()
        for name in ("hq.js", "projects.js", "vn.js", "vnShell.js", "approvals.js"):
            assert f'src="static/hyrax/{name}' not in src, f"direct script tag for {name}"

    def test_exactly_one_mainHq_host(self):
        assert _index().count('id="mainHq"') == 1
        assert _index().count('id="mainHqBody"') == 1

    def test_main_projects_host_present(self):
        assert 'id="mainProjects"' in _index()

    def test_no_dead_placeholder_ids_in_index(self):
        src = _index()
        for pid in DEAD_PLACEHOLDER_IDS:
            assert pid not in src, f"dead placeholder id {pid} still in index.html"

    def test_no_inline_onclick_in_hyrax_region(self):
        # The Hyrax script region must not use inline onclick handlers.
        src = _index()
        for m in re.finditer(r'<script[^>]*src="static/hyrax/bootstrap\.js[^"]*"[^>]*>', src):
            tail = src[m.end():m.end() + 2000]
            assert "onclick" not in tail.split("</script>")[0]


# ══════════════════════════════════════════════════════════════════════
# 2. Bootstrap: exactly projects + hq via HermesPanels
# ══════════════════════════════════════════════════════════════════════


class TestBootstrapRegistration:
    def test_panels_exactly_projects_and_hq(self):
        src = _src(BOOTSTRAP)
        m = re.search(r"var HYRAX_PANELS = \[(.*?)\];", src, re.S)
        assert m, "HYRAX_PANELS array not found"
        ids = re.findall(r"id: '([^']+)'", m.group(1))
        assert ids == ["projects", "hq"], f"expected exactly ['projects','hq'], got {ids}"

    def test_uses_hermes_panels_register(self):
        src = _src(BOOTSTRAP)
        assert "HermesPanels.register" in src

    def test_no_switch_panel_wrapper_or_reassignment(self):
        src = _src(BOOTSTRAP)
        assert "switchPanel = " not in src
        assert "window.switchPanel =" not in src
        assert "function switchPanel" not in src

    def test_no_main_view_panels_mutation(self):
        assert "MAIN_VIEW_PANELS" not in _src(BOOTSTRAP)

    def test_no_inline_onclick(self):
        src = _src(BOOTSTRAP)
        assert "onclick" not in src, "inline onclick banned in bootstrap.js"

    def test_no_polling_or_observer_workaround(self):
        src = _src(BOOTSTRAP)
        assert "MutationObserver" not in src
        assert "setInterval" not in src

    def test_no_banned_patterns(self):
        src = _src(BOOTSTRAP)
        for pat in BANNED_PATTERNS:
            assert pat not in src, f"banned pattern {pat} in bootstrap.js"

    def test_no_dead_placeholder_ids(self):
        src = _src(BOOTSTRAP)
        for pid in DEAD_PLACEHOLDER_IDS:
            assert pid not in src, f"dead placeholder id {pid} in bootstrap.js"


# ══════════════════════════════════════════════════════════════════════
# 3. Modules are ES controllers with the native adapter contract
# ══════════════════════════════════════════════════════════════════════


class TestEsModules:
    def test_hq_is_es_module(self):
        src = _src(HQ_JS)
        assert re.search(r"^export ", src, re.M), "hq.js must export its controller"
        assert "export function mount" in src or "export {" in src

    def test_vn_is_es_module(self):
        src = _src(VN_JS)
        assert re.search(r"^export ", src, re.M), "vn.js must export its controller"

    def test_projects_is_es_module(self):
        src = _src(PROJECTS_JS)
        assert re.search(r"^export ", src, re.M), "projects.js must export its controller"

    def test_vn_lazy_loads_classic_modules(self):
        src = _src(VN_JS)
        for name in VN_CLASSIC:
            assert f"./vn/{name}" in src or f"./essence/{name}" in src, \
                f"vn.js must lazily load {name}"

    def test_vn_uses_only_native_endpoints(self):
        # The classic VN modules are the working surface; they must reference
        # only the native /api/hyrax/vn/* adapter, never /api/v1.
        for name in VN_CLASSIC:
            path = REPO / "static" / "hyrax" / ("vn" if name.startswith("vn") else "essence") / name
            src = path.read_text(encoding="utf-8")
            assert "/api/v1" not in src, f"/api/v1 in {name}"
        # And the classic session/event modules use the exact native routes.
        session = (REPO / "static" / "hyrax" / "vn" / "vnSession.js").read_text(encoding="utf-8")
        events = (REPO / "static" / "hyrax" / "vn" / "vnEvents.js").read_text(encoding="utf-8")
        shell = (REPO / "static" / "hyrax" / "vn" / "vnShell.js").read_text(encoding="utf-8")
        assert "'/api/hyrax/vn/conversations'" in session
        assert "/api/hyrax/vn/conversations/" in events and "/events" in events
        assert "/api/hyrax/vn/profiles" in shell

    def test_no_banned_patterns_in_modules(self):
        for p in (HQ_JS, VN_JS, PROJECTS_JS):
            src = _src(p)
            for pat in BANNED_PATTERNS:
                assert pat not in src, f"banned pattern {pat} in {p.name}"
            for pid in DEAD_PLACEHOLDER_IDS:
                assert pid not in src, f"dead placeholder id {pid} in {p.name}"

    def test_hq_keeps_vocabulary_contract_vars(self):
        # tests/test_hyrax_vocabulary.py regex-extracts these from hq.js —
        # the ESM conversion must preserve the declarations.
        src = _src(HQ_JS)
        for name in ("HQ_SISTERS", "HQ_ROOMS", "ACTIVITY_TYPES", "ACTIVITY_LABELS", "ACTIVITY_ROOM"):
            assert re.search(r"var " + name + r" = [\[{]", src), f"{name} declaration missing"

    def test_vn_has_loft_contract(self):
        # Tai-only Synthesis Loft entry must be wired through the controller:
        # lazy import of the production bundle URL, production defaults.
        src = _src(HQ_JS) + _src(VN_JS)
        assert "embodiment-bundle.js" in src
        assert "mountTaiLoft" in src


# ══════════════════════════════════════════════════════════════════════
# 4. CSS: containment, visibility, responsive / reduced-motion / focus
# ══════════════════════════════════════════════════════════════════════


class TestCssContracts:
    def test_mainHq_hidden_by_default(self):
        css = _src(CSS)
        assert re.search(r"main\.main > #mainHq\s*\{\s*display:\s*none", css)

    def test_mainHq_shown_only_under_showing_hq(self):
        css = _src(CSS)
        assert re.search(
            r"main\.main\.showing-hq > #mainHq\s*\{[^}]*display:\s*flex", css
        )

    def test_chat_hidden_under_showing_hq(self):
        css = _src(CSS)
        assert re.search(
            r"main\.main\.showing-hq > #mainChat\s*\{[^}]*display:\s*none", css
        )

    def test_main_projects_containment(self):
        css = _src(CSS)
        assert re.search(r"main\.main > #mainProjects\s*\{\s*display:\s*none", css)
        assert re.search(
            r"main\.main\.showing-projects > #mainProjects\s*\{[^}]*display:\s*flex", css
        )
        assert re.search(
            r"main\.main\.showing-projects > #mainChat\s*\{[^}]*display:\s*none", css
        )

    def test_scoped_panel_page_classes(self):
        css = _src(CSS)
        for cls in ("panel-page", "page-header", "panel-content"):
            assert re.search(r"\." + cls + r"\s*\{", css), f".{cls} rule missing"

    def test_no_global_element_overrides(self):
        css = _src(CSS)
        # A bare (line-anchored) element selector — body/html/* — would leak
        # Hyrax styling onto the whole app. Scoped universal selectors like
        # `.vn2 *` are fine and must not trip this check.
        for m in re.finditer(r"^\s*([a-zA-Z*][a-zA-Z0-9-]*)\s*[,{]", css, re.M):
            assert m.group(1) not in ("body", "html", "*"), \
                f"global element selector {m.group(1)} in hyrax.css"
        assert "overflow-x" not in css, "no horizontal overflow rules allowed"

    def test_reduced_motion_present(self):
        assert "prefers-reduced-motion" in _src(CSS)

    def test_focus_visible_present(self):
        assert "focus-visible" in _src(CSS)

    def test_responsive_narrow_present(self):
        assert "max-width" in _src(CSS)

    def test_approvals_panel_css_removed(self):
        # The approvals panel is retired by this card — its CSS must go.
        assert "showing-approvals" not in _src(CSS)
        assert "#mainApprovals" not in _src(CSS)


# ══════════════════════════════════════════════════════════════════════
# 5. Classic VN surface: no donor URLs anywhere in the loaded surface
# ══════════════════════════════════════════════════════════════════════


class TestVnClassicSurface:
    def test_no_donor_urls_in_classic_vn(self):
        for name in VN_CLASSIC:
            path = REPO / "static" / "hyrax" / ("vn" if name.startswith("vn") else "essence") / name
            src = path.read_text(encoding="utf-8")
            for pat in ("/api/v1", "8770", "192.168.0.96", "CT112", "division-gateway"):
                assert pat not in src, f"{pat} in {name}"

    def test_no_iframe_postmessage_in_vn_surface(self):
        for name in VN_CLASSIC:
            path = REPO / "static" / "hyrax" / ("vn" if name.startswith("vn") else "essence") / name
            src = path.read_text(encoding="utf-8")
            assert "iframe" not in src, f"iframe in {name}"
            assert "postMessage" not in src, f"postMessage in {name}"
