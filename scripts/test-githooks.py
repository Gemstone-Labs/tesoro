"""Runs .githooks/pre-commit and .githooks/pre-push in a throwaway repo, with eslint, cargo, pnpm and systemd-run
replaced by stubs that record how they were called. Run: python3 scripts/test-githooks.py"""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HOOKS = Path(__file__).parent.parent / ".githooks"
ZERO = "0" * 40
GITHUB = "https://github.com/Gemstone-Labs/tesoro.git"

STUBS = {
    "cargo": 'echo "cargo $*" >> "$STUB_LOG"\n[ -n "${CARGO_OUT:-}" ] && printf "%s\\n" "$CARGO_OUT"\nexit "${CARGO_EXIT:-0}"\n',
    "pnpm": 'echo "pnpm $*" >> "$STUB_LOG"\ncase "$*" in *"${PNPM_FAIL:-no such call}"*) exit 1 ;; esac\nexit 0\n',
    "systemd-run": 'while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
}
ESLINT = 'echo "eslint $*" >> "$STUB_LOG"\nexit "${ESLINT_EXIT:-0}"\n'


class HookCase(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp(prefix="githooks-test-"))
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.bin = self.repo / ".stubs"
        self.bin.mkdir()
        for name, body in STUBS.items():
            self.stub(self.bin / name, body)
        self.log = self.repo / ".stub-log"
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "STUB_LOG": str(self.log),
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@example.com",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@example.com",
        }
        self.git("init", "-q", "-b", "main")
        self.write(".gitignore", ".stubs/\n.stub-log\nnode_modules/\n")
        self.write("README.md", "start\n")
        self.base = self.commit("start")

    def stub(self, path, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/usr/bin/env bash\n" + body)
        path.chmod(0o755)

    def install_deps(self):
        self.stub(self.repo / "app/node_modules/.bin/eslint", ESLINT)
        (self.repo / "keeper/node_modules").mkdir(parents=True)

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, env=self.env, check=True, capture_output=True, text=True).stdout.strip()

    def write(self, rel, text):
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def stage(self, rel, text="export const a = 1;\n"):
        self.write(rel, text)
        self.git("add", "--", rel)

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "--no-verify", "-m", message)
        return self.git("rev-parse", "HEAD")

    def run_hook(self, name, *args, stdin="", **env):
        return subprocess.run([str(HOOKS / name), *args], cwd=self.repo, env={**self.env, **env}, input=stdin, capture_output=True, text=True)

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []


