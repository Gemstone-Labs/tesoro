//! The Match's setup, as pure functions: nothing here touches an account.
//!
//! A Match's seed is a hash of everything that makes the Match unique and everything both Players and the oracle
//! contributed:
//!
//! * the table, the Match, the table epoch and the request number, so no two Matches ever share a seed, on one table
//!   or across tables;
//! * both Players' frozen secrets (each kept only in that Player's own Army), so the oracle alone cannot steer the
//!   layouts;
//! * both halves of the VRF output (one stored in each Army), so neither Player nor the keeper can steer the layouts
//!   once the secrets are frozen;
//! * a 32-byte `ext_entropy` slot per Army, zero today, for an entropy source that does not appear in public
//!   history if MagicBlock ever offers one.
//!
//! The seed exists only inside `deal`. The storm's turn and line are stored as two XOR shares, one in each Army.

use anchor_lang::{prelude::Pubkey, solana_program::hash::hashv};

const DOMAIN: &[u8] = b"tesoro/vanguard/v2";

/// Everything a Match's seed and VRF request are derived from.
#[derive(Clone, Copy, Debug)]
pub struct SetupContext {
    pub tesoro_match: Pubkey,
    pub generation: u16,
    pub index: u16,
    pub epoch: u64,
    pub nonce: u64,
}

impl SetupContext {
    fn binding(&self) -> [u8; 32 + 2 + 2 + 8 + 8] {
        let mut out = [0u8; 52];
        out[..32].copy_from_slice(self.tesoro_match.as_ref());
        out[32..34].copy_from_slice(&self.generation.to_le_bytes());
        out[34..36].copy_from_slice(&self.index.to_le_bytes());
        out[36..44].copy_from_slice(&self.epoch.to_le_bytes());
        out[44..52].copy_from_slice(&self.nonce.to_le_bytes());
        out
    }
}

pub fn secret_hash(secret: &[u8; 32]) -> [u8; 32] {
    hashv(&[DOMAIN, b"secret-hash", secret]).to_bytes()
}

/// The VRF `caller_seed` of a Match: chosen by the program, never by a caller. It binds the request to the table, the
/// Match, the epoch, the request number and the hashes of both frozen secrets.
pub fn request_seed(ctx: &SetupContext, secret_hashes: &[[u8; 32]; 2]) -> [u8; 32] {
    hashv(&[
        DOMAIN,
        b"request",
        &ctx.binding(),
        &secret_hashes[0],
        &secret_hashes[1],
    ])
    .to_bytes()
}

/// The half of the oracle's output kept in seat `seat`. Neither half alone reveals the output.
pub fn vrf_half(seat: u8, randomness: &[u8; 32], nonce: u64) -> [u8; 32] {
    hashv(&[DOMAIN, b"half", &[seat], &nonce.to_le_bytes(), randomness]).to_bytes()
}

/// What `deal` reads from the two Armies.
#[derive(Clone, Copy, Debug)]
pub struct Contributions {
    pub secrets: [[u8; 32]; 2],
    pub halves: [[u8; 32]; 2],
    pub ext: [[u8; 32]; 2],
}

/// The Match's seed. The order of the two seats is fixed, so it does not matter who contributed first.
pub fn derive_seed(ctx: &SetupContext, c: &Contributions) -> [u8; 32] {
    hashv(&[
        DOMAIN,
        b"seed",
        &ctx.binding(),
        &c.secrets[0],
        &c.secrets[1],
        &c.halves[0],
        &c.halves[1],
        &c.ext[0],
        &c.ext[1],
    ])
    .to_bytes()
}

