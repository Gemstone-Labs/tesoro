//! The shuffle, as pure functions: nothing here touches an account.
//!
//! A hand's seed is a hash of everything that makes the hand unique and everything both Players
//! and the oracle contributed:
//!
//! * the table, the Match, the table epoch, the hand number and the request number, so no two
//!   hands ever share a seed, on one table or across Matches;
//! * both Players' frozen secrets, so the oracle alone cannot steer the cards;
//! * both halves of the VRF output (one stored in each seat), so neither Player nor the keeper can
//!   steer the cards once the secrets are frozen;
//! * a 32-byte `ext_entropy` slot per seat, zero today, for an entropy source that does not appear
//!   in public history if MagicBlock ever offers one.
//!
//! The seed exists only inside `deal`. The nine cards a hand uses are drawn by a partial
//! Fisher-Yates shuffle; the board is stored as two XOR shares, one in each seat.

use crate::state::{DECK_SIZE, USED_CARDS};
use anchor_lang::{prelude::Pubkey, solana_program::hash::hashv};

const DOMAIN: &[u8] = b"tesoro/holdem/v2";

/// Everything a hand's seed and VRF request are derived from.
#[derive(Clone, Copy, Debug)]
pub struct HandContext {
    pub tesoro_match: Pubkey,
    pub generation: u16,
    pub index: u16,
    pub epoch: u64,
    pub hand_no: u32,
    pub nonce: u64,
}

impl HandContext {
    fn binding(&self) -> [u8; 32 + 2 + 2 + 8 + 4 + 8] {
        let mut out = [0u8; 56];
        out[..32].copy_from_slice(self.tesoro_match.as_ref());
        out[32..34].copy_from_slice(&self.generation.to_le_bytes());
        out[34..36].copy_from_slice(&self.index.to_le_bytes());
        out[36..44].copy_from_slice(&self.epoch.to_le_bytes());
        out[44..48].copy_from_slice(&self.hand_no.to_le_bytes());
        out[48..56].copy_from_slice(&self.nonce.to_le_bytes());
        out
    }
}

pub fn secret_hash(secret: &[u8; 32]) -> [u8; 32] {
    hashv(&[DOMAIN, b"secret-hash", secret]).to_bytes()
}

/// The VRF `caller_seed` of a hand: chosen by the program, never by a caller. It binds the
/// request to the table, the Match, the epoch, the hand, the request number and the hashes of
/// both frozen secrets.
pub fn request_seed(ctx: &HandContext, secret_hashes: &[[u8; 32]; 2]) -> [u8; 32] {
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
    hashv(&[
        DOMAIN,
        b"half",
        &[seat],
        &nonce.to_le_bytes(),
        randomness,
    ])
    .to_bytes()
}

/// What `deal` reads from the two seats.
#[derive(Clone, Copy, Debug)]
pub struct Contributions {
    pub secrets: [[u8; 32]; 2],
    pub halves: [[u8; 32]; 2],
    pub ext: [[u8; 32]; 2],
}

