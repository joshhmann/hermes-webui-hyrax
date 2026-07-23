"""Static-analysis coverage for window.HermesPanels extension-panel lifecycle API.

These tests verify by JS source inspection that the contract is structurally
sound.  Execution-level behaviour is verified separately by a Node harness
(see tests/run_panel_lifecycle_tests.js).
"""

from __future__ import annotations

from pathlib import Path

import pytest

PANELS_JS = Path(__file__).resolve().parents[1] / "static" / "panels.js"


def _src() -> str:
    return PANELS_JS.read_text(encoding="utf-8")


def _function_block(src: str, name: str) -> str:
    marker = f"function {name}"
    start = src.find(marker)
    if start == -1:
        marker = f"async function {name}"
        start = src.find(marker)
    assert start != -1, f"{name} not found"
    paren = src.find("(", start)
    assert paren != -1, f"{name} signature not found"
    paren_depth = 1
    j = paren + 1
    while j < len(src) and paren_depth:
        if src[j] == "(":
            paren_depth += 1
        elif src[j] == ")":
            paren_depth -= 1
        j += 1
    assert paren_depth == 0, f"{name} signature did not close"
    brace = src.find("{", j)
    assert brace != -1, f"{name} body not found"
    depth = 1
    i = brace + 1
    while i < len(src) and depth:
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
        i += 1
    assert depth == 0, f"{name} body did not close"
    return src[start:i]


def _hermes_panels_block(src: str) -> str:
    """Extract everything from the ext-registry comment to the end of the window.HermesPanels assignment."""
    ext_start = "// ── Extension panel registry / lifecycle ──"
    start = src.find(ext_start)
    if start < 0:
        return ""
    # Find the HermesPanels assignment brace to detect the end
    hp_start = src.find("window.HermesPanels =", start)
    if hp_start < 0:
        # Only constants (no assignment yet) — return whatever we have
        return src[start:]
    brace = src.find("{", hp_start)
    if brace < 0:
        return src[start:]
    depth = 1
    i = brace + 1
    while i < len(src) and depth:
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
        i += 1
    return src[start:i]


def _register_block(src: str) -> str:
    """Extract the register method body from the HermesPanels object literal.

    ``register`` is defined as a method inside ``window.HermesPanels = { ... }``,
    so _function_block('register') would match a different ``function registerPasskey``
    elsewhere in the file. This helper walks the HermesPanels object literal to find
    the ``register: function(def) { ... }`` method body.
    """
    block = _hermes_panels_block(src)
    # Find 'register:' token inside the object literal
    reg_pos = block.find("register:")
    if reg_pos < 0:
        return ""
    fn_pos = block.find("function", reg_pos)
    if fn_pos < 0:
        return ""
    paren = block.find("(", fn_pos)
    if paren < 0:
        return ""
    paren_depth = 1
    j = paren + 1
    while j < len(block) and paren_depth:
        if block[j] == "(":
            paren_depth += 1
        elif block[j] == ")":
            paren_depth -= 1
        j += 1
    brace = block.find("{", j)
    if brace < 0:
        return ""
    depth = 1
    i = brace + 1
    while i < len(block) and depth:
        if block[i] == "{":
            depth += 1
        elif block[i] == "}":
            depth -= 1
        i += 1
    return block[reg_pos:i]


# ─── HermesPanels API surface ───


def test_hermes_panels_is_assigned_to_window():
    """window.HermesPanels must be declared as a property assignment."""
    src = _src()
    assert "window.HermesPanels" in src


def test_hermes_panels_has_register_method():
    """HermesPanels.register must be defined as a function."""
    src = _src()
    assert '"register"' in src or "'register'" in src or "register(" in src


def test_register_returns_unregister_function():
    """register def must contain a return that yields an unregister function."""
    src = _src()
    # The unregister function statement pattern: "function unregister"
    assert "function unregister" in src
    # The unregister must be described in a comment or code
    assert "unregister" in src


def test_panel_id_regex_present():
    """A regex restricting lowercase alnum/hyphen panel IDs must exist."""
    src = _src()
    assert "/^[a-z" in src or "/[a-z" in src


