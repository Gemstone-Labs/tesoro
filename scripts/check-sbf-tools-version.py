#!/usr/bin/env python3
"""Fails when a tracked build script, package script, Dockerfile, README/doc or Rust hint runs `anchor build` or
`cargo build-sbf` without `--tools-version v1.54` (other versions print stack-frame errors, and an unpinned build
cannot parse the edition-2024 crates), or names a different platform-tools version anywhere.
Run from anywhere: `python3 scripts/check-sbf-tools-version.py`. Historical spike notes (docs/spikes) are skipped."""
import re
import subprocess
import sys
from pathlib import Path

PINNED = "v1.54"
BUILD = re.compile(r"(anchor build|cargo build-sbf)")
VERSION = re.compile(r"--tools-version[ =]+(v?[0-9]+(?:\.[0-9]+)*)")
SUFFIXES = {".sh", ".json", ".md", ".rs", ".yml", ".yaml", ".toml", ".py", ""}
SKIP = ("docs/spikes/", ".scratch/", "scripts/check-sbf-tools-version.py", "scripts/test-check-sbf-tools-version.py")


def problems_in(path: str, text: str) -> list[str]:
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        versions = VERSION.findall(line)
        wrong = [v for v in versions if v != PINNED]
        if wrong:
            out.append(f"{path}:{n}: platform tools {wrong[0]}; pass --tools-version {PINNED}")
        elif BUILD.search(line) and PINNED not in versions:
            out.append(f"{path}:{n}: `{BUILD.search(line).group(1)}` without --tools-version {PINNED}; add it (or run `pnpm build:programs`)")
    return out


def main() -> int:
    root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True, cwd=Path(__file__).parent).strip())
    files = subprocess.check_output(["git", "ls-files"], text=True, cwd=root).splitlines()
    bad = []
    for f in files:
        if f.startswith(SKIP) or Path(f).suffix not in SUFFIXES or f.endswith("pnpm-lock.yaml"):
            continue
        p = root / f
        if p.is_file():
            try:
                bad += problems_in(f, p.read_text())
            except UnicodeDecodeError:
                pass
    for b in bad:
        print(b, file=sys.stderr)
    if bad:
        print(f"error: every Solana build must pin --tools-version {PINNED} (scripts/build-programs.sh does)", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
