//! 256-bit unsigned arithmetic for the bookkeeping: just what a multiply-divide needs.
//!
//! No allocation, no recursion, nothing larger than a few `u128` on the stack. A `U256` is four
//! little-endian `u64` limbs. Everything here is exact; rounding is always the caller's choice
//! (`mul_div_u128`, `mul_div_wide` take an explicit direction).

use core::cmp::Ordering;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct U256(pub [u64; 4]);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Round {
    Down,
    Up,
}

impl U256 {
    pub const ZERO: U256 = U256([0; 4]);

    pub fn from_u128(v: u128) -> U256 {
        U256([v as u64, (v >> 64) as u64, 0, 0])
    }

    pub fn is_zero(&self) -> bool {
        self.0 == [0; 4]
    }

    /// The value as a `u128` if it fits.
    pub fn to_u128(&self) -> Option<u128> {
        if self.0[2] != 0 || self.0[3] != 0 {
            return None;
        }
        Some(self.0[0] as u128 | (self.0[1] as u128) << 64)
    }

    /// The full 256-bit product of two `u128`.
    pub fn mul_wide(a: u128, b: u128) -> U256 {
        let (a0, a1) = (a as u64 as u128, a >> 64);
        let (b0, b1) = (b as u64 as u128, b >> 64);
        let p00 = a0 * b0;
        let p01 = a0 * b1;
        let p10 = a1 * b0;
        let p11 = a1 * b1;
        // limb 0
        let l0 = p00 as u64;
        // limb 1: carry of p00 + low halves of the cross products
        let mid = (p00 >> 64) + (p01 as u64 as u128) + (p10 as u64 as u128);
        let l1 = mid as u64;
        // limb 2: carry of mid + high halves of the cross products + low half of p11
        let hi = (mid >> 64) + (p01 >> 64) + (p10 >> 64) + (p11 as u64 as u128);
        let l2 = hi as u64;
        let l3 = ((hi >> 64) + (p11 >> 64)) as u64;
        U256([l0, l1, l2, l3])
    }

    /// `self + 1`, `None` on overflow.
    pub fn checked_inc(&self) -> Option<U256> {
        let mut r = self.0;
        for limb in r.iter_mut() {
            let (v, carry) = limb.overflowing_add(1);
            *limb = v;
            if !carry {
                return Some(U256(r));
            }
        }
        None
    }

    /// `self << bits`, `None` if any set bit would be lost.
    pub fn checked_shl(&self, bits: u32) -> Option<U256> {
        if bits == 0 || self.is_zero() {
            return Some(*self);
        }
        if bits >= 256 {
            return None;
        }
        if self.leading_zeros() < bits {
            return None;
        }
        let limbs = (bits / 64) as usize;
        let rem = bits % 64;
        let mut out = [0u64; 4];
        for i in (0..4).rev() {
            if i < limbs {
                continue;
            }
            let src = i - limbs;
            let mut v = self.0[src] << rem;
            if rem != 0 && src > 0 {
                v |= self.0[src - 1] >> (64 - rem);
            }
            out[i] = v;
        }
        Some(U256(out))
    }

    /// `ceil(self / 2^bits)` or `floor` by `round`.
    pub fn shr(&self, bits: u32, round: Round) -> U256 {
        if bits == 0 {
            return *self;
        }
        if bits >= 256 {
            return if round == Round::Up && !self.is_zero() {
                U256([1, 0, 0, 0])
            } else {
                U256::ZERO
            };
        }
        let limbs = (bits / 64) as usize;
        let rem = bits % 64;
        let mut out = [0u64; 4];
        let mut lost = false;
        for i in 0..limbs {
            if self.0[i] != 0 {
                lost = true;
            }
        }
        for (i, slot) in out.iter_mut().enumerate() {
            let src = i + limbs;
            if src >= 4 {
                break;
            }
            let mut v = self.0[src] >> rem;
            if rem != 0 && src + 1 < 4 {
                v |= self.0[src + 1] << (64 - rem);
            }
            *slot = v;
        }
        if rem != 0 && (self.0[limbs] & ((1u64 << rem) - 1)) != 0 {
            lost = true;
        }
        let out = U256(out);
        if round == Round::Up && lost {
            // out < 2^256 / 2^bits, so adding one cannot overflow
            return out.checked_inc().unwrap_or(out);
        }
        out
    }

    pub fn leading_zeros(&self) -> u32 {
        let mut z = 0;
        for limb in self.0.iter().rev() {
            if *limb == 0 {
                z += 64;
            } else {
                return z + limb.leading_zeros();
            }
        }
        z
    }

