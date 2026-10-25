#!/usr/bin/env python3
"""Read-only, fail-closed layout preflight. Rust probes supply SPACE; no hand-copied account lengths.

collect must follow the SBF build (build-programs.sh invokes it). A manifest binds Rust inputs,
IDL and built ELF. check scans every owned account, including unknown/old discriminators.
No migration is performed or silently exempted. Delegated accounts need a separate rollup snapshot.
"""
import argparse
import base64
import hashlib
import json
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


def summarize(accounts, layouts):
    groups = {}
    failures = []
    for a in accounts:
        data = bytes(a['data']) if isinstance(a['data'], list) else base64.b64decode(a['data'], validate=True)
        typ, expected, verdict = classify(data, layouts)
        key = (typ, expected, verdict)
        group = groups.setdefault(key, {'type': typ, 'count': 0, 'sizes': set(), 'expected': expected, 'verdict': verdict})
        group['count'] += 1
        group['sizes'].add(len(data))
        if verdict != 'ok':
            failures.append({'address': a['address'], 'type': typ, 'size': len(data), 'verdict': verdict})
    return [{**v, 'sizes': sorted(v['sizes'])} for v in groups.values()], failures


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
              'delegatedAccounts': 'NOT VERIFIED: scan separately on the rollup before any upgrade', 'programs': []}
    failed = inventory
    for m in manifests:
        result = rpc(url, 'getProgramAccounts', [m['programId'], {'encoding': 'base64', 'commitment': 'finalized', 'withContext': True}])
        accounts = [{'address': a['pubkey'], 'data': a['account']['data'][0]} for a in result['value']]
        rows, failures = summarize(accounts, m['layouts'])
        report['programs'].append({'program': m['program'], 'programId': m['programId'], 'slot': result['context']['slot'],
                                   'elfHash': m['elfHash'], 'rows': rows, 'failures': failures})
        print(f'\n{m["program"]}: {len(accounts)} accounts at finalized slot {result["context"]["slot"]}')
        print('type | count | sizes seen | expected | verdict')
        for row in rows:
            print(' | '.join(str(row[k]) for k in ('type', 'count', 'sizes', 'expected', 'verdict')))
        failed |= bool(failures)
    report['sizeVerdict'] = 'FAIL' if failed else 'PASS'
    Path(out).write_text(json.dumps(report, indent=2) + '\n')
    print(f'\n{report["sizeVerdict"]}: size guard only; delegated state and semantic upgrade prerequisites remain separate.')
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
