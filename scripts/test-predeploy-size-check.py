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
        rows, failures, legacy = preflight.summarize([{'address': 'old', 'data': list(old)}, {'address': 'new', 'data': list(current)}], self.layouts)
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
        rows,failures,_=preflight.summarize(json.loads(fixture.read_text()),manifest['layouts'])
        self.assertEqual(sorted((r['sizes'][0],r['verdict']) for r in rows),[(178,'needs migration'),(327,'ok')])
        self.assertEqual(len(failures),1)

class Dispositions(unittest.TestCase):
    def layouts(self, *types, **retired):
        return [{'type': t, 'discriminator': [i] * 8, 'base': 20, 'stride': 0, 'maxExtra': 0, **({'retiredSizes': retired[t]} if t in retired else {})}
                for i, t in enumerate(types)]

    def account(self, i, size, address='a'):
        return {'address': address, 'data': list(bytes([i] * 8) + bytes(size - 8))}

    @staticmethod
    def decodes(*ok):
        return lambda items: {addr for _, addr, _ in items if addr in ok}

    def test_live_per_user_type_at_wrong_size_fails(self):
        layouts = self.layouts('PositionState')
        for size in (12, 40):
            rows, failures, legacy = preflight.summarize([self.account(0, size, 'p')], layouts, self.decodes())
            self.assertEqual([(f['type'], f['size']) for f in failures], [('PositionState', size)])
            self.assertEqual(legacy, [])

    def test_padded_account_passes_only_when_the_program_decodes_it(self):
        layouts = self.layouts('TesoroAccount')
        padded = [self.account(0, 32, 'padded'), self.account(0, 32, 'garbage')]
        rows, failures, legacy = preflight.summarize(padded, layouts, self.decodes('padded'))
        self.assertEqual([f['address'] for f in failures], ['garbage'])
        self.assertEqual(legacy, [])
        self.assertIn('ok, decodes at this size', [r['verdict'] for r in rows])
        _, failures, _ = preflight.summarize(padded, layouts)
        self.assertEqual(len(failures), 2)

    def test_removed_type_is_skipped(self):
        rows, failures, legacy = preflight.summarize([self.account(9, 90)], self.layouts('SourceState'))
        self.assertEqual(failures, [])
        self.assertEqual(legacy[0]['count'], 1)
        self.assertTrue(legacy[0]['type'].startswith('unknown:'))

    def test_only_exact_retire_lengths_are_skipped(self):
        layouts = self.layouts('MatchState', MatchState=[12])
        rows, failures, legacy = preflight.summarize([self.account(0, 12, 'old'), self.account(0, 13, 'other'), self.account(0, 20, 'ok')], layouts, self.decodes())
        self.assertEqual([f['address'] for f in failures], ['other'])
        self.assertEqual({v['type']: v['count'] for v in legacy}, {'MatchState': 1})

    def test_the_real_178_byte_custody_fails_against_327(self):
        layouts = [{'type': 'NativeCustody', 'discriminator': list(range(8)), 'base': 327, 'stride': 0, 'maxExtra': 0}]
        _, failures, _ = preflight.summarize([{'address': 'c', 'data': list(bytes(range(8)) + bytes(170))}], layouts, self.decodes())
        self.assertEqual([(f['type'], f['size']) for f in failures], [('NativeCustody', 178)])

    def test_shorter_config_passes_when_it_decodes(self):
        layouts = [{'type': 'Config', 'discriminator': list(range(8)), 'base': 970, 'stride': 0, 'maxExtra': 0}]
        short = {'address': 'c', 'data': list(bytes(range(8)) + bytes(929))}
        self.assertEqual(preflight.summarize([short], layouts, self.decodes('c'))[1], [])
        self.assertEqual(len(preflight.summarize([short], layouts, self.decodes())[1]), 1)

    def test_variable_types_never_pass_on_decode_alone(self):
        layout = [{'type': 'BasketHead', 'discriminator': [0] * 8, 'base': 136, 'stride': 144, 'maxExtra': 2}]
        _, failures, _ = preflight.summarize([self.account(0, 281, 'v')], layout, self.decodes('v'))
        self.assertEqual(len(failures), 1)

    def test_every_probe_type_is_declared_in_the_rust_probe(self):
        import re
        for name in preflight.PROGRAMS:
            probe = (preflight.program_dir(name) / 'src/predeploy_layouts.rs').read_text()
            src = ''.join(p.read_text() for p in (preflight.program_dir(name) / 'src').rglob('*.rs'))
            for typ in re.findall(r'#\[account(?:\([^\]]*\))?\]\s*(?:#\[[^\]]+\]\s*)*pub struct (\w+)', src):
                self.assertIn(f'"{typ}"', probe, f'{name}.{typ} missing from predeploy_layouts.rs')

    def test_every_program_probe_can_decode_records(self):
        for name in preflight.PROGRAMS:
            probe = (preflight.program_dir(name) / 'src/predeploy_layouts.rs').read_text()
            self.assertIn('probe::decode_report();', probe, f'{name} probe has no decode step')


if __name__ == '__main__':
    unittest.main()