    /// Quotient and remainder of `self / d`. `d` must not be zero.
    pub fn div_rem(&self, d: u128) -> (U256, u128) {
        let (q, r) = div_rem_limbs(&self.0, d);
        (U256(q), r)
    }

    pub fn checked_add(&self, o: &U256) -> Option<U256> {
        let mut out = [0u64; 4];
        let mut carry = false;
        for (i, slot) in out.iter_mut().enumerate() {
            let (v1, c1) = self.0[i].overflowing_add(o.0[i]);
            let (v2, c2) = v1.overflowing_add(carry as u64);
            *slot = v2;
            carry = c1 || c2;
        }
        (!carry).then_some(U256(out))
    }

    /// `self - o`, `None` if `o` is larger.
    pub fn checked_sub(&self, o: &U256) -> Option<U256> {
        let mut out = [0u64; 4];
        let mut borrow = false;
        for (i, slot) in out.iter_mut().enumerate() {
            let (v1, b1) = self.0[i].overflowing_sub(o.0[i]);
            let (v2, b2) = v1.overflowing_sub(borrow as u64);
            *slot = v2;
            borrow = b1 || b2;
        }
        (!borrow).then_some(U256(out))
    }

    pub fn to_le_bytes(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, limb) in self.0.iter().enumerate() {
            out[i * 8..i * 8 + 8].copy_from_slice(&limb.to_le_bytes());
        }
        out
    }

    pub fn from_le_bytes(b: &[u8; 32]) -> U256 {
        let mut limbs = [0u64; 4];
        for (i, limb) in limbs.iter_mut().enumerate() {
            let mut w = [0u8; 8];
            w.copy_from_slice(&b[i * 8..i * 8 + 8]);
            *limb = u64::from_le_bytes(w);
        }
        U256(limbs)
    }

    pub fn cmp_wide(&self, other: &U256) -> Ordering {
        for i in (0..4).rev() {
            match self.0[i].cmp(&other.0[i]) {
                Ordering::Equal => continue,
                o => return o,
            }
        }
        Ordering::Equal
    }
}

