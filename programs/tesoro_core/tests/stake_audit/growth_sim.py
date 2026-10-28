#!/usr/bin/env python3
"""Ticket 55 (SOL-02 A): what the Treasury tops up at Unlock, today and under the growth-only rule.

Independent of the Rust code: every landing is priced on its own (its yield in lamports at the
rate it landed), the way a holder's claim is fixed in shares. Figures are whole staking-token
units (1e-9 jitoSOL); rates are lamports per token. Run: python3 growth_sim.py
"""
from fractions import Fraction as F
from math import ceil, floor

SOL = 10**9
OPEN = F(120, 100)


def acc(p, open_, r):
    """Accrued Yield at rate r, lamports, floored like accrued_yield_at."""
    return floor(p * (F(r) / open_ - 1)) if r > open_ else 0


def unlock(custody, p, landings, r, open_=OPEN, fee_bps=0, free=0, spendable=10**18):
    """landings: [(lamports, rate, paid)] each priced at its own rate. Returns a dict."""
    shares = [F(u) / F(rr) for u, rr, _ in landings]
    paid = sum(floor(s) for s, (_, _, pd) in zip(shares, landings) if pd)
    held = sum(s for s, (_, _, pd) in zip(shares, landings) if not pd)
    owed = floor(held)
    free_fee = free * fee_bps // 10_000
    free_after = free - free_fee
    rest = custody - paid - owed
    above = F(r) > open_
    due = ceil(F(p) / (F(r) if above else open_)) + free_after
    d = max(0, due - rest)
    today = min(d, spendable) if above else 0
    high = max([rr for _, rr, _ in landings] + [open_])
    y = acc(p, open_, high)
    s_all = floor(held + free) + paid
    g = s_all - free_fee - ceil(F(y) / F(r))
    new = min(d, max(0, g)) if above else 0
    # What each landing really grew since it was priced (positive parts only).
    true_growth = sum(max(F(0), s - F(u) / F(r)) for s, (u, _, _) in zip(shares, landings))
    return dict(rest=rest, d=d, today=today, new=new, g=g, true_growth=float(true_growth),
                release_new=rest + new, release_today=rest + today)


def show(name, **kw):
    out = unlock(**kw)
    print(f"{name}: " + ", ".join(f"{k}={v}" for k, v in out.items()))
    return out


P = 12 * SOL
C = 10 * SOL
# Ana's 12-month Advance (1.2 SOL) redeemed in full at 1.32.
for r in ["1.25", "1.19", "1.40", "1.2001", "1.1999", "1.32"]:
    show(f"one landing paid at 1.32, unlock {r}", custody=C, p=P,
         landings=[(12 * SOL // 10, F("1.32"), True)], r=F(r))
# 6-month Advance (0.6 SOL) redeemed at 1.26, Unlock 1.22.
show("6-month paid at 1.26, unlock 1.22", custody=C, p=P,
     landings=[(6 * SOL // 10, F("1.26"), True)], r=F("1.22"))
# Two landings held by holders: 0.6 SOL at 1.26, 0.6 SOL at 1.32.
for r in ["1.32", "1.30", "1.26", "1.25", "1.19"]:
    show(f"two landings held, unlock {r}", custody=C, p=P,
         landings=[(6 * SOL // 10, F("1.26"), False), (6 * SOL // 10, F("1.32"), False)], r=F(r))
# Codex: 20% ceiling, 2.4 SOL at 1.44 then 2.4 SOL at 1.68, Unlock 1.55.
out = show("codex 1.44/1.68 unlock 1.55", custody=C, p=P,
           landings=[(24 * SOL // 10, F("1.44"), False), (24 * SOL // 10, F("1.68"), False)],
           r=F("1.55"))
first = F(24 * SOL // 10) * (F(1) / F("1.44") - F(1) / F("1.55"))
print(f"codex first landing's growth borne by Ana: {floor(first)} units = "
      f"{float(first * F('1.55') / SOL):.4f} SOL = {float(first * F('1.55') / P) * 100:.3f}% of P")
