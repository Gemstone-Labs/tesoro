//! Seven-card Hold'em hand evaluator. Cards are `0..52` with `rank = card % 13` (0 = deuce,
//! 12 = ace) and `suit = card / 13`. A score is a `u32`: higher beats lower, equal scores tie.
//! Layout: category in bits 20.., then five 4-bit ranks, most significant first.

pub const HIGH_CARD: u32 = 0;
pub const PAIR: u32 = 1;
pub const TWO_PAIR: u32 = 2;
pub const TRIPS: u32 = 3;
pub const STRAIGHT: u32 = 4;
pub const FLUSH: u32 = 5;
pub const FULL_HOUSE: u32 = 6;
pub const QUADS: u32 = 7;
pub const STRAIGHT_FLUSH: u32 = 8;

pub fn category(score: u32) -> u32 {
    score >> 20
}

fn pack(category: u32, ranks: &[u8]) -> u32 {
    let mut score = category << 20;
    for i in 0..5 {
        let rank = u32::from(ranks.get(i).copied().unwrap_or(0));
        score |= rank << (16 - 4 * i);
    }
    score
}

/// Highest rank of a straight in a 13-bit rank mask (the wheel counts as a 5-high straight).
fn straight_high(mask: u16) -> Option<u8> {
    for high in (4..=12u8).rev() {
        let window = 0b11111u16 << (high - 4);
        if mask & window == window {
            return Some(high);
        }
    }
    const WHEEL: u16 = (1 << 12) | 0b1111;
    if mask & WHEEL == WHEEL {
        return Some(3);
    }
    None
}

/// Appends up to `n` ranks set in `mask`, highest first, skipping `exclude`.
fn top_ranks(mask: u16, exclude: &[u8], n: usize, out: &mut [u8; 5], len: &mut usize) {
    let mut taken = 0;
    for rank in (0..13u8).rev() {
        if taken == n || *len >= 5 {
            break;
        }
        if mask & (1 << rank) != 0 && !exclude.contains(&rank) {
            out[*len] = rank;
            *len += 1;
            taken += 1;
        }
    }
}

