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
        rows, failures, legacy = preflight.summarize([{'address': 'old', 'data': list(old)}, {'address': 'new', 'data': list(current)}], self.layouts, 'tesoro_core')
        self.assertEqual([r['verdict'] for r in rows], ['needs migration', 'ok'])
        self.assertEqual(legacy, [])
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
        rows,failures,_=preflight.summarize(json.loads(fixture.read_text()),manifest['layouts'],'tesoro_core')
        self.assertEqual(sorted((r['sizes'][0],r['verdict']) for r in rows),[(178,'needs migration'),(327,'ok')])
        self.assertEqual(len(failures),1)

class Dispositions(unittest.TestCase):
    def layouts(self, *types):
        return [{'type': t, 'discriminator': [i] * 8, 'base': 20, 'stride': 0, 'maxExtra': 0} for i, t in enumerate(types)]

    def account(self, i, size, address='a'):
        return {'address': address, 'data': list(bytes([i] * 8) + bytes(size - 8))}

    def test_wrong_sized_records_are_legacy_skipped_not_failures(self):
        layouts = self.layouts('SourceState', 'MatchState')
        accounts = [self.account(0, 12, 's1'), self.account(0, 12, 's2'), self.account(1, 40, 'm'), self.account(1, 20, 'ok')]
        rows, failures, legacy = preflight.summarize(accounts, layouts, 'tesoro_core')
        self.assertEqual(failures, [])
        self.assertEqual({v['type']: v['count'] for v in legacy}, {'SourceState': 2, 'MatchState': 1})
        self.assertEqual(sum(r['count'] for r in rows if r['verdict'] == 'ok'), 1)

    def test_unknown_discriminators_are_legacy_skipped(self):
        rows, failures, legacy = preflight.summarize([self.account(9, 90)], self.layouts('SourceState'), 'tesoro_core')
        self.assertEqual(failures, [])
        self.assertEqual(legacy[0]['count'], 1)
        self.assertTrue(legacy[0]['type'].startswith('unknown:'))

    def test_wrong_sized_current_state_fails_even_when_records_do_not(self):
        layouts = self.layouts('NativeCustody', 'Treasury')
        rows, failures, legacy = preflight.summarize([self.account(0, 12, 'custody'), self.account(1, 28, 'treasury')], layouts, 'tesoro_core')
        self.assertEqual(sorted(f['address'] for f in failures), ['custody', 'treasury'])
        self.assertEqual(legacy, [])

    def test_the_real_178_byte_custody_fails_against_327(self):
        layouts = [{'type': 'NativeCustody', 'discriminator': list(range(8)), 'base': 327, 'stride': 0, 'maxExtra': 0}]
        _, failures, _ = preflight.summarize([{'address': 'c', 'data': list(bytes(range(8)) + bytes(170))}], layouts, 'tesoro_core')
        self.assertEqual([(f['type'], f['size']) for f in failures], [('NativeCustody', 178)])

    def test_config_grows_in_place_but_only_shorter(self):
        layouts = [{'type': 'Config', 'discriminator': list(range(8)), 'base': 970, 'stride': 0, 'maxExtra': 0}]
        short = {'address': 'c', 'data': list(bytes(range(8)) + bytes(929))}
        long = {'address': 'l', 'data': list(bytes(range(8)) + bytes(1000))}
        self.assertEqual(preflight.summarize([short], layouts, 'tesoro_core')[1], [])
        self.assertEqual(len(preflight.summarize([long], layouts, 'tesoro_core')[1]), 1)

    def test_unclassified_type_fails_closed(self):
        _, failures, _ = preflight.summarize([self.account(0, 12, 'x')], self.layouts('BrandNewAccount'), 'tesoro_core')
        self.assertEqual(len(failures), 1)

    def test_every_probe_type_is_classified_exactly_once(self):
        import re
        for name in preflight.PROGRAMS:
            src = ''.join(p.read_text() for p in (preflight.program_dir(name) / 'src').rglob('*.rs'))
            declared = set(re.findall(r'#\[account(?:\([^\]]*\))?\]\s*(?:#\[[^\]]+\]\s*)*pub struct (\w+)', src))
            both = preflight.CURRENT_STATE[name] | preflight.LEGACY_OK[name]
            self.assertEqual(declared - both, set(), name)
            self.assertEqual(preflight.CURRENT_STATE[name] & preflight.LEGACY_OK[name], set(), name)


if __name__ == '__main__':
    unittest.main()
