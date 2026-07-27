#!/usr/bin/env python3
"""Seed VN sessions with transcript history into an isolated HERMES_HOME.

Uses the repo's own api.models Session class so the on-disk format (session
file + index) is exactly what the server reads back. Run BEFORE booting the
isolated server, with HERMES_HOME / HERMES_WEBUI_STATE_DIR pointed at the
isolated state dir.

Usage: python3 tests/_vn_seed_sessions.py <state_dir>
"""
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(state_dir):
    os.environ["HERMES_HOME"] = state_dir
    os.environ["HERMES_BASE_HOME"] = state_dir
    os.environ["HERMES_WEBUI_STATE_DIR"] = state_dir
    os.environ["HERMES_WEBUI_SKIP_ONBOARDING"] = "1"
    os.environ["HERMES_WEBUI_AGENT_DIR"] = os.path.join(state_dir, "no-agent")
    for k in list(os.environ):
        if k.endswith("_API_KEY"):
            os.environ.pop(k, None)
    if REPO not in sys.path:
        sys.path.insert(0, REPO)

    # Session.save writes <HERMES_HOME>/sessions/<sid>.json and expects the
    # dir to exist (the running server creates it lazily; we run pre-boot).
    os.makedirs(os.path.join(state_dir, "sessions"), exist_ok=True)

    from api import models

    # Tai: long history (enough rows to overflow the dialogue scroller so the
    # initial-scroll assertion is meaningful).
    tai = models.new_session(profile="tai", project_id="hyrax-vn")
    tai.title = "Tai VN"
    msgs = []
    for i in range(30):
        msgs.append({
            "id": f"seed-u-{i}", "role": "user",
            "content": f"seed question {i} — status on the gateway refactor?",
        })
        msgs.append({
            "id": f"seed-a-{i}", "role": "assistant",
            "content": f"seed answer {i} — all green, thanks for checking in.",
        })
    tai.messages = msgs
    tai.save()

    # Rei: short history — only needed so her VN mounts with a real session.
    # The final assistant row carries markdown (fenced code, bold, list) so
    # the dialogue-render harness can assert the markdown pipeline is live.
    rei = models.new_session(profile="rei", project_id="hyrax-vn")
    rei.title = "Rei VN"
    rei.messages = [
        {"id": "seed-rei-u-0", "role": "user", "content": "evening check"},
        {"id": "seed-rei-a-0", "role": "assistant", "content": "perimeter quiet."},
        {"id": "seed-rei-u-1", "role": "user",
         "content": "show me the gateway status snippet again"},
        {"id": "seed-rei-a-1", "role": "assistant",
         "content": (
             "Here it is — **all green** across the board:\n\n"
             "```bash\n"
             "gatewayctl status --cluster east\n"
             "# 3/3 nodes healthy\n"
             "```\n\n"
             "Notes:\n\n"
             "- latency steady at 41ms\n"
             "- cert rotation scheduled\n"
         )},
    ]
    rei.save()

    print(f"seeded tai={tai.session_id} rei={rei.session_id} into {state_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