/// The hand's seed. Order of the two seats is fixed, so it does not matter who contributed first.
pub fn derive_seed(ctx: &HandContext, c: &Contributions) -> [u8; 32] {
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

/// Draws the nine cards of a hand: seat 0's two, seat 1's two, then the five board cards, from a
/// partial Fisher-Yates shuffle of the 52-card deck. The deck itself is never stored.
pub fn draw_hand(seed: &[u8; 32]) -> [u8; USED_CARDS] {
    let mut deck = [0u8; DECK_SIZE];
    for (i, card) in deck.iter_mut().enumerate() {
        *card = i as u8;
    }
    for k in 0..USED_CARDS {
        let digest = hashv(&[DOMAIN, b"draw", seed, &[k as u8]]).to_bytes();
        let mut word = [0u8; 8];
        word.copy_from_slice(&digest[..8]);
        let span = (DECK_SIZE - k) as u64;
        let j = k + (u64::from_le_bytes(word) % span) as usize;
        deck.swap(k, j);
    }
    let mut out = [0u8; USED_CARDS];
    out.copy_from_slice(&deck[..USED_CARDS]);
    out
}

/// Seat 0's two cards and seat 1's two cards, and the five board cards.
pub fn split_hand(nine: &[u8; USED_CARDS]) -> ([[u8; 2]; 2], [u8; 5]) {
    let holes = [[nine[0], nine[2]], [nine[1], nine[3]]];
    let mut board = [0u8; 5];
    board.copy_from_slice(&nine[4..9]);
    (holes, board)
}

/// The two seats' XOR shares of the board: seat 0 gets a pseudo-random byte per card and seat 1
/// gets the card XOR that byte. Each share alone is uniform and says nothing about the card.
pub fn board_shares(seed: &[u8; 32], board: &[u8; 5]) -> [[u8; 5]; 2] {
    let pad = hashv(&[DOMAIN, b"share", seed]).to_bytes();
    let mut shares = [[0u8; 5]; 2];
    for k in 0..5 {
        shares[0][k] = pad[k];
        shares[1][k] = board[k] ^ pad[k];
    }
    shares
}

/// The board from the two seats' shares.
pub fn combine_shares(shares: &[[u8; 5]; 2]) -> [u8; 5] {
    let mut board = [0u8; 5];
    for (k, card) in board.iter_mut().enumerate() {
        *card = shares[0][k] ^ shares[1][k];
    }
    board
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(epoch: u64, hand: u32, nonce: u64) -> HandContext {
        HandContext {
            tesoro_match: Pubkey::new_from_array([7; 32]),
            generation: 0,
            index: 3,
            epoch,
            hand_no: hand,
            nonce,
        }
    }

    fn contrib(a: u8) -> Contributions {
        Contributions {
            secrets: [[a; 32], [a.wrapping_add(1); 32]],
            halves: [[a.wrapping_add(2); 32], [a.wrapping_add(3); 32]],
            ext: [[0; 32]; 2],
        }
    }

    fn seed_n(i: u32) -> [u8; 32] {
        hashv(&[b"test-seed", &i.to_le_bytes()]).to_bytes()
    }

    #[test]
    fn the_seed_depends_on_every_input() {
        let base = derive_seed(&ctx(1, 1, 1), &contrib(1));
        assert_ne!(base, derive_seed(&ctx(2, 1, 1), &contrib(1)), "epoch");
        assert_ne!(base, derive_seed(&ctx(1, 2, 1), &contrib(1)), "hand");
        assert_ne!(base, derive_seed(&ctx(1, 1, 2), &contrib(1)), "request number");
        assert_ne!(base, derive_seed(&ctx(1, 1, 1), &contrib(2)), "contributions");
        let mut other_match = ctx(1, 1, 1);
        other_match.tesoro_match = Pubkey::new_from_array([8; 32]);
        assert_ne!(base, derive_seed(&other_match, &contrib(1)), "match");
        let mut ext = contrib(1);
        ext.ext[1][0] = 1;
        assert_ne!(base, derive_seed(&ctx(1, 1, 1), &ext), "ext_entropy");
        assert_eq!(base, derive_seed(&ctx(1, 1, 1), &contrib(1)), "deterministic");
    }

    #[test]
    fn the_request_seed_binds_the_hand_and_both_frozen_secrets() {
        let h = [[1u8; 32], [2u8; 32]];
        let base = request_seed(&ctx(1, 1, 1), &h);
        assert_ne!(base, request_seed(&ctx(2, 1, 1), &h));
        assert_ne!(base, request_seed(&ctx(1, 2, 1), &h));
        assert_ne!(base, request_seed(&ctx(1, 1, 2), &h));
        assert_ne!(base, request_seed(&ctx(1, 1, 1), &[[1u8; 32], [3u8; 32]]));
        assert_ne!(base, request_seed(&ctx(1, 1, 1), &[[2u8; 32], [1u8; 32]]));
    }

    #[test]
    fn halves_differ_by_seat_and_request() {
        let r = [9u8; 32];
        assert_ne!(vrf_half(0, &r, 1), vrf_half(1, &r, 1));
        assert_ne!(vrf_half(0, &r, 1), vrf_half(0, &r, 2));
        assert_ne!(vrf_half(0, &r, 1), r);
    }

    #[test]
    fn a_hand_has_nine_distinct_cards() {
        for i in 0..2_000 {
            let nine = draw_hand(&seed_n(i));
            let mut seen = [false; DECK_SIZE];
            for c in nine {
                assert!((c as usize) < DECK_SIZE);
                assert!(!seen[c as usize], "duplicate card in hand {i}");
                seen[c as usize] = true;
            }
        }
    }

    /// Chi-square of every card position against the uniform distribution over 100,000 seeds.
    /// 51 degrees of freedom: the 0.1% critical value is 87.97, so 100 is a generous bound that a
    /// real bias (a modulo slip, a stuck position) would break by orders of magnitude.
    #[test]
    fn the_shuffle_is_uniform_over_100k_seeds() {
        const SEEDS: u32 = 100_000;
        let mut counts = [[0u32; DECK_SIZE]; USED_CARDS];
        for i in 0..SEEDS {
            let nine = draw_hand(&seed_n(i));
            for (pos, c) in nine.iter().enumerate() {
                counts[pos][*c as usize] += 1;
            }
        }
        let expected = f64::from(SEEDS) / DECK_SIZE as f64;
        for (pos, row) in counts.iter().enumerate() {
            let chi: f64 = row
                .iter()
                .map(|&n| {
                    let d = f64::from(n) - expected;
                    d * d / expected
                })
                .sum();
            assert!(chi < 100.0, "position {pos}: chi-square {chi:.1} over 51 dof");
        }
    }

    #[test]
    fn shares_recombine_and_each_share_is_uniform() {
        for i in 0..2_000 {
            let seed = seed_n(i);
            let (_, board) = split_hand(&draw_hand(&seed));
            let shares = board_shares(&seed, &board);
            assert_eq!(combine_shares(&shares), board);
        }
        // The board card is held fixed: each seat's share must still look uniform over 0..=255.
        const SEEDS: u32 = 100_000;
        let fixed = [3u8, 3, 3, 3, 3];
        for seat in 0..2 {
            let mut counts = [0u32; 256];
            for i in 0..SEEDS {
                let shares = board_shares(&seed_n(i), &fixed);
                counts[shares[seat][0] as usize] += 1;
            }
            let expected = f64::from(SEEDS) / 256.0;
            let chi: f64 = counts
                .iter()
                .map(|&n| {
                    let d = f64::from(n) - expected;
                    d * d / expected
                })
                .sum();
            // 255 dof: the 0.1% critical value is 330.5.
            assert!(chi < 360.0, "seat {seat} share: chi-square {chi:.1} over 255 dof");
        }
    }
}
