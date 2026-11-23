import importlib.util
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("guard", HERE / "check-sbf-toolchain.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
WRAPPER = HERE / "sbf-rustc-wrapper.sh"
PRIVATE_SDK = HERE / "sbf-private-sdk.sh"

VERSION_MD = """daa3af4a1110ec3f10ce08083bb0b7855a88416f  https://github.com/anza-xyz/rust.git
d96b806368b1a00ea55a3e2f08876edc4e86bc3e  https://github.com/anza-xyz/cargo.git
f0f8003daa3f71a1a3e2f067f8d5bb46e2756514  https://github.com/anza-xyz/newlib.git
"""
# What ~/.cache/solana/v1.52/platform-tools/version.md says: same `rustc -vV` as v1.54, different compiler.
V152_MD = VERSION_MD.replace("daa3af4a1110ec3f10ce08083bb0b7855a88416f", "790f1537507dbdb0da320fbb3b1c1eca3b33c474").replace("d96b806368b1a00ea55a3e2f08876edc4e86bc3e", "ca74c32f0ac6d99000858dcae9b0931ef76a8f43")


def fake_tools(root: Path, version_md: str = VERSION_MD) -> Path:
    tools = root / "platform-tools"
    (tools / "version.md").parent.mkdir(parents=True)
    (tools / "version.md").write_text(version_md)
    for b in guard.BINARIES:
        p = tools / b
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("#!/bin/sh\necho ran $0\n")
        p.chmod(0o755)
    return tools


class ToolsDir(unittest.TestCase):
    def test_pinned_tools_pass(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(guard.tools_problems(fake_tools(Path(d))), [])

    def test_v152_tools_fail_and_name_the_pin(self):
        with tempfile.TemporaryDirectory() as d:
            out = guard.tools_problems(fake_tools(Path(d), V152_MD))
            self.assertEqual(len(out), 2)
            self.assertIn("rust is 790f1537507dbdb0da320fbb3b1c1eca3b33c474, platform tools v1.54 ship daa3af4a", out[0])

    def test_missing_tools_name_the_install(self):
        out = guard.tools_problems(Path("/nonexistent/platform-tools"))
        self.assertEqual(len(out), 1)
        self.assertIn("cargo build-sbf --tools-version v1.54", out[0])

    def test_missing_binary_fails(self):
        with tempfile.TemporaryDirectory() as d:
            tools = fake_tools(Path(d))
            (tools / "llvm/bin/llvm-objcopy").unlink()
            self.assertEqual(len(guard.tools_problems(tools)), 1)


class RustcLog(unittest.TestCase):
    tools = Path.home() / ".cache/solana/v1.54/platform-tools"

    def test_v152_rustc_mid_build_is_refused(self):
        # The 2026-11-23 build: the shared toolchain pointed at v1.52 for part of the build.
        log = [f"{self.tools}/rust/bin/rustc"] * 200 + [str(self.tools.parent.parent / "v1.52/platform-tools/rust/bin/rustc")] * 185
        out = guard.rustc_log_problems(log, self.tools)
        self.assertEqual(len(out), 1)
        self.assertIn("v1.52/platform-tools/rust/bin/rustc: not the pinned platform tools v1.54", out[0])
        self.assertIn("pnpm build:programs", out[0])

    def test_only_pinned_rustc_passes(self):
        self.assertEqual(guard.rustc_log_problems([f"{self.tools}/rust/bin/rustc\n"] * 433, self.tools), [])

    def test_empty_log_is_refused(self):
        out = guard.rustc_log_problems([], self.tools)
        self.assertEqual(len(out), 1)
        self.assertIn("RUSTC_WRAPPER was not applied", out[0])


class Wrapper(unittest.TestCase):
    def run_wrapper(self, tools: Path, rustc_dir: Path, log: Path):
        env = {**os.environ, "PATH": f"{rustc_dir}:{os.environ['PATH']}", "TESORO_SBF_TOOLS": str(tools), "TESORO_SBF_RUSTC_LOG": str(log)}
        return subprocess.run([str(WRAPPER), "rustc", "--crate-name", "x"], env=env, capture_output=True, text=True)

    def test_pinned_rustc_runs_and_is_logged(self):
        with tempfile.TemporaryDirectory() as d:
            tools = fake_tools(Path(d))
            log = Path(d) / "rustc.log"
            r = self.run_wrapper(tools, tools / "rust/bin", log)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("ran ", r.stdout)
            self.assertEqual(log.read_text().strip(), str((tools / "rust/bin/rustc").resolve()))
            self.assertEqual(guard.rustc_log_problems(log.read_text().splitlines(), tools), [])

    def test_other_rustc_is_refused_and_logged(self):
        with tempfile.TemporaryDirectory() as d:
            tools = fake_tools(Path(d) / "v1.54")
            other = fake_tools(Path(d) / "v1.52", V152_MD)
            log = Path(d) / "rustc.log"
            r = self.run_wrapper(tools, other / "rust/bin", log)
            self.assertEqual(r.returncode, 1)
            self.assertNotIn("ran ", r.stdout)
            self.assertIn("outside the pinned platform tools", r.stderr)
            self.assertEqual(len(guard.rustc_log_problems(log.read_text().splitlines(), tools)), 1)


@unittest.skipUnless(shutil.which("cargo-build-sbf"), "needs the Solana SBF SDK next to cargo-build-sbf")
class PrivateSdk(unittest.TestCase):
    """The copy must keep the SDK's install.sh idle: on 2026-11-23 a copy without the marker files made it re-point
    platform-tools to v1.48 and re-link the machine-wide `solana` rustup toolchain at the first program's strip."""

    def run_install(self, sdk: Path, tripwire: Path):
        bin_dir = tripwire / "bin"
        bin_dir.mkdir(parents=True)
        for tool in ("rustup", "wget", "curl"):
            (bin_dir / tool).write_text(f"#!/bin/sh\necho {tool} $* >> {tripwire}/calls\nexit 1\n")
            (bin_dir / tool).chmod(0o755)
        env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"}
        r = subprocess.run(["bash", str(sdk / "scripts/install.sh")], env=env, capture_output=True, text=True)
        calls = (tripwire / "calls").read_text() if (tripwire / "calls").exists() else ""
        return r.returncode, calls

    def test_install_sh_stays_idle_on_the_copy(self):
        with tempfile.TemporaryDirectory() as d:
            tools = fake_tools(Path(d))
            sdk = Path(d) / "sdk"
            subprocess.run([str(PRIVATE_SDK), str(tools), str(sdk)], check=True, capture_output=True, text=True)
            code, calls = self.run_install(sdk, Path(d) / "trip")
            self.assertEqual((code, calls), (0, ""))
            self.assertEqual(os.readlink(sdk / "dependencies/platform-tools"), str(tools))

    def test_without_the_markers_install_sh_acts(self):
        with tempfile.TemporaryDirectory() as d:
            tools = fake_tools(Path(d))
            sdk = Path(d) / "sdk"
            subprocess.run([str(PRIVATE_SDK), str(tools), str(sdk)], check=True, capture_output=True, text=True)
            for marker in (sdk / "dependencies").glob("*.md"):
                marker.unlink()
            code, calls = self.run_install(sdk, Path(d) / "trip")
            self.assertTrue(code != 0 or calls, "install.sh did nothing without its markers: the tripwire is dead")


class BuildScript(unittest.TestCase):
    def test_build_script_pins_the_tools(self):
        text = (HERE / "build-programs.sh").read_text()
        for needle in ("check-sbf-toolchain.py tools", "scripts/sbf-private-sdk.sh \"$tools\" \"$sdk\"", "RUSTC_WRAPPER=\"$PWD/scripts/sbf-rustc-wrapper.sh\"", "--no-rustup-override --skip-tools-install --sbf-sdk", "check-sbf-toolchain.py rustc-log", "readlink \"$sdk/dependencies/platform-tools\""):
            self.assertIn(needle, text)


if __name__ == "__main__":
    unittest.main()
