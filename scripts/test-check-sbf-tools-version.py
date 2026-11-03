import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("guard", Path(__file__).with_name("check-sbf-tools-version.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class Check(unittest.TestCase):
    def test_pinned_command_passes(self):
        self.assertEqual(guard.problems_in("a.sh", "anchor build --no-idl -- --tools-version v1.54 2>&1"), [])
        self.assertEqual(guard.problems_in("a.md", "`cargo build-sbf --tools-version v1.54` for the bridge"), [])

    def test_missing_version_fails_and_names_the_fix(self):
        out = guard.problems_in("a.sh", "anchor build --no-idl")
        self.assertEqual(len(out), 1)
        self.assertIn("--tools-version v1.54", out[0])
        self.assertEqual(len(guard.problems_in("flow.rs", '.expect("build the bridge first: cargo build-sbf");')), 1)

    def test_other_version_fails(self):
        self.assertEqual(len(guard.problems_in("a.sh", "cargo build-sbf --tools-version v1.52")), 1)
        self.assertEqual(len(guard.problems_in("a.sh", "echo --tools-version=v1.52")), 1)

    def test_repo_is_clean(self):
        self.assertEqual(guard.main(), 0)


if __name__ == "__main__":
    unittest.main()
