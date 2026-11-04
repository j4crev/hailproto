#!/usr/bin/env python3
"""Conservative PR impact selection and the required CI gate (stdlib only)."""
import argparse
import json
import os
import subprocess

JOBS = (
    "codec-ts", "codec-go", "web", "server", "cli", "database-server",
    "monitor", "database-monitor", "images", "monitor-image",
)

# These are test dependencies, not just runtime package dependencies. In
# particular, browser fixtures import server code and server DB tests run racr.
COMPONENTS = {
    "apps/content-builder/": {"web"},
    "packages/hail-content-builder/": set(JOBS),
    "apps/client/": {"web", "images"},
    "apps/server/": {"server", "database-server", "web", "monitor", "database-monitor", "images"},
    "apps/cli/": {"cli", "database-server"},
    "apps/plc-monitor/": {"monitor", "database-monitor", "database-server", "monitor-image"},
    "packages/hail-codec-go/": {"codec-go"},
}


def affected(path):
    # Dockerfiles copy sibling workspace manifests, even when their source is
    # not used. Shared libraries, specs, lockfiles and unknown paths fail broad.
    if path.endswith("/package.json"):
        return set(JOBS)
    for prefix, jobs in COMPONENTS.items():
        if path.startswith(prefix):
            return jobs
    # Deliberately do not exempt every .md/.txt: CLI reference docs are checked,
    # and protocol prose must trigger conformance checks alongside its vectors.
    if path in {"README.md", "AGENTS.md"} or (
        path.startswith(("agents/", "drafts/")) and path.endswith(".md")
    ):
        return set()
    return set(JOBS)


def make_plan(paths, full=False):
    paths = list(paths)
    reasons = {job: [] for job in JOBS}
    if full or not paths:
        for job in JOBS:
            reasons[job].append("full verification requested" if full else "empty diff: verify everything")
    else:
        for path in paths:
            for job in affected(path):
                reasons[job].append(path)
    return {"jobs": {job: bool(reasons[job]) for job in JOBS}, "reasons": reasons}


def changed_paths(base, head, cwd=None):
    # --no-renames includes both old and new paths. NUL delimiters preserve
    # spaces/newlines and avoid the GitHub changed-files API's pagination cap.
    output = subprocess.check_output(
        ["git", "diff", "--no-renames", "--name-only", "-z", f"{base}...{head}", "--"], cwd=cwd
    )
    return [os.fsdecode(path) for path in output.split(b"\0") if path]


def check_gate(plan, needs):
    if set(plan.get("jobs", {})) != set(JOBS):
        raise ValueError("Invalid selection: expected the complete job inventory")
    if any(type(value) is not bool for value in plan["jobs"].values()):
        raise ValueError("Invalid selection: job selections must be booleans")
    if set(needs) != set(JOBS) | {"changes"}:
        raise ValueError("Gate dependencies differ from the job inventory")
    if needs["changes"].get("result") != "success":
        raise ValueError("Change detection did not succeed")
    for job, selected in plan["jobs"].items():
        expected = "success" if selected else "skipped"
        actual = needs[job].get("result")
        if actual != expected:
            raise ValueError(f"{job}: expected {expected}, got {actual}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["select", "gate"])
    args = parser.parse_args()
    if args.command == "gate":
        check_gate(json.loads(os.environ["PLAN"]), json.loads(os.environ["NEEDS"]))
        print("All selected checks passed; every skip was explicitly planned.")
        return
    full = os.environ.get("GITHUB_EVENT_NAME") != "pull_request" or os.environ.get("FORCE_FULL") == "true"
    paths = [] if full else changed_paths(os.environ["BASE_SHA"], os.environ["HEAD_SHA"])
    plan = make_plan(paths, full=full)
    # Keep job outputs bounded even for very large PRs. Reasons belong in the
    # human-readable summary; the gate only needs the complete boolean map.
    encoded = json.dumps({"jobs": plan["jobs"]}, separators=(",", ":"))
    print(encoded)
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a") as stream:
            stream.write(f"plan={encoded}\n")
            for job, selected in plan["jobs"].items():
                stream.write(f"{job}={str(selected).lower()}\n")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a") as stream:
            stream.write("## Affected-component verification\n\n")
            for job, selected in plan["jobs"].items():
                # JSON escaping keeps filenames from creating extra lines.
                reasons = json.dumps(plan["reasons"][job][:10], ensure_ascii=True)
                if len(plan["reasons"][job]) > 10:
                    reasons += f" (and {len(plan['reasons'][job]) - 10} more paths)"
                stream.write(f"- **{job}**: {'run' if selected else 'skip'} — {reasons}\n")


if __name__ == "__main__":
    main()
