#!/usr/bin/env python3
"""Read-only, fail-closed layout preflight. Rust probes supply SPACE; no hand-copied account lengths.

Devnet state is disposable (founder, 2026-10-25). The guard SKIPS only records the current code
provably never decodes: an unknown discriminator (a type the current IDL no longer has), and the
exact lengths only the admin retire instructions handle (probe `retiredSizes`). Every other record
of a type the current program reads must be the size the layout decodes: a wrong size passes only
when the program's own deserializer, run on the real bytes (the Rust probe, TESORO_DECODE_INPUT),
decodes it (legitimate padding or a shorter Config). Anything else FAILS, whether it is a
singleton or a per-user record. The 178 B native custody against 327 B fails because it does not decode.

collect must follow the SBF build (build-programs.sh invokes it). A manifest binds Rust inputs,
IDL and built ELF. check scans every owned account, including unknown/old discriminators.
No migration is performed. Delegated rollup accounts are not scanned.
"""
import argparse
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PROGRAMS = ('tesoro_core', 'sim_lst', 'block_puzzle', 'holdem', 'trading_duel', 'vanguard', 'tesoro_bridge')



def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def program_dir(name):
    return ROOT / ('bridge/programs' if name == 'tesoro_bridge' else 'programs') / name


def inputs():
    paths = set(ROOT.glob('programs/*/src/**/*.rs')) | set(ROOT.glob('crates/*/src/**/*.rs')) | set(ROOT.glob('bridge/programs/*/src/**/*.rs'))
    paths |= set(ROOT.glob('programs/*/Cargo.toml')) | set(ROOT.glob('crates/*/Cargo.toml')) | set(ROOT.glob('bridge/programs/*/Cargo.toml'))
    paths |= {ROOT / p for p in ('Cargo.toml', 'Cargo.lock', 'bridge/Cargo.toml', 'bridge/Cargo.lock', 'scripts/predeploy-probe.rs')}
    return sorted(p for p in paths if p.is_file())


def fingerprint():
    h = hashlib.sha256()
    for p in inputs():
        h.update(str(p.relative_to(ROOT)).encode() + b'\0' + p.read_bytes() + b'\0')
    return h.hexdigest()


def artifact_paths(name):
    target = ROOT / ('bridge/target' if name == 'tesoro_bridge' else 'target')
    return target / 'deploy' / (name + '.so'), target / 'idl' / (name + '.json')


def collect(name, metadata_only=False):
    so, idl = artifact_paths(name)
    if not metadata_only:
        if not so.is_file() or so.stat().st_mtime < max(p.stat().st_mtime for p in inputs()):
            raise ValueError(f'{name}: rebuild SBF after the layout probe/source changes before sealing')
    before = fingerprint()
    cargo = ['cargo', 'test', '--locked']
    if name == 'tesoro_bridge':
        cargo += ['--manifest-path', str(ROOT / 'bridge/Cargo.toml')]
    cargo += ['-p', name, '--lib', 'predeploy_layouts::emit_layouts', '--', '--exact', '--nocapture']
    proc = subprocess.run(cargo, cwd=ROOT, text=True, capture_output=True)
    logs = ROOT / 'target/account-layouts'
    logs.mkdir(parents=True, exist_ok=True)
    (logs / (name + '.build.log')).write_text(proc.stdout + proc.stderr)
    if proc.returncode:
        raise ValueError(f'{name}: Rust probe failed; see {logs / (name + ".build.log")}')
    rows = [json.loads(line.split('TESORO_LAYOUT ', 1)[1]) for line in proc.stdout.splitlines() if line.startswith('TESORO_LAYOUT ')]
    doc = json.loads(idl.read_text()) if idl.exists() else None
    program_id = next((line.split('TESORO_PROGRAM ', 1)[1].strip() for line in proc.stdout.splitlines() if line.startswith('TESORO_PROGRAM ')), None)
    declared = set()
    for source in (program_dir(name) / 'src').rglob('*.rs'):
        declared.update(re.findall(r'#\[account(?:\([^\]]*\))?\]\s*(?:#\[[^\]]+\]\s*)*pub struct (\w+)', source.read_text()))
    expected = {a['name']: a['discriminator'] for a in doc['accounts']} if doc else None
    actual = {r['type']: r['discriminator'] for r in rows}
    # Anchor also lists accounts owned by CPI dependencies (core's IDL includes sim_lst::Pool).
    # Conversely unchecked zero-copy accounts need not appear in its IDL. Own Rust declarations are authoritative.
    if not rows or not program_id or set(actual) != declared or (expected is not None and any(actual[n] != expected[n] for n in actual.keys() & expected.keys())):
        raise ValueError(f'{name}: probe/source/IDL account coverage differs; add every new account type to its Rust probe')
    retired = {}
    for line in proc.stdout.splitlines():
        if line.startswith('TESORO_RETIRED '):
            r = json.loads(line.split('TESORO_RETIRED ', 1)[1])
            if r['type'] not in actual:
                raise ValueError(f'{name}: retired sizes name unknown type {r["type"]}')
            retired[r['type']] = r['sizes']
    for r in rows:
        if r['type'] in retired:
            r['retiredSizes'] = retired[r['type']]
    if before != fingerprint():
        raise ValueError('Sources changed during probe; restart collection')
    if doc and doc['address'] != program_id:
        raise ValueError(f'{name}: IDL and compiled program IDs disagree')
    record = {'program': name, 'programId': program_id, 'sourceHash': before, 'sealed': not metadata_only,
              'elfHash': sha(so) if so.exists() else None, 'idlHash': sha(idl) if idl.exists() else None, 'layouts': rows}
    (logs / (name + '.json')).write_text(json.dumps(record, indent=2) + '\n')
    print(f'{name}: {len(rows)} account types; {"SEALED" if record["sealed"] else "UNSEALED (inventory only)"}')