/// The two Armies' XOR shares of the storm's turn and line seed: seat 0 gets a pseudo-random mask, seat 1 gets the
/// value XOR that mask. Each share alone is uniform over its whole width and says nothing about the value. The
/// shares are given per seat.
pub fn storm_shares(seed: &[u8; 32], storm_at: u16, storm_seed: u32) -> [(u16, u32); 2] {
    let pad = hashv(&[DOMAIN, b"storm-share", seed]).to_bytes();
    let mask_at = u16::from_le_bytes([pad[0], pad[1]]);
    let mask_seed = u32::from_le_bytes([pad[2], pad[3], pad[4], pad[5]]);
    [
        (mask_at, mask_seed),
        (storm_at ^ mask_at, storm_seed ^ mask_seed),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(nonce: u64) -> SetupContext {
        SetupContext {
            tesoro_match: Pubkey::new_from_array([3; 32]),
            generation: 1,
            index: 2,
            epoch: 4,
            nonce,
        }
    }

    fn contributions(n: u8) -> Contributions {
        Contributions {
            secrets: [[n; 32], [n.wrapping_add(1); 32]],
            halves: [[n.wrapping_add(2); 32], [n.wrapping_add(3); 32]],
            ext: [[0; 32]; 2],
        }
    }

    #[test]
    fn every_input_changes_the_seed() {
        let base = derive_seed(&ctx(0), &contributions(1));
        let mut seeds = vec![base];
        seeds.push(derive_seed(&ctx(1), &contributions(1)));
        let mut other = ctx(0);
        other.epoch += 1;
        seeds.push(derive_seed(&other, &contributions(1)));
        other = ctx(0);
        other.tesoro_match = Pubkey::new_from_array([4; 32]);
        seeds.push(derive_seed(&other, &contributions(1)));
        other = ctx(0);
        other.index += 1;
        seeds.push(derive_seed(&other, &contributions(1)));
        for (i, change) in [
            |c: &mut Contributions| c.secrets[0][0] ^= 1,
            |c: &mut Contributions| c.secrets[1][0] ^= 1,
            |c: &mut Contributions| c.halves[0][0] ^= 1,
            |c: &mut Contributions| c.halves[1][0] ^= 1,
            |c: &mut Contributions| c.ext[0][0] ^= 1,
            |c: &mut Contributions| c.ext[1][0] ^= 1,
        ]
        .into_iter()
        .enumerate()
        {
            let mut c = contributions(1);
            change(&mut c);
            seeds.push(derive_seed(&ctx(0), &c));
            assert_ne!(seeds[seeds.len() - 1], base, "input {i}");
        }
        for (i, a) in seeds.iter().enumerate() {
            for b in &seeds[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn the_request_binds_the_match_the_epoch_the_nonce_and_both_secrets() {
        let h = [secret_hash(&[1; 32]), secret_hash(&[2; 32])];
        let base = request_seed(&ctx(0), &h);
        assert_ne!(base, request_seed(&ctx(1), &h));
        assert_ne!(base, request_seed(&ctx(0), &[h[1], h[0]]));
        let mut e = ctx(0);
        e.epoch = 5;
        assert_ne!(base, request_seed(&e, &h));
    }

    #[test]
    fn the_halves_differ_by_seat_and_by_request() {
        let r = [9u8; 32];
        assert_ne!(vrf_half(0, &r, 0), vrf_half(1, &r, 0));
        assert_ne!(vrf_half(0, &r, 0), vrf_half(0, &r, 1));
        assert_ne!(vrf_half(0, &r, 0), r);
    }

    #[test]
    fn the_storm_shares_combine_to_the_value_and_each_alone_is_not_it() {
        for n in 0..200u32 {
            let seed = hashv(&[b"seed", &n.to_le_bytes()]).to_bytes();
            let (at, line) = (50 + (n % 70) as u16, n.wrapping_mul(2_654_435_761));
            let [s0, s1] = storm_shares(&seed, at, line);
            assert_eq!((s0.0 ^ s1.0, s0.1 ^ s1.1), (at, line));
        }
    }

    /// Each share, over many seeds and for one fixed storm value, is uniform: a chi-square over the low byte of the
    /// line share and over sixteen buckets of the turn share (the high bits matter too: the mask covers the whole
    /// width).
    #[test]
    fn one_share_is_uniform_whatever_the_storm_is() {
        const N: u32 = 51_200;
        let mut bytes = [0u32; 256];
        let mut high = [0u32; 16];
        let mut at_buckets = [0u32; 16];
        for n in 0..N {
            let seed = hashv(&[b"uniform", &n.to_le_bytes()]).to_bytes();
            let [s0, _] = storm_shares(&seed, 99, 0xDEAD_BEEF);
            bytes[(s0.1 & 0xFF) as usize] += 1;
            high[(s0.1 >> 28) as usize] += 1;
            at_buckets[(s0.0 >> 12) as usize] += 1;
            assert_ne!((s0.0, s0.1), (99, 0xDEAD_BEEF));
        }
        let chi = |counts: &[u32], total: u32| {
            let expect = f64::from(total) / counts.len() as f64;
            counts
                .iter()
                .map(|c| (f64::from(*c) - expect).powi(2) / expect)
                .sum::<f64>()
        };
        // 255 dof: p = 0.001 is about 330; 15 dof: about 37.7
        assert!(
            chi(&bytes, N) < 330.0,
            "line share low byte {}",
            chi(&bytes, N)
        );
        assert!(
            chi(&high, N) < 37.7,
            "line share high nibble {}",
            chi(&high, N)
        );
        assert!(
            chi(&at_buckets, N) < 37.7,
            "turn share high nibble {}",
            chi(&at_buckets, N)
        );
    }

    #[test]
    fn the_second_share_is_uniform_too() {
        const N: u32 = 51_200;
        let mut bytes = [0u32; 256];
        for n in 0..N {
            let seed = hashv(&[b"second", &n.to_le_bytes()]).to_bytes();
            let [_, s1] = storm_shares(&seed, 99, 12_345);
            bytes[(s1.1 & 0xFF) as usize] += 1;
        }
        let expect = f64::from(N) / 256.0;
        let chi: f64 = bytes
            .iter()
            .map(|c| (f64::from(*c) - expect).powi(2) / expect)
            .sum();
        assert!(chi < 330.0, "second share {chi}");
    }
}
