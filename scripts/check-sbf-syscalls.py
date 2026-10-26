#!/usr/bin/env python3
"""Fails when a built SBF program imports a syscall that no deployed program of ours imports.

The deploy CLI refuses an ELF with an unresolved syscall ("Unresolved symbol"), and a syscall that is
behind an inactive feature gate is unresolved on that cluster. LiteSVM enables every feature, so its
tests cannot catch it (2026-10-26: `sol_remaining_compute_units` passed every test and was refused at
deploy; its feature is inactive on devnet and mainnet).

scripts/sbf-syscalls-allowed.txt lists the syscalls the programs deployed on devnet import. A new name
must first be checked against the clusters (`solana feature status -ud` and `-um`, both must show
the feature active), then added to the list in the same change.

usage: check-sbf-syscalls.py [file.so ...]    (default: target/deploy/*.so)
"""
import struct
import sys
from pathlib import Path

ALLOWED = Path(__file__).with_name("sbf-syscalls-allowed.txt")
KNOWN_INACTIVE = {"sol_remaining_compute_units": "feature 5TuppMutoyzhUSfuYdhgzD47F92GL1g89KpCZQKqedxP is inactive on devnet and mainnet"}


def syscalls(data: bytes) -> set:
    """Names of the undefined dynamic symbols (the syscalls) of an ELF64 file."""
    if data[:4] != b"\x7fELF" or data[4] != 2:
        raise ValueError("not an ELF64 file")
    shoff, = struct.unpack_from("<Q", data, 0x28)
    shentsize, shnum = struct.unpack_from("<HH", data, 0x3A)
    sections = [struct.unpack_from("<IIQQQQIIQQ", data, shoff + i * shentsize) for i in range(shnum)]
    names = set()
    for _name, kind, _flags, _addr, offset, size, link, _info, _align, entsize in sections:
        if kind != 11:  # SHT_DYNSYM
            continue
        strtab = sections[link]
        for i in range(size // (entsize or 24)):
            st_name, _info2, _other, shndx, _value, _size = struct.unpack_from("<IBBHQQ", data, offset + i * 24)
            if shndx == 0 and st_name:
                start = strtab[4] + st_name
                names.add(data[start:data.index(b"\0", start)].decode())
    return names


def allowed() -> set:
    return {l.strip() for l in ALLOWED.read_text().splitlines() if l.strip() and not l.startswith("#")}


def violations(found: set, ok: set) -> list:
    out = []
    for name in sorted(found - ok):
        why = KNOWN_INACTIVE.get(name, "not imported by any deployed program")
        out.append(f"syscall {name}: {why}. Check `solana feature status` on devnet and mainnet, then add it to {ALLOWED.name}.")
    return out


def main(argv) -> int:
    files = [Path(a) for a in argv] or sorted(Path("target/deploy").glob("*.so"))
    if not files:
        print("error: no .so files to check", file=sys.stderr)
        return 1
    ok, bad = allowed(), []
    for f in files:
        bad += [f"{f.name}: {v}" for v in violations(syscalls(f.read_bytes()), ok)]
    for line in bad:
        print("error: " + line, file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