def classify(data, layouts):
    row = next((r for r in layouts if bytes(r['discriminator']) == data[:8]), None)
    if row is None:
        return 'unknown:' + data[:8].hex(), 'unknown', "can't decode"
    base, stride, cap = row['base'], row['stride'], row['maxExtra']
    expected = str(base) if not stride else f'{base} + {stride}*n, 0<=n<={cap}'
    size_ok = len(data) == base if not stride else len(data) >= base and (len(data)-base) % stride == 0 and (len(data)-base)//stride <= cap
    if not size_ok:
        return row['type'], expected, 'needs migration'
    if any(at >= len(data) or data[at] != value for at, value in row.get('versions', [])):
        return row['type'], expected, "can't decode"
    return row['type'], expected, 'ok'


def summarize(accounts, layouts, decoder=None):
    """Returns (rows, failures, skipped). `decoder(items)` takes [(type, address, bytes)] and returns the
    set of addresses the program's own deserializer decodes; without it nothing of a wrong size passes."""
    parsed = []
    for a in accounts:
        data = bytes(a['data']) if isinstance(a['data'], list) else base64.b64decode(a['data'], validate=True)
        typ, expected, verdict = classify(data, layouts)
        row = next((r for r in layouts if r['type'] == typ), None)
        parsed.append((a['address'], data, typ, expected, verdict, row))
    candidates = [(typ, addr, data) for addr, data, typ, _, verdict, row in parsed
                  if verdict != 'ok' and row is not None and not row['stride'] and len(data) not in row.get('retiredSizes', [])
                  and bytes(row['discriminator']) == data[:8]]
    decoded = decoder(candidates) if decoder and candidates else set()
    groups = {}
    failures = []
    legacy = {}
    for addr, data, typ, expected, verdict, row in parsed:
        kind = 'current' if verdict == 'ok' else 'fail'
        if verdict != 'ok':
            if row is None:
                kind, verdict = 'legacy', 'legacy, unrecognised discriminator'
            elif len(data) in row.get('retiredSizes', []):
                kind, verdict = 'legacy', 'legacy, retired by admin instruction'
            elif addr in decoded:
                kind, verdict = 'current', 'ok, decodes at this size'
        key = (typ, expected, verdict)
        group = groups.setdefault(key, {'type': typ, 'count': 0, 'sizes': set(), 'expected': expected, 'verdict': verdict})
        group['count'] += 1
        group['sizes'].add(len(data))
        if kind == 'fail':
            failures.append({'address': addr, 'type': typ, 'size': len(data), 'verdict': verdict})
        elif kind == 'legacy':
            entry = legacy.setdefault(typ, {'type': typ, 'count': 0, 'sizes': set()})
            entry['count'] += 1
            entry['sizes'].add(len(data))
    rows = [{**v, 'sizes': sorted(v['sizes'])} for v in groups.values()]
    skipped = [{**v, 'sizes': sorted(v['sizes'])} for v in sorted(legacy.values(), key=lambda v: v['type'])]
    return rows, failures, skipped


def rust_decoder(name):
    """Runs the program's own deserializers (host probe) on the given records."""
    def run(items):
        logs = ROOT / 'target/account-layouts'
        logs.mkdir(parents=True, exist_ok=True)
        path = logs / (name + '.decode-input.tsv')
        path.write_text(''.join(f'{t}\t{a}\t{d.hex()}\n' for t, a, d in items))
        cargo = ['cargo', 'test', '--locked']
        if name == 'tesoro_bridge':
            cargo += ['--manifest-path', str(ROOT / 'bridge/Cargo.toml')]
        cargo += ['-p', name, '--lib', 'predeploy_layouts::emit_layouts', '--', '--exact', '--nocapture']
        proc = subprocess.run(cargo, cwd=ROOT, text=True, capture_output=True, env={**os.environ, 'TESORO_DECODE_INPUT': str(path)})
        if proc.returncode:
            raise ValueError(f'{name}: decode probe failed')
        out = [json.loads(line.split('TESORO_DECODE ', 1)[1]) for line in proc.stdout.splitlines() if line.startswith('TESORO_DECODE ')]
        if len(out) != len(items):
            raise ValueError(f'{name}: decode probe returned {len(out)} of {len(items)} records')
        return {r['address'] for r in out if r['ok']}
    return run