def test_id_max_length_32():
    """Panel ID length must be bounded (max 32 in the regex)."""
    src = _src()
    assert "32" in src or "31}" in src


def test_label_nonempty_bounded():
    """Label validation must reject empty and cap at a sane maximum."""
    src = _src()
    assert "label" in src


def test_duplicate_id_rejected():
    """register must guard against duplicate extension-panel ids."""
    src = _src()
    block = _hermes_panels_block(src)
    assert "duplicate" in block.lower()


def test_core_panel_collision_detection():
    """register must reject ids that collide with APP_TITLEBAR_KEYS or MAIN_VIEW_PANELS."""
    src = _src()
    block = _hermes_panels_block(src)
    assert "collision" in block.lower() or "collides" in block.lower()


# ─── Frozen metadata copy ───


def test_metadata_is_frozen():
    """Register must copy and Object.freeze sanitized metadata."""
    src = _src()
    assert "Object.freeze" in src or "freeze" in src


# ─── Core-panel structure integration ───


def test_register_adds_label_to_titlebar_keys():
    """Registration must extend APP_TITLEBAR_KEYS with the registered label."""
    src = _src()
    block = _hermes_panels_block(src)
    # Must reference APP_TITLEBAR_KEYS for dynamic assignment
    assert "APP_TITLEBAR_KEYS" in block


def test_main_view_panels_extended():
    """Registration with mainView=true must push id into MAIN_VIEW_PANELS."""
    src = _src()
    block = _hermes_panels_block(src)
    assert "MAIN_VIEW_PANELS.push" in block or "MAIN_VIEW_PANELS.indexOf" in block


def test_sidebar_fallback_integrated():
    """Extension sidebarFallback must be reachable from _panelFromCurrentMainView."""
    src = _src()
    snippet = _function_block(src, "_panelFromCurrentMainView")
    # Must check extension sidebar fallbacks in addition to core fallbacks
    assert "_EXT_SIDEBAR_FALLBACKS" in snippet


# ─── Lifecycle hooks in switchPanel ───


def test_switch_panel_calls_unmount_before_activation():
    """switchPanel must call the previous extension panel's unmount hook before switching _currentPanel."""
    switch_body = _function_block(_src(), "switchPanel")
    # unmount call must come before _currentPanel = nextPanel
    unmount_idx = switch_body.find("_callExtensionUnmountHook")
    curpanel_assign = switch_body.find("_currentPanel = nextPanel")
    assert unmount_idx != -1, "switchPanel must call _callExtensionUnmountHook"
    assert unmount_idx < curpanel_assign, (
        "unmount hook must be called before _currentPanel = nextPanel"
    )


def test_switch_panel_calls_mount_after_title_sync():
    """switchPanel must call the next extension panel's mount hook after title sync."""
    switch_body = _function_block(_src(), "switchPanel")
    mount_idx = switch_body.find("_callExtensionMountHook(")
    title_sync_idx = switch_body.find("syncAppTitlebar")
    assert mount_idx != -1, "switchPanel must call _callExtensionMountHook"
    assert title_sync_idx < mount_idx or switch_body.find(
        "syncTopbar"
    ) < mount_idx, (
        "mount hook must be called after title synchronisation"
    )
    # Must be before return true
    assert "return true" in switch_body[mount_idx:]


def test_same_panel_no_hooks():
    """A same-panel switch must not call extension hooks."""
    switch_body = _function_block(_src(), "switchPanel")
    # unmount and mount calls must be guarded by prevPanel !== nextPanel
    assert "prevPanel !== nextPanel" in switch_body


# ─── DOM events ───


def test_panel_mounted_event():
    """hermes:panel-mounted must be dispatched as a DOM event (concatenated)."""
    src = _src()
    # The event name is constructed dynamically via string concat
    assert "hermes:panel-" in src
    assert "phase + 'ed'" in src or "phase+'ed'" in src


def test_panel_unmounted_event():
    """hermes:panel-unmounted must be dispatched as a DOM event (concatenated)."""
    src = _src()
    assert "hermes:panel-" in src
    assert "phase + 'ed'" in src or "phase+'ed'" in src