class PreCommit(HookCase):
    def test_other_files_run_no_checks(self):
        self.install_deps()
        self.stage("docs/notes.md", "hello\n")
        result = self.run_hook("pre-commit")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.calls(), [])

    def test_staged_app_sources_are_linted_by_their_own_paths(self):
        self.install_deps()
        self.stage("app/src/app/(app)/account/[key]/page.tsx")
        self.stage("app/src/lib/money.ts")
        self.write("app/src/lib/unstaged.ts", "export const b = 2;\n")
        result = self.run_hook("pre-commit")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.calls(), ["eslint --max-warnings=0 -- src/app/(app)/account/[key]/page.tsx src/lib/money.ts"])

    def test_lint_failure_blocks_the_commit(self):
        self.install_deps()
        self.stage("app/src/lib/money.ts")
        result = self.run_hook("pre-commit", ESLINT_EXIT="1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("commit blocked by lint", result.stdout)

    def test_missing_dependencies_name_the_install_command(self):
        self.stage("app/src/lib/money.ts")
        result = self.run_hook("pre-commit")
        self.assertEqual(result.returncode, 1)
        self.assertIn("pnpm install --frozen-lockfile", result.stdout)

    def test_unformatted_staged_rust_blocks_the_commit(self):
        self.stage("programs/tesoro_core/src/lib.rs", "fn a(){}\n")
        result = self.run_hook("pre-commit", CARGO_EXIT="1", CARGO_OUT=str(self.repo / "programs/tesoro_core/src/lib.rs"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("programs/tesoro_core/src/lib.rs", result.stdout)
        self.assertIn("cargo fmt --all", result.stdout)
        self.assertEqual(self.calls(), ["cargo fmt --all --check -- -l"])

    def test_another_sessions_unformatted_file_does_not_block(self):
        self.stage("programs/tesoro_core/src/lib.rs", "fn a() {}\n")
        self.write("programs/holdem/src/lib.rs", "fn b(){}\n")
        result = self.run_hook("pre-commit", CARGO_EXIT="1", CARGO_OUT=str(self.repo / "programs/holdem/src/lib.rs"))
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_a_format_check_that_cannot_run_blocks_the_commit(self):
        self.stage("programs/tesoro_core/src/lib.rs", "fn a() {}\n")
        result = self.run_hook("pre-commit", CARGO_EXIT="101", CARGO_OUT="error: toolchain '1.91.1' is not installed")
        self.assertEqual(result.returncode, 1)
        self.assertIn("could not run", result.stdout)
        self.assertIn("is not installed", result.stdout)

    def test_rust_outside_the_workspace_is_not_format_checked(self):
        self.stage("bridge/programs/tesoro_bridge/src/lib.rs", "fn a(){}\n")
        result = self.run_hook("pre-commit", CARGO_EXIT="1")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.calls(), [])

    def test_secrets_are_still_refused(self):
        self.stage("keeper/id.json", "[]\n")
        result = self.run_hook("pre-commit")
        self.assertEqual(result.returncode, 1)
        self.assertIn("refusing key file", result.stdout)


class PrePush(HookCase):
    APP = "pnpm --filter @tesoro/app typecheck"
    KEEPER = "pnpm --filter @tesoro/keeper typecheck"

    def push(self, local, remote_sha, url=GITHUB, **env):
        line = f"refs/heads/work {local} refs/heads/work {remote_sha}\n"
        return self.run_hook("pre-push", "origin", url, stdin=line, **env)

    def change(self, rel):
        self.write(rel, "export const a = 1;\n")
        return self.commit(f"change {rel}")

    def test_a_push_to_the_build_server_is_not_checked(self):
        self.install_deps()
        head = self.change("app/src/lib/money.ts")
        result = self.push(head, self.base, url="ssh://vps/home/ailton/builds/55")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.calls(), [])

    def test_a_push_that_leaves_the_app_and_keeper_alone_is_not_checked(self):
        self.install_deps()
        head = self.change("docs/notes.md")
        result = self.push(head, self.base)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.calls(), [])

    def test_an_app_change_type_checks_the_app_and_the_keeper(self):
        self.install_deps()
        head = self.change("app/src/lib/money.ts")
        result = self.push(head, self.base)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.calls(), [self.APP, self.KEEPER])

    def test_a_keeper_change_type_checks_the_keeper_only(self):
        self.install_deps()
        head = self.change("keeper/src/index.ts")
        result = self.push(head, self.base)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.calls(), [self.KEEPER])

    def test_a_type_error_blocks_the_push(self):
        self.install_deps()
        head = self.change("app/src/lib/money.ts")
        result = self.push(head, self.base, PNPM_FAIL="@tesoro/app typecheck")
        self.assertEqual(result.returncode, 1)
        self.assertIn("push blocked", result.stdout)
        self.assertEqual(self.calls(), [self.APP])

    def test_a_new_branch_is_compared_with_the_remote_main(self):
        self.install_deps()
        self.git("update-ref", "refs/remotes/origin/main", self.base)
        head = self.change("keeper/src/index.ts")
        result = self.push(head, ZERO)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.calls(), [self.KEEPER])

    def test_a_remote_commit_this_clone_lacks_counts_as_changed(self):
        self.install_deps()
        head = self.change("docs/notes.md")
        result = self.push(head, "1" * 40)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.calls(), [self.APP, self.KEEPER])

    def test_a_commit_that_is_not_checked_out_cannot_be_pushed_unchecked(self):
        self.install_deps()
        pushed = self.change("app/src/lib/money.ts")
        self.change("docs/later.md")
        result = self.push(pushed, self.base)
        self.assertEqual(result.returncode, 1)
        self.assertIn("is not the checked-out commit", result.stdout)
        self.assertEqual(self.calls(), [])

    def test_deleting_a_remote_branch_is_not_checked(self):
        result = self.push(ZERO, self.base)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.calls(), [])

    def test_missing_dependencies_name_the_install_command(self):
        head = self.change("app/src/lib/money.ts")
        result = self.push(head, self.base)
        self.assertEqual(result.returncode, 1)
        self.assertIn("pnpm install --frozen-lockfile", result.stdout)


if __name__ == "__main__":
    unittest.main()
