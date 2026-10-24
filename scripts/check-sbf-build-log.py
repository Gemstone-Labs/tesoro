#!/usr/bin/env python3
"""Refuse an SBF artifact when LLVM reports stack corruption even if Cargo returned zero."""
from pathlib import Path
import re
import sys


def violations(log):
    clean = re.sub(r'\x1b\[[0-9;]*m', '', log)
    return [line for line in clean.splitlines() if re.search(r'Stack offset .*exceeded|max(?:imum)? stack frame|overwrites values in the frame|stack frame size .*exceed', line, re.I)]


if __name__ == '__main__':
    bad = violations(Path(sys.argv[1]).read_text())
    if bad:
        print('SBF build refused: stack diagnostics can indicate memory corruption even with a zero Cargo exit.', file=sys.stderr)
        for line in bad[:3]:
            print(line, file=sys.stderr)
        sys.exit(1)
