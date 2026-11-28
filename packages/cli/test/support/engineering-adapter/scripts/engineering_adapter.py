"""Subprocess fixture: records argv, never evaluates it or prints credentials."""

import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
if os.environ.get("ENGINEERING_FIXTURE_LOG"):
    with Path(os.environ["ENGINEERING_FIXTURE_LOG"]).open("a") as log:
        log.write(json.dumps({"argv": args, "has_token": bool(os.environ.get("GITAMESH_TOKEN"))}) + "\n")

if args == ["--protocol"]:
    mode = os.environ.get("ENGINEERING_FIXTURE_PROTOCOL", "gitamesh-engineering/1")
    if mode == "invalid-json":
        print("not json")
    else:
        print(json.dumps({"protocol": mode, "adapter": "fixture", "commands": ["doctor", "status", "plan", "next", "audit", "run", "verify", "reconcile"]}))
    sys.exit(int(os.environ.get("ENGINEERING_FIXTURE_PROBE_EXIT", "0")))

code = int(os.environ.get("ENGINEERING_FIXTURE_EXIT", "0"))
envelope = {"protocol": "gitamesh-engineering/1", "command": args[0],
            "ok": code == 0, "mutations": 0, "result": {"argv": args},
            "blockers": [] if code == 0 else ["fixture blocker"], "error": None}
# Deliberate spacing proves the CLI does not reserialize machine output.
print(json.dumps(envelope, separators=(", ", " : ")))
sys.exit(code)