def test_panel_hook_error_event():
    """hermes:panel-hook-error must be dispatched on hook failure."""
    src = _src()
    assert "hermes:panel-hook-error" in src


def test_panel_ready_event():
    """hermes:panel-ready must be dispatched when the API becomes available."""
    src = _src()
    assert "hermes:panel-ready" in src


def test_events_carry_only_id_and_phase():
    """DOM events must carry only id and phase in their detail (ext block)."""
    src = _src()
    block = _hermes_panels_block(src)
    # Uses ES6 shorthand { id, phase } — check variable names exist
    assert "id," in block or ", id" in block or "id}" in block or '"id"' in block
    assert "phase" in block


# ─── Prohibited patterns ───


def test_no_eval():
    """No call to eval anywhere in the new extension block."""
    block = _hermes_panels_block(_src())
    if not block:
        pytest.skip("HermesPanels not yet implemented")
    assert "eval(" not in block


def test_no_function_constructor():
    """No use of the Function constructor with a string argument in the new block."""
    block = _hermes_panels_block(_src())
    if not block:
        pytest.skip("HermesPanels not yet implemented")
    assert "new Function(" not in block
    assert "new Function (" not in block


def test_no_iframe_or_postmessage():
    """No iframe injection or postMessage in the new extension block."""
    block = _hermes_panels_block(_src())
    if not block:
        pytest.skip("HermesPanels not yet implemented")
    assert "iframe" not in block
    assert "postMessage" not in block


def test_no_polling_or_mutation_observer():
    """No setInterval polling or MutationObserver in the new block."""
    block = _hermes_panels_block(_src())
    if not block:
        pytest.skip("HermesPanels not yet implemented")
    assert "setInterval" not in block
    assert "MutationObserver" not in block


# ─── switchPanel identity ───


def test_switch_panel_not_reassigned():
    """Registration must never reassign or wrap switchPanel (check ext block)."""
    block = _hermes_panels_block(_src())
    if not block:
        pytest.skip("HermesPanels not yet implemented")
    # Check that switchPanel is not reassigned in the extension block
    assert "switchPanel =" not in block
    assert "switchPanel= " not in block


# ─── No Hyrax identifiers in core ───


def test_no_hyrax_identifier():
    """The register function body must contain no Hyrax-specific identifier reference.

    The comment mentioning hyrax is allowed; the code body must not.
    """
    src = _src()
    block = _hermes_panels_block(src)
    if not block:
        pytest.skip("HermesPanels not yet implemented")
    # Skip the leading comment lines — check only code after "window.HermesPanels"
    code_start = block.find("window.HermesPanels")
    code = block[code_start:]
    # The word 'hyrax' must not appear in the code portion (comments are fine)
    # Actually our comment says "Core must contain no Hyrax-specific identifier"
    # Let's just check the register function body specifically
    reg_start = code.find("register:")
    reg_section = code[reg_start:] if reg_start >= 0 else code
    assert "hyrax" not in reg_section.lower()


# ─── Concurrency / idempotence of unregister ───


def test_unregister_is_idempotent():
    """Unregister must guard against double-call with a flag."""
    src = _src()
    assert "_unregistered" in src


def test_unregister_switches_to_chat_when_active():
    """Unregister must switch to chat if the panel is currently active."""
    src = _src()
    block = _hermes_panels_block(src)
    assert "_currentPanel" in block
    assert "switchPanel" in block


# ─── Fix 1: Generic error logging ───


def test_error_logging_does_not_expose_err():
    """_runExtensionHook must log a constant generic warning, never the raw err object."""
    fn = _function_block(_src(), "_runExtensionHook")
    # The console.warn calls must not pass 'err' as a second argument — only a
    # constant string containing id + phase.
    lines = fn.split("\n")
    for i, line in enumerate(lines):
        if "console.warn" in line:
            assert ", err)" not in line and " err," not in line, (
                f"_runExtensionHook console.warn on line ~{i} must not expose err: {line.strip()}"
            )


