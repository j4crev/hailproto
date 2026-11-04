import copy
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

from plan import JOBS, changed_paths, check_gate, make_plan


class SelectionTests(unittest.TestCase):
    def selected(self, *paths):
        return {job for job, selected in make_plan(paths)["jobs"].items() if selected}

    def test_web_does_not_run_unrelated_suites(self):
        self.assertEqual(self.selected("apps/client/src/lib/compose.ts"), {"web", "images"})

    def test_server_includes_consuming_browser_and_monitor_tests(self):
        self.assertEqual(self.selected("apps/server/src/app.ts"),
                         {"server", "database-server", "web", "monitor", "database-monitor", "images"})

    def test_cli_includes_real_server_interoperability(self):
        self.assertEqual(self.selected("apps/cli/src/main.rs"), {"cli", "database-server"})

    def test_monitor_includes_provider_signup(self):
        self.assertEqual(self.selected("apps/plc-monitor/src/monitor.ts"),
                         {"monitor", "database-monitor", "database-server", "monitor-image"})

    def test_builder_ownership(self):
        self.assertEqual(self.selected("apps/content-builder/src/main.ts"), {"web"})
        self.assertEqual(self.selected("packages/hail-content-builder/src/core.ts"), set(JOBS))

    def test_go_is_independent(self):
        self.assertEqual(self.selected("packages/hail-codec-go/codec.go"), {"codec-go"})

    def test_multi_component_union(self):
        self.assertEqual(self.selected("apps/client/src/app.html", "apps/cli/src/main.rs"),
                         {"web", "images", "cli", "database-server"})

    def test_global_and_unknown_changes_are_full(self):
        for path in ["bun.lock", "package.json", "mise.toml", "tsconfig.json", ".gitmodules",
                     ".github/workflows/ci.yml", "scripts/ci/plan.py", "new-app/src/index.ts",
                     "packages/hail-codec-ts/src/index.ts", "packages/hail-client-support/src/vault-crypto.ts",
                     "vendor/did-method-plc", "spec/README.md", "spec/hail.cddl", "spec/vectors/new.json",
                     "apps/client/package.json", "apps/cli/package.json"]:
            with self.subTest(path=path):
                self.assertEqual(self.selected(path), set(JOBS))

    def test_only_explicit_prose_paths_skip(self):
        self.assertEqual(self.selected("README.md", "AGENTS.md", "agents/ci.md", "drafts/idea.md"), set())
        self.assertEqual(self.selected("apps/cli/docs/commands.md"), {"cli", "database-server"})
        self.assertEqual(self.selected("fixtures/input.txt"), set(JOBS))

    def test_empty_diff_and_force_full(self):
        self.assertEqual(self.selected(), set(JOBS))
        self.assertTrue(all(make_plan(["README.md"], full=True)["jobs"].values()))

    def test_git_diff_uses_entire_pr_and_preserves_deleted_and_renamed_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(["git", "-C", directory, *args], stderr=subprocess.DEVNULL).decode().strip()
            git("init")
            git("config", "user.name", "CI test")
            git("config", "user.email", "ci@example.invalid")
            (root / "apps/server").mkdir(parents=True)
            (root / "apps/server/old.ts").write_text("fixture")
            git("add", ".")
            git("commit", "-m", "base")
            base = git("rev-parse", "HEAD")
            (root / "README.md").write_text("fixture")
            (root / "apps/server/old.ts").unlink()
            git("add", "-A")
            git("commit", "-m", "move code to docs")
            (root / "apps/client").mkdir()
            (root / "apps/client/space and\nnewline.ts").write_text("fixture")
            git("add", "-A")
            git("commit", "-m", "second commit")
            paths = changed_paths(base, "HEAD", cwd=directory)
            self.assertEqual(set(paths), {"apps/server/old.ts", "README.md", "apps/client/space and\nnewline.ts"})
            self.assertIn("database-server", self.selected(*paths))


class GateTests(unittest.TestCase):
    def setUp(self):
        self.plan = make_plan(["apps/client/src/app.html"])
        self.needs = {job: {"result": "success" if selected else "skipped"}
                      for job, selected in self.plan["jobs"].items()}
        self.needs["changes"] = {"result": "success"}

    def test_expected_results_pass(self):
        check_gate(self.plan, self.needs)

    def test_full_and_documentation_only_gates(self):
        for paths in [["spec/hail.cddl"], ["README.md"]]:
            plan = make_plan(paths)
            needs = {job: {"result": "success" if selected else "skipped"}
                     for job, selected in plan["jobs"].items()}
            needs["changes"] = {"result": "success"}
            check_gate(plan, needs)

    def test_selected_failure_cancellation_and_skip_block(self):
        for result in ["failure", "cancelled", "skipped", None]:
            with self.subTest(result=result), self.assertRaises(ValueError):
                needs = copy.deepcopy(self.needs)
                needs["web"]["result"] = result
                check_gate(self.plan, needs)

    def test_detector_failure_blocks(self):
        self.needs["changes"]["result"] = "failure"
        with self.assertRaises(ValueError):
            check_gate(self.plan, self.needs)

    def test_incomplete_or_untyped_selection_blocks(self):
        for value in [{}, {"web": True}, dict.fromkeys(JOBS, "false")]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                check_gate({"jobs": value}, self.needs)

    def test_missing_dependency_blocks(self):
        del self.needs["images"]
        with self.assertRaises(ValueError):
            check_gate(self.plan, self.needs)

    def test_unplanned_execution_blocks(self):
        self.needs["cli"]["result"] = "success"
        with self.assertRaises(ValueError):
            check_gate(self.plan, self.needs)

    def test_workflow_inventory_matches_gate(self):
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml").read_text()
        jobs = set(re.findall(r"^  ([a-z][a-z-]+):$", workflow.split("\njobs:\n", 1)[1], re.M))
        self.assertEqual(jobs, set(JOBS) | {"changes", "verify", "verify-main"})

    def test_new_workspaces_require_explicit_ci_ownership(self):
        root = Path(__file__).resolve().parents[2]
        manifests = {str(path.relative_to(root)) for group in ["apps", "packages"]
                     for path in (root / group).glob("*/package.json")}
        self.assertEqual(manifests, {
            "apps/client/package.json", "apps/server/package.json",
            "apps/content-builder/package.json", "packages/hail-content-builder/package.json",
            "apps/cli/package.json", "apps/plc-monitor/package.json",
            "packages/hail-codec-ts/package.json", "packages/hail-client-support/package.json",
        }, "Assign new workspaces to CI jobs and update the selection map")


if __name__ == "__main__":
    unittest.main()
