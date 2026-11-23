#!/usr/bin/env python3
"""Pins the SBF compiler by path and proves the build used it.

An SBF build resolves rustc through one rustup toolchain, `solana`, that every SBF build on the machine re-points to
the platform-tools version it was asked for, and cargo fingerprints only `rustc -vV`, which platform tools v1.52 and
v1.54 print identically. A v1.52 build in another project therefore swaps the compiler under a running v1.54 build,
crate by crate, and cargo notices nothing (2026-11-23: railcar.so failed every LiteSVM ride at
the first instruction; Railcar ticket 37). scripts/build-programs.sh now runs the compiler from its own directory and
passes every rustc through scripts/sbf-rustc-wrapper.sh, which logs the path it ran; this script checks both ends.

usage: check-sbf-toolchain.py tools                 prints the pinned tools directory, exits 1 if it is not v1.54
       check-sbf-toolchain.py rustc-log <file>      exits 1 unless every rustc the build ran came from that directory
"""
import os
import sys
from pathlib import Path

PINNED = "v1.54"
# Lines of version.md in a platform-tools release: "<commit>  <repo url>".
COMMITS = {
    "rust": "daa3af4a1110ec3f10ce08083bb0b7855a88416f",
    "cargo": "d96b806368b1a00ea55a3e2f08876edc4e86bc3e",
    "newlib": "f0f8003daa3f71a1a3e2f067f8d5bb46e2756514",
}
BINARIES = ("rust/bin/rustc", "rust/bin/cargo", "llvm/bin/clang", "llvm/bin/llvm-objcopy")
INSTALL = "install them once with `cargo build-sbf --tools-version v1.54 --manifest-path programs/sim_lst/Cargo.toml`"


def tools_dir() -> Path:
    return Path(os.environ.get("TESORO_SBF_TOOLS") or Path.home() / ".cache" / "solana" / PINNED / "platform-tools")


def tools_problems(tools: Path) -> list[str]:
    version = tools / "version.md"
    if not version.is_file():
        return [f"{tools}: no platform tools {PINNED} there ({INSTALL})"]
    found = {}
    for line in version.read_text().splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].endswith(".git"):
            found[parts[1].rsplit("/", 1)[1][:-4]] = parts[0]
    out = [f"{version}: {name} is {found.get(name, 'missing')}, platform tools {PINNED} ship {commit}" for name, commit in COMMITS.items() if found.get(name) != commit]
    out += [f"{tools / b}: missing or not executable ({INSTALL})" for b in BINARIES if not os.access(tools / b, os.X_OK)]
    return out


def rustc_log_problems(lines: list[str], tools: Path) -> list[str]:
    ran = sorted({line.strip() for line in lines if line.strip()})
    if not ran:
        return ["no rustc ran through scripts/sbf-rustc-wrapper.sh: RUSTC_WRAPPER was not applied, the build cannot be trusted"]
    prefix = str(tools.resolve()) + os.sep
    return [f"{path}: not the pinned platform tools {PINNED} at {tools}; another SBF build on this machine swapped the compiler mid-build, rebuild with pnpm build:programs" for path in ran if not path.startswith(prefix)]


def main(argv: list[str]) -> int:
    tools = tools_dir()
    if argv[:1] == ["tools"]:
        bad = tools_problems(tools)
        print(tools)
    elif len(argv) == 2 and argv[0] == "rustc-log":
        bad = rustc_log_problems(Path(argv[1]).read_text().splitlines(), tools)
    else:
        print(__doc__, file=sys.stderr)
        return 2
    for b in bad:
        print(b, file=sys.stderr)
    if bad:
        print(f"error: the SBF build must use platform tools {PINNED} by path (scripts/build-programs.sh does)", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
