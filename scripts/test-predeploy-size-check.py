#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('preflight', Path(__file__).with_name('predeploy-size-check.py'))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class AccountSizes(unittest.TestCase):
    def setUp(self):
        # Fixture expectations mirror the past incident; production expectations come only from Rust.
        self.layouts = [{'type': 'NativeCustody', 'discriminator': list(range(8)), 'base': 327, 'stride': 0, 'maxExtra': 0}]

    def test_real_past_custody_size_mismatch_fails(self):
        old = bytes(range(8)) + bytes(170)
        current = bytes(range(8)) + bytes(319)
        rows, failures = preflight.summarize([{'address': 'old', 'data': list(old)}, {'address': 'new', 'data': list(current)}], self.layouts)
        self.assertEqual([r['verdict'] for r in rows], ['needs migration', 'ok'])
        self.assertEqual([r['address'] for r in failures], ['old'])

    def test_unknown_and_truncated_discriminators_fail_closed(self):
        for raw in [b'', b'unknown!', bytes(range(7))]:
            self.assertEqual(preflight.classify(raw, self.layouts)[2], "can't decode")

    def test_dynamic_sizes_and_versions_are_checked(self):
        layout = {'type': 'BasketHead', 'discriminator': list(range(8)), 'base': 136, 'stride': 144, 'maxExtra': 2, 'versions': [[8, 3]]}
        for size, version, wanted in [(136,3,'ok'),(280,3,'ok'),(424,3,'ok'),(568,3,'needs migration'),(281,3,'needs migration'),(280,2,"can't decode")]:
            raw=bytearray(size);raw[:8]=bytes(range(8));raw[8]=version
            self.assertEqual(preflight.classify(raw,[layout])[2],wanted)

    def test_litesvm_generated_accounts_when_present(self):
        # The remote Rust test writes the fixture; absence is explicit, never counted as LiteSVM proof.
        fixture = preflight.ROOT / 'target/account-layouts/litesvm-custody.json'
        if not fixture.exists():
            self.skipTest('Run native_custody_old_and_new_sizes and extract its two TESORO_LAYOUT_FIXTURE rows first')
        manifest=json.loads((fixture.parent/'tesoro_core.json').read_text())
        rows,failures=preflight.summarize(json.loads(fixture.read_text()),manifest['layouts'])
        self.assertEqual(sorted((r['sizes'][0],r['verdict']) for r in rows),[(178,'needs migration'),(327,'ok')])
        self.assertEqual(len(failures),1)


if __name__ == '__main__':
    unittest.main()