impl PartialOrd for U256 {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for U256 {
    fn cmp(&self, other: &Self) -> Ordering {
        self.cmp_wide(other)
    }
}

/// `a * b / d` with a 256-bit intermediate, rounded by `round`. `None` if `d == 0` or the result
/// does not fit 128 bits.
pub fn mul_div_u128(a: u128, b: u128, d: u128, round: Round) -> Option<u128> {
    mul_div_wide(a, b, d, round)?.to_u128()
}

/// Like [`mul_div_u128`] but the quotient may use up to 256 bits.
pub fn mul_div_wide(a: u128, b: u128, d: u128, round: Round) -> Option<U256> {
    if d == 0 {
        return None;
    }
    let (q, r) = U256::mul_wide(a, b).div_rem(d);
    if round == Round::Up && r != 0 {
        return q.checked_inc();
    }
    Some(q)
}

/// Quotient and remainder of a little-endian limb number divided by a non-zero `u128`
/// (Knuth algorithm D, no allocation). `N` is at most 7.
pub fn div_rem_limbs<const N: usize>(n: &[u64; N], d: u128) -> ([u64; N], u128) {
    debug_assert!(d != 0 && N <= 7);
    let len = N - n.iter().rev().take_while(|l| **l == 0).count();
    let mut q = [0u64; N];
    if len <= 2 {
        let lo = if N > 0 { n[0] as u128 } else { 0 };
        let hi = if N > 1 { (n[1] as u128) << 64 } else { 0 };
        let v = lo | hi;
        let (qv, rv) = (v / d, v % d);
        if N > 0 {
            q[0] = qv as u64;
        }
        if N > 1 {
            q[1] = (qv >> 64) as u64;
        }
        return (q, rv);
    }
    if d <= u64::MAX as u128 {
        let mut rem: u128 = 0;
        for i in (0..len).rev() {
            let cur = (rem << 64) | n[i] as u128;
            if cur >= d {
                q[i] = (cur / d) as u64;
                rem = cur % d;
            } else {
                rem = cur;
            }
        }
        return (q, rem);
    }
    // Knuth algorithm D with a two-limb divisor.
    let shift = ((d >> 64) as u64).leading_zeros();
    let v = d << shift;
    let (v0, v1) = (v as u64 as u128, (v >> 64) as u64 as u128);
    let mut un = [0u64; 8];
    if shift == 0 {
        un[..N].copy_from_slice(n);
    } else {
        un[N] = n[N - 1] >> (64 - shift);
        for i in (1..N).rev() {
            un[i] = (n[i] << shift) | (n[i - 1] >> (64 - shift));
        }
        un[0] = n[0] << shift;
    }
    for j in (0..=len - 2).rev() {
        let num = ((un[j + 2] as u128) << 64) | un[j + 1] as u128;
        let mut qhat = num / v1;
        let mut rhat = num % v1;
        while qhat >> 64 != 0 || qhat * v0 > ((rhat << 64) | un[j] as u128) {
            qhat -= 1;
            rhat += v1;
            if rhat >> 64 != 0 {
                break;
            }
        }
        let mut borrow: i128 = 0;
        let mut carry: u128 = 0;
        let prods = [qhat * v0, qhat * v1];
        for (i, prod) in prods.iter().enumerate() {
            let p = prod + carry;
            carry = p >> 64;
            let t = un[i + j] as i128 - borrow - (p as u64 as i128);
            un[i + j] = t as u64;
            borrow = if t < 0 { 1 } else { 0 };
        }
        let t = un[j + 2] as i128 - borrow - carry as i128;
        un[j + 2] = t as u64;
        if t < 0 {
            qhat -= 1;
            let mut c: u128 = 0;
            for (i, vi) in [v0, v1].iter().enumerate() {
                let s = un[i + j] as u128 + vi + c;
                un[i + j] = s as u64;
                c = s >> 64;
            }
            un[j + 2] = un[j + 2].wrapping_add(c as u64);
        }
        q[j] = qhat as u64;
    }
    debug_assert_eq!(un[2], 0);
    let r = (((un[1] as u128) << 64) | un[0] as u128) >> shift;
    (q, r)
}

/// `a * b` for a `u128` and a 256-bit number: six limbs.
pub fn mul_u128_u256(a: u128, b: &U256) -> [u64; 6] {
    let al = [a as u64, (a >> 64) as u64];
    let mut out = [0u64; 6];
    for (i, ai) in al.iter().enumerate() {
        let mut carry: u128 = 0;
        for j in 0..4 {
            let t = (*ai as u128) * (b.0[j] as u128) + out[i + j] as u128 + carry;
            out[i + j] = t as u64;
            carry = t >> 64;
        }
        out[i + 4] = carry as u64;
    }
    out
}

/// `floor(n / 2^bits)`, or rounded up, over `N` limbs.
pub fn shr_limbs<const N: usize>(n: &[u64; N], bits: u32, round: Round) -> [u64; N] {
    let total = N as u32 * 64;
    if bits == 0 {
        return *n;
    }
    let nonzero = n.iter().any(|l| *l != 0);
    if bits >= total {
        let mut out = [0u64; N];
        if round == Round::Up && nonzero {
            out[0] = 1;
        }
        return out;
    }
    let limbs = (bits / 64) as usize;
    let rem = bits % 64;
    let mut out = [0u64; N];
    let mut lost = n[..limbs].iter().any(|l| *l != 0);
    for (i, slot) in out.iter_mut().enumerate() {
        let src = i + limbs;
        if src >= N {
            break;
        }
        let mut v = n[src] >> rem;
        if rem != 0 && src + 1 < N {
            v |= n[src + 1] << (64 - rem);
        }
        *slot = v;
    }
    if rem != 0 && (n[limbs] & ((1u64 << rem) - 1)) != 0 {
        lost = true;
    }
    if round == Round::Up && lost {
        for limb in out.iter_mut() {
            let (v, c) = limb.overflowing_add(1);
            *limb = v;
            if !c {
                break;
            }
        }
    }
    out
}

/// The value as a `u128` if the limbs above the second are zero.
pub fn limbs_to_u128<const N: usize>(n: &[u64; N]) -> Option<u128> {
    if n.iter().skip(2).any(|l| *l != 0) {
        return None;
    }
    let lo = if N > 0 { n[0] as u128 } else { 0 };
    let hi = if N > 1 { (n[1] as u128) << 64 } else { 0 };
    Some(lo | hi)
}

/// The value as a 256-bit number if the limbs above the fourth are zero.
pub fn limbs_to_u256<const N: usize>(n: &[u64; N]) -> Option<U256> {
    if n.iter().skip(4).any(|l| *l != 0) {
        return None;
    }
    let mut out = [0u64; 4];
    for (i, l) in n.iter().take(4).enumerate() {
        out[i] = *l;
    }
    Some(U256(out))
}