def rpc(url, method, params):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    req = urllib.request.Request(url, body, {'Content-Type': 'application/json', 'User-Agent': 'tesoro-predeploy-size-check/1.0'})
    with urllib.request.urlopen(req, timeout=90) as response:
        result = json.load(response)
    if 'error' in result:
        raise ValueError(f'RPC {method} failed: {result["error"].get("code")}')
    return result['result']


def check(names, url, out, inventory=False):
    manifests = []
    current = fingerprint()
    for name in names:
        manifest = json.loads((ROOT / 'target/account-layouts' / (name + '.json')).read_text())
        so, idl = artifact_paths(name)
        if manifest['sourceHash'] != current or manifest['idlHash'] != (sha(idl) if idl.exists() else None):
            raise ValueError(f'{name}: source/IDL changed; rebuild and collect')
        if not inventory and (not manifest['sealed'] or manifest['elfHash'] != sha(so)):
            raise ValueError(f'{name}: missing or stale build seal; rebuild before preflight')
        manifests.append(manifest)
    report = {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'rpc': url,
              'genesisHash': rpc(url, 'getGenesisHash', []), 'inventoryOnly': inventory,
              'delegatedAccounts': 'not scanned: rollup state is disposable on devnet', 'programs': []}
    failed = inventory
    for m in manifests:
        result = rpc(url, 'getProgramAccounts', [m['programId'], {'encoding': 'base64', 'commitment': 'finalized', 'withContext': True}])
        accounts = [{'address': a['pubkey'], 'data': a['account']['data'][0]} for a in result['value']]
        rows, failures, skipped = summarize(accounts, m['layouts'], rust_decoder(m['program']))
        current = sum(r['count'] for r in rows if r['verdict'].startswith('ok'))
        report['programs'].append({'program': m['program'], 'programId': m['programId'], 'slot': result['context']['slot'],
                                   'elfHash': m['elfHash'], 'current': current, 'rows': rows, 'failures': failures,
                                   'legacySkipped': skipped})
        print(f'\n{m["program"]}: {len(accounts)} accounts at finalized slot {result["context"]["slot"]}; current: {current} ok; legacy skipped: {sum(v["count"] for v in skipped)}; failures: {len(failures)}')
        print('type | count | sizes seen | expected | verdict')
        for row in rows:
            print(' | '.join(str(row[k]) for k in ('type', 'count', 'sizes', 'expected', 'verdict')))
        if skipped:
            print('legacy, skipped (unknown discriminator, or retired by admin instruction; never migrated):')
            for v in skipped:
                print(f'  {v["type"]}: {v["count"]} (sizes {v["sizes"]})')
        for f in failures:
            print(f'  FAIL {f["type"]} {f["address"]} size {f["size"]}: {f["verdict"]}')
        failed |= bool(failures)
    report['sizeVerdict'] = 'FAIL' if failed else 'PASS'
    Path(out).write_text(json.dumps(report, indent=2) + '\n')
    totals = {}
    for pr in report['programs']:
        for v in pr['legacySkipped']:
            totals[f'{pr["program"]}.{v["type"]}'] = v['count']
    print(f'\n{report["sizeVerdict"]}: current: {sum(p["current"] for p in report["programs"])} ok; legacy skipped: {totals}')
    print('Size guard only: delegated rollup accounts are not scanned (devnet state is disposable).')
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    collect_parser = sub.add_parser('collect')
    collect_parser.add_argument('--program', action='append', choices=PROGRAMS)
    collect_parser.add_argument('--metadata-only', action='store_true', help='Unsealed inventory; cannot pass deployment preflight')
    check_parser = sub.add_parser('check')
    check_parser.add_argument('--program', action='append', choices=PROGRAMS)
    check_parser.add_argument('--rpc', default='https://rpc.magicblock.app/devnet')
    check_parser.add_argument('--out', required=True)
    check_parser.add_argument('--inventory-only', action='store_true')
    args = parser.parse_args()
    names = args.program or PROGRAMS
    try:
        if args.action == 'collect':
            for name in names:
                collect(name, args.metadata_only)
            return 0
        return check(names, args.rpc, args.out, args.inventory_only)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as err:
        print(f'PRECHECK FAILED: {err}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