/// Scores the best five-card hand from seven distinct cards below 52.
pub fn eval7(cards: &[u8; 7]) -> u32 {
    let mut counts = [0u8; 13];
    let mut suit_masks = [0u16; 4];
    let mut suit_counts = [0u8; 4];
    let mut all_mask = 0u16;
    for &card in cards {
        let rank = usize::from(card % 13);
        let suit = usize::from((card / 13) % 4);
        counts[rank] += 1;
        suit_masks[suit] |= 1 << rank;
        suit_counts[suit] += 1;
        all_mask |= 1 << rank;
    }

    let flush_suit = (0..4).find(|&s| suit_counts[s] >= 5);
    if let Some(suit) = flush_suit {
        if let Some(high) = straight_high(suit_masks[suit]) {
            return pack(STRAIGHT_FLUSH, &[high]);
        }
    }

    let mut quad = None;
    let mut trips = [0u8; 2];
    let mut trip_n = 0;
    let mut pairs = [0u8; 3];
    let mut pair_n = 0;
    for rank in (0..13u8).rev() {
        match counts[usize::from(rank)] {
            4 => quad = Some(rank),
            3 if trip_n < 2 => {
                trips[trip_n] = rank;
                trip_n += 1;
            }
            2 if pair_n < 3 => {
                pairs[pair_n] = rank;
                pair_n += 1;
            }
            _ => {}
        }
    }

    let mut out = [0u8; 5];
    let mut len = 0usize;

    if let Some(q) = quad {
        out[0] = q;
        len = 1;
        top_ranks(all_mask, &[q], 1, &mut out, &mut len);
        return pack(QUADS, &out[..len]);
    }
    if trip_n >= 1 && (trip_n >= 2 || pair_n >= 1) {
        // A second set of trips can supply the pair of the full house.
        let pair_rank = match (trip_n >= 2, pair_n >= 1) {
            (true, true) => trips[1].max(pairs[0]),
            (true, false) => trips[1],
            _ => pairs[0],
        };
        return pack(FULL_HOUSE, &[trips[0], pair_rank]);
    }
    if let Some(suit) = flush_suit {
        top_ranks(suit_masks[suit], &[], 5, &mut out, &mut len);
        return pack(FLUSH, &out[..len]);
    }
    if let Some(high) = straight_high(all_mask) {
        return pack(STRAIGHT, &[high]);
    }
    if trip_n == 1 {
        out[0] = trips[0];
        len = 1;
        top_ranks(all_mask, &[trips[0]], 2, &mut out, &mut len);
        return pack(TRIPS, &out[..len]);
    }
    if pair_n >= 2 {
        out[0] = pairs[0];
        out[1] = pairs[1];
        len = 2;
        top_ranks(all_mask, &[pairs[0], pairs[1]], 1, &mut out, &mut len);
        return pack(TWO_PAIR, &out[..len]);
    }
    if pair_n == 1 {
        out[0] = pairs[0];
        len = 1;
        top_ranks(all_mask, &[pairs[0]], 3, &mut out, &mut len);
        return pack(PAIR, &out[..len]);
    }
    top_ranks(all_mask, &[], 5, &mut out, &mut len);
    pack(HIGH_CARD, &out[..len])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "As Td 9c" style: rank char then suit char (c d h s).
    fn hand(s: &str) -> [u8; 7] {
        let cards: Vec<u8> = s
            .split_whitespace()
            .map(|t| {
                let b = t.as_bytes();
                let rank = "23456789TJQKA".find(b[0] as char).expect("rank") as u8;
                let suit = "cdhs".find(b[1] as char).expect("suit") as u8;
                suit * 13 + rank
            })
            .collect();
        cards.try_into().expect("seven cards")
    }

    fn cat(s: &str) -> u32 {
        category(eval7(&hand(s)))
    }

    #[test]
    fn detects_every_category() {
        assert_eq!(cat("As Kd 9c 7h 5s 3d 2c"), HIGH_CARD);
        assert_eq!(cat("As Ad 9c 7h 5s 3d 2c"), PAIR);
        assert_eq!(cat("As Ad 9c 9h 5s 3d 2c"), TWO_PAIR);
        assert_eq!(cat("As Ad 9c 9h 9s 3d 2c"), FULL_HOUSE);
        assert_eq!(cat("As Ad Ac 7h 5s 3d 2c"), TRIPS);
        assert_eq!(cat("5s 6d 7c 8h 9s Kd 2c"), STRAIGHT);
        assert_eq!(cat("As 9s 7s 5s 3s Kd 2c"), FLUSH);
        assert_eq!(cat("As Ad Ac Ah 5s 3d 2c"), QUADS);
        assert_eq!(cat("5s 6s 7s 8s 9s Kd 2c"), STRAIGHT_FLUSH);
    }

    #[test]
    fn wheel_is_the_lowest_straight() {
        let wheel = eval7(&hand("As 2d 3c 4h 5s Kd 9c"));
        let six_high = eval7(&hand("2s 3d 4c 5h 6s Kd 9c"));
        assert_eq!(category(wheel), STRAIGHT);
        assert!(six_high > wheel);
        let wheel_flush = eval7(&hand("As 2s 3s 4s 5s Kd 9c"));
        assert_eq!(category(wheel_flush), STRAIGHT_FLUSH);
        let six_flush = eval7(&hand("2s 3s 4s 5s 6s Kd 9c"));
        assert!(six_flush > wheel_flush);
    }

    #[test]
    fn ace_high_straight_beats_king_high() {
        let broadway = eval7(&hand("Ts Jd Qc Kh As 2d 3c"));
        let king_high = eval7(&hand("9s Td Jc Qh Ks 2d 3c"));
        assert_eq!(category(broadway), STRAIGHT);
        assert!(broadway > king_high);
    }

    #[test]
    fn royal_flush_beats_lower_straight_flush() {
        let royal = eval7(&hand("Ts Js Qs Ks As 2d 3c"));
        let nine_high = eval7(&hand("5h 6h 7h 8h 9h 2d 3c"));
        assert!(royal > nine_high);
    }

    #[test]
    fn straight_flush_needs_the_straight_inside_the_flush() {
        assert_eq!(cat("2h 5h 7h 9h Kh 6d 8c"), FLUSH);
        assert_eq!(cat("4h 5h 6h 7h 8h Kh 2c"), STRAIGHT_FLUSH);
    }

    #[test]
    fn full_house_variants() {
        let two_trips = eval7(&hand("Ks Kd Kc 5h 5s 5d 2c"));
        assert_eq!(two_trips, pack(FULL_HOUSE, &[11, 3]));
        let with_pairs = eval7(&hand("Ks Kd Kc 5h 5s 9d 9c"));
        assert_eq!(with_pairs, pack(FULL_HOUSE, &[11, 7]));
        let mixed = eval7(&hand("9s 9d 9c 5h 5s 5d Ac"));
        assert_eq!(mixed, pack(FULL_HOUSE, &[7, 3]));
    }

    #[test]
    fn kickers_decide_between_equal_categories() {
        let ak = eval7(&hand("As Ad Kc 7h 5s 3d 2c"));
        let aq = eval7(&hand("Ah Ac Qc 7d 5h 3s 2d"));
        assert!(ak > aq);
        let quads_k = eval7(&hand("Ks Kd Kc Kh 2s 3d 4c"));
        let quads_q = eval7(&hand("Qs Qd Qc Qh As 3d 4c"));
        assert!(quads_k > quads_q);
        let q1 = eval7(&hand("Qs Qd Qc Qh As Ad 4c"));
        let q2 = eval7(&hand("Qs Qd Qc Qh As 3d 4c"));
        assert_eq!(q1, q2);
        let q3 = eval7(&hand("Qs Qd Qc Qh Ks 3d 4c"));
        assert!(q1 > q3, "ace kicker beats king kicker");
    }

    #[test]
    fn board_plays_ties() {
        let a = eval7(&hand("Ts Jd Qc Kh As 2d 3c"));
        let b = eval7(&hand("Ts Jd Qc Kh As 4d 5c"));
        assert_eq!(a, b);
    }

    #[test]
    fn two_pair_uses_best_two_of_three_pairs() {
        assert_eq!(
            eval7(&hand("As Ad Kc Kh 9s 9d 2c")),
            pack(TWO_PAIR, &[12, 11, 7])
        );
        assert_eq!(
            eval7(&hand("Ks Kd Qc Qh Js Jd Ac")),
            pack(TWO_PAIR, &[11, 10, 12])
        );
    }

    #[test]
    fn category_ordering_is_strict() {
        let ladder = [
            "As Kd 9c 7h 5s 3d 2c",
            "As Ad 9c 7h 5s 3d 2c",
            "As Ad 9c 9h 5s 3d 2c",
            "As Ad Ac 7h 5s 3d 2c",
            "5s 6d 7c 8h 9s Kd 2c",
            "As 9s 7s 5s 3s Kd 2c",
            "As Ad 9c 9h 9s 3d 2c",
            "As Ad Ac Ah 5s 3d 2c",
            "5s 6s 7s 8s 9s Kd 2c",
        ];
        for w in ladder.windows(2) {
            assert!(
                eval7(&hand(w[0])) < eval7(&hand(w[1])),
                "{} < {}",
                w[0],
                w[1]
            );
        }
    }

    /// Independent, deliberately slow reference: best of all 21 five-card subsets.
    fn eval5(cards: [u8; 5]) -> u32 {
        let mut ranks: Vec<u8> = cards.iter().map(|c| c % 13).collect();
        ranks.sort_unstable_by(|a, b| b.cmp(a));
        let flush = cards.iter().all(|c| c / 13 == cards[0] / 13);
        let mut straight_high = None;
        if ranks.windows(2).all(|w| w[0] == w[1] + 1) {
            straight_high = Some(ranks[0]);
        } else if ranks == [12, 3, 2, 1, 0] {
            straight_high = Some(3);
        }
        let mut groups: Vec<(u8, u8)> = Vec::new();
        for &r in &ranks {
            match groups.iter_mut().find(|g| g.1 == r) {
                Some(g) => g.0 += 1,
                None => groups.push((1, r)),
            }
        }
        groups.sort_by(|a, b| b.cmp(a));
        let ordered: Vec<u8> = groups.iter().map(|g| g.1).collect();
        let shape: Vec<u8> = groups.iter().map(|g| g.0).collect();
        match (flush, straight_high, shape.as_slice()) {
            (true, Some(h), _) => pack(STRAIGHT_FLUSH, &[h]),
            (_, _, [4, 1]) => pack(QUADS, &ordered),
            (_, _, [3, 2]) => pack(FULL_HOUSE, &ordered),
            (true, _, _) => pack(FLUSH, &ordered),
            (_, Some(h), _) => pack(STRAIGHT, &[h]),
            (_, _, [3, 1, 1]) => pack(TRIPS, &ordered),
            (_, _, [2, 2, 1]) => pack(TWO_PAIR, &ordered),
            (_, _, [2, 1, 1, 1]) => pack(PAIR, &ordered),
            _ => pack(HIGH_CARD, &ordered),
        }
    }

    fn eval7_reference(cards: &[u8; 7]) -> u32 {
        let mut best = 0;
        for skip_a in 0..7 {
            for skip_b in (skip_a + 1)..7 {
                let five: Vec<u8> = (0..7)
                    .filter(|&i| i != skip_a && i != skip_b)
                    .map(|i| cards[i])
                    .collect();
                best = best.max(eval5(five.try_into().expect("five")));
            }
        }
        best
    }

    #[test]
    fn matches_the_reference_on_random_hands() {
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let mut seen = [0u32; 9];
        for _ in 0..200_000 {
            let mut deck: Vec<u8> = (0..52).collect();
            for i in (1..52).rev() {
                let j = (next() % (i as u64 + 1)) as usize;
                deck.swap(i, j);
            }
            let cards: [u8; 7] = deck[..7].try_into().expect("seven");
            let fast = eval7(&cards);
            assert_eq!(fast, eval7_reference(&cards), "cards {cards:?}");
            seen[category(fast) as usize] += 1;
        }
        for (c, n) in seen.iter().enumerate().take(8) {
            assert!(*n > 0, "category {c} never sampled");
        }
    }
}
