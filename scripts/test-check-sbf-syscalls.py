import importlib.util
import struct
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("guard", Path(__file__).with_name("check-sbf-syscalls.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def elf_with_imports(names):
    """A minimal ELF64 with a .dynsym that imports `names` (undefined symbols) and its .dynstr."""
    strtab = b"\0" + b"".join(n.encode() + b"\0" for n in names)
    offsets, at = [], 1
    for n in names:
        offsets.append(at)
        at += len(n) + 1
    symtab = struct.pack("<IBBHQQ", 0, 0, 0, 0, 0, 0) + b"".join(struct.pack("<IBBHQQ", o, 0x10, 0, 0, 0, 0) for o in offsets)
    header = bytearray(64)
    header[:5] = b"\x7fELF\x02"
    sym_off, str_off = 64, 64 + len(symtab)
    sh_off = str_off + len(strtab)
    struct.pack_into("<Q", header, 0x28, sh_off)
    struct.pack_into("<HH", header, 0x3A, 64, 3)
    null = bytes(64)
    dynsym = struct.pack("<IIQQQQIIQQ", 0, 11, 0, 0, sym_off, len(symtab), 2, 0, 8, 24)
    dynstr = struct.pack("<IIQQQQIIQQ", 0, 3, 0, 0, str_off, len(strtab), 0, 0, 1, 0)
    return bytes(header) + symtab + strtab + null + dynsym + dynstr


class Syscalls(unittest.TestCase):
    def test_reads_the_imported_syscall_names(self):
        self.assertEqual(guard.syscalls(elf_with_imports(["sol_log_", "sol_sha256"])), {"sol_log_", "sol_sha256"})

    def test_the_inactive_remaining_compute_units_syscall_is_refused_by_name(self):
        found = guard.syscalls(elf_with_imports(["sol_log_", "sol_remaining_compute_units"]))
        bad = guard.violations(found, guard.allowed())
        self.assertEqual(len(bad), 1)
        self.assertIn("sol_remaining_compute_units", bad[0])
        self.assertIn("inactive", bad[0])

    def test_every_syscall_of_the_deployed_programs_passes(self):
        self.assertEqual(guard.violations(guard.allowed(), guard.allowed()), [])
        self.assertIn("sol_invoke_signed_rust", guard.allowed())

    def test_an_unknown_syscall_must_be_added_to_the_list_on_purpose(self):
        self.assertTrue(guard.violations({"sol_brand_new"}, guard.allowed()))


if __name__ == "__main__":
    unittest.main()