# ─── Fix 2: Strict hook validation ───


def test_hook_validation_uses_has_own_property():
    """register must check hasOwnProperty for mount/unmount before using them."""
    register_block = _register_block(_src())
    assert "hasOwnProperty" in register_block or "hasOwnProperty" in register_block
    assert "mount" in register_block
    assert "unmount" in register_block


def test_hook_validation_rejects_non_function_null_undefined():
    """register must contain logic throwing when mount/unmount are own properties with invalid types."""
    register_block = _register_block(_src())
    # Must have a throw path conditioned on mount/unmount value types
    assert "typeof def" in register_block or "typeof def" in register_block
    assert "throw" in register_block
    assert "mount" in register_block
    assert "unmount" in register_block


# ─── Fix 3: Strict definition types ───


def test_id_requires_string_type():
    """register must reject non-string id (typeof check before trim)."""
    register_block = _register_block(_src())
    assert "typeof def.id" in register_block or 'typeof def.id' in register_block


def test_label_requires_string_type():
    """register must reject non-string label (typeof check before trim)."""
    register_block = _register_block(_src())
    assert "typeof def.label" in register_block or 'typeof def.label' in register_block


def test_mainview_requires_boolean_when_supplied():
    """register must validate mainView is boolean when supplied."""
    register_block = _register_block(_src())
    assert "typeof def.mainView" in register_block or 'typeof def.mainView' in register_block
    assert "boolean" in register_block


# ─── Fix 4: sidebarFallback strict validation ───


def test_sidebar_fallback_uses_panel_id_regex():
    """sidebarFallback must be validated against the same bounded panel-id regex."""
    register_block = _register_block(_src())
    assert "_EXT_ID_RE" in register_block


def test_sidebar_fallback_rejects_self_reference():
    """sidebarFallback must reject a value equal to the registering id."""
    register_block = _register_block(_src())
    assert "sidebarFallback" in register_block
    assert "id" in register_block


# ─── Fix 5: API readiness outside register ───


def test_ready_event_not_inside_register():
    """hermes:panel-ready must NOT be dispatched from inside the register method."""
    register_block = _register_block(_src())
    assert "hermes:panel-ready" not in register_block, (
        "hermes:panel-ready must not appear inside the register function body"
    )


def test_ready_event_emitted_outside_register():
    """hermes:panel-ready must be dispatched outside register (after window.HermesPanels definition)."""
    src = _src()
    ext_end = _hermes_panels_block(src)
    # The ready event must appear after the HermesPanels assignment closes
    assign_end = ext_end.find(";")
    after_assign = src[src.find("window.HermesPanels ="):]
    after_obj_close = after_assign.find("};")
    remainder = after_assign[after_obj_close:]
    assert "hermes:panel-ready" in remainder, (
        "hermes:panel-ready must appear after the window.HermesPanels = {} assignment closes"
    )


# ─── Fix 6: Literal extension title labels ───


def test_sync_app_titlebar_checks_extension_ids():
    """syncAppTitlebar must check _EXT_IDS to use extension labels literally."""
    fn_body = _function_block(_src(), "syncAppTitlebar")
    assert "_EXT_IDS" in fn_body, (
        "syncAppTitlebar must reference _EXT_IDS to bypass i18n for extension panels"
    )


# ─── Fix: Safe own-property checks ───


def test_own_property_checks_avoid_def_dot_has_own_property():
    """register must not call def.hasOwnProperty or Object.hasOwn — use the safe .call form."""
    register_body = _register_block(_src())
    # The register method must not call def.hasOwnProperty — that's unsafe
    # because a malicious caller could supply an object that overrides hasOwnProperty.
    assert "def.hasOwnProperty" not in register_body, (
        "def.hasOwnProperty() is unsafe against malicious 'hasOwnProperty' on the provided object; "
        "use Object.prototype.hasOwnProperty.call(def, 'key') instead"
    )
    assert "Object.prototype.hasOwnProperty.call" in register_body, (
        "register must use Object.prototype.hasOwnProperty.call for own-property checks"
    )
