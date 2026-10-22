//! Heads-up No-Limit Hold'em rules on the public `GameMatch`. Pure state transitions: no
//! accounts, no syscalls, so the whole rule set is unit-testable on the host. The program glue
//! feeds it the hole cards and the board; the engine only reads them when it must reveal a board
//! card or run a showdown.

use crate::eval::eval7;
use crate::state::*;
use crate::HoldemError;
use anchor_lang::prelude::*;

pub const TURN_SECS: i64 = 30;

/// Where the current hand's shuffle stands, as the program glue reads it from the two seats and
/// the table: who has contributed, and whether the VRF answer is in.
#[derive(Clone, Copy, Debug)]
pub struct Shuffle {
    pub contributed: [bool; 2],
    pub vrf_ready: bool,
}

const STANDARD_LEVELS: [(u64, u64); 10] = [
    (25, 50),
    (50, 100),
    (75, 150),
    (100, 200),
    (150, 300),
    (200, 400),
    (300, 600),
    (400, 800),
    (600, 1_200),
    (800, 1_600),
];
const TURBO_LEVELS: [(u64, u64); 5] = [(50, 100), (100, 200), (200, 400), (400, 800), (800, 1_600)];

fn schedule(speed: u8) -> Result<(&'static [(u64, u64)], u32)> {
    match speed {
        SPEED_STANDARD => Ok((&STANDARD_LEVELS, 4)),
        SPEED_TURBO => Ok((&TURBO_LEVELS, 1)),
        _ => err!(HoldemError::InvalidSpeed),
    }
}

/// Blinds `(small, big)` for a 1-based hand number. The last level repeats.
pub fn blinds(speed: u8, hand_no: u32) -> Result<(u64, u64)> {
    let (levels, per_level) = schedule(speed)?;
    let level = usize::try_from(hand_no.saturating_sub(1) / per_level)
        .map_err(|_| error!(HoldemError::Overflow))?;
    let last = levels.len() - 1;
    Ok(levels[level.min(last)])
}

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(HoldemError::Overflow))
}

fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b)
        .ok_or_else(|| error!(HoldemError::Overflow))
}

fn other(seat: usize) -> usize {
    1 - seat
}

impl GameMatch {
    /// Highest bet on the table this street.
    pub fn current_bet(&self) -> u64 {
        self.bets[0].max(self.bets[1])
    }

    pub fn pot(&self) -> u64 {
        self.committed[0].saturating_add(self.committed[1])
    }

    /// Starts the Match inside the rollup: equal stacks, first hand.
    pub fn start(&mut self, now: i64) -> Result<()> {
        require!(self.status == STATUS_CREATED, HoldemError::AlreadyStarted);
        self.status = STATUS_LIVE;
        self.stacks = [STARTING_CHIPS; 2];
        self.begin_hand(now)
    }

    /// Opens the next hand: rotates the button, posts blinds, waits for the shuffle.
    fn begin_hand(&mut self, now: i64) -> Result<()> {
        self.hand_no = add(u64::from(self.hand_no), 1)?
            .try_into()
            .map_err(|_| error!(HoldemError::Overflow))?;
        self.dealer = if self.hand_no % 2 == 1 { 0 } else { 1 };
        let (small, big) = blinds(self.speed, self.hand_no)?;
        self.small_blind = small;
        self.big_blind = big;
        self.bets = [0; 2];
        self.committed = [0; 2];
        self.acted = [false; 2];
        self.board = [NO_CARD; 5];
        self.phase = PHASE_SHUFFLE;
        let dealer = usize::from(self.dealer);
        self.post(dealer, small)?;
        self.post(other(dealer), big)?;
        self.last_raise = big;
        self.to_act = self.dealer;
        self.deadline = add_time(now, ENTROPY_SECS)?;
        self.extensions = 0;
        Ok(())
    }

    fn post(&mut self, seat: usize, amount: u64) -> Result<()> {
        let put = amount.min(self.stacks[seat]);
        self.stacks[seat] = sub(self.stacks[seat], put)?;
        self.bets[seat] = add(self.bets[seat], put)?;
        self.committed[seat] = add(self.committed[seat], put)?;
        Ok(())
    }

    /// The hand is dealt and hole cards are in place: preflop betting begins.
    pub fn on_dealt(
        &mut self,
        board: &[u8; 5],
        holes: &[[u8; 2]; 2],
        now: i64,
    ) -> Result<()> {
        require!(self.status == STATUS_LIVE, HoldemError::NotLive);
        require!(self.phase == PHASE_SHUFFLE, HoldemError::WrongPhase);
        self.phase = PHASE_PREFLOP;
        self.to_act = self.dealer;
        self.deadline = add_time(now, TURN_SECS)?;
        if self.round_complete() {
            self.finish_street(board, holes, now)?;
        }
        Ok(())
    }

    fn all_in(&self, seat: usize) -> bool {
        self.stacks[seat] == 0
    }

    /// The street is over: nobody can still act usefully.
    fn round_complete(&self) -> bool {
        if self.all_in(0) || self.all_in(1) {
            // A short all-in or a call for less ends the betting once the other Player has at
            // least matched every all-in bet; anything above is returned as uncalled.
            return !(0..2).any(|i| {
                self.all_in(i) && !self.all_in(other(i)) && self.bets[other(i)] < self.bets[i]
            });
        }
        self.acted[0] && self.acted[1] && self.bets[0] == self.bets[1]
    }

    /// A Player's decision. The caller has verified that `seat` is the signer's seat.
    pub fn act(
        &mut self,
        seat: usize,
        action: Action,
        board: &[u8; 5],
        holes: &[[u8; 2]; 2],
        now: i64,
    ) -> Result<()> {
        self.apply(seat, action, board, holes, now)?;
        // A voluntary action clears the missed-turn streak, unless the hand just ended.
        self.missed[seat] = 0;
        Ok(())
    }

    fn apply(
        &mut self,
        seat: usize,
        action: Action,
        board: &[u8; 5],
        holes: &[[u8; 2]; 2],
        now: i64,
    ) -> Result<()> {
        require!(self.status == STATUS_LIVE, HoldemError::NotLive);
        require!(
            (PHASE_PREFLOP..=PHASE_RIVER).contains(&self.phase),
            HoldemError::WrongPhase
        );
        require!(
            seat < 2 && usize::from(self.to_act) == seat,
            HoldemError::NotYourTurn
        );
        let opp = other(seat);
        let current = self.current_bet();

        match action {
            Action::Fold => return self.end_by_fold(opp, now),
            Action::Check => {
                require!(self.bets[seat] == current, HoldemError::CannotCheck);
                self.acted[seat] = true;
            }
            Action::Call => {
                require!(self.bets[seat] < current, HoldemError::NothingToCall);
                let need = sub(current, self.bets[seat])?;
                self.post(seat, need)?;
                self.acted[seat] = true;
            }
            Action::Raise { to } => {
                require!(!self.all_in(opp), HoldemError::OpponentAllIn);
                require!(to > current, HoldemError::RaiseTooSmall);
                let max_to = add(self.bets[seat], self.stacks[seat])?;
                require!(to <= max_to, HoldemError::NotEnoughChips);
                let raise_by = sub(to, current)?;
                let full_raise = raise_by >= self.last_raise;
                require!(full_raise || to == max_to, HoldemError::RaiseTooSmall);
                self.post(seat, sub(to, self.bets[seat])?)?;
                if full_raise {
                    self.last_raise = raise_by;
                }
                self.acted = [false; 2];
                self.acted[seat] = true;
            }
        }

        if self.round_complete() {
            self.finish_street(board, holes, now)
        } else {
            self.to_act = u8::try_from(opp).map_err(|_| error!(HoldemError::Overflow))?;
            self.deadline = add_time(now, TURN_SECS)?;
            Ok(())
        }
    }

    /// Betting on this street is done: return uncalled chips, then deal on or show down.
    fn finish_street(
        &mut self,
        board: &[u8; 5],
        holes: &[[u8; 2]; 2],
        now: i64,
    ) -> Result<()> {
        if self.bets[0] != self.bets[1] {
            let (high, low) = if self.bets[0] > self.bets[1] {
                (0, 1)
            } else {
                (1, 0)
            };
            let excess = sub(self.bets[high], self.bets[low])?;
            self.bets[high] = sub(self.bets[high], excess)?;
            self.committed[high] = sub(self.committed[high], excess)?;
            self.stacks[high] = add(self.stacks[high], excess)?;
        }
        self.bets = [0; 2];
        self.acted = [false; 2];
        self.last_raise = self.big_blind;

        if self.all_in(0) || self.all_in(1) || self.phase == PHASE_RIVER {
            self.reveal_board(board, 5);
            return self.showdown(holes, now);
        }
        self.phase = self.phase.saturating_add(1);
        let visible = if self.phase == PHASE_FLOP {
            3
        } else {
            usize::from(self.phase) + 1
        };
        self.reveal_board(board, visible);
        // Heads-up: the Player out of position (the big blind) acts first after the flop.
        self.to_act = 1 - self.dealer;
        self.deadline = add_time(now, TURN_SECS)?;
        Ok(())
    }

    /// Makes the first `count` board cards public. `board` is the full board, combined from the
    /// two seats' shares by the caller for the duration of the call.
    fn reveal_board(&mut self, board: &[u8; 5], count: usize) {
        for (slot, card) in self.board.iter_mut().zip(board).take(count) {
            *slot = *card;
        }
    }

    fn end_by_fold(&mut self, winner: usize, now: i64) -> Result<()> {
        let pot = self.pot();
        self.stacks[winner] = add(self.stacks[winner], pot)?;
        self.record_hand(
            u8::try_from(winner).map_err(|_| error!(HoldemError::Overflow))?,
            pot,
            false,
            [[NO_CARD; 2]; 2],
        );
        self.after_hand(now)
    }

    fn showdown(&mut self, holes: &[[u8; 2]; 2], now: i64) -> Result<()> {
        let mut scores = [0u32; 2];
        for (seat, score) in scores.iter_mut().enumerate() {
            let mut seven = [0u8; 7];
            seven[..2].copy_from_slice(&holes[seat]);
            seven[2..].copy_from_slice(&self.board);
            *score = eval7(&seven);
        }
        let pot = self.pot();
        let result = if scores[0] > scores[1] {
            self.stacks[0] = add(self.stacks[0], pot)?;
            0
        } else if scores[1] > scores[0] {
            self.stacks[1] = add(self.stacks[1], pot)?;
            1
        } else {
            let half = pot / 2;
            let odd = sub(pot, half.saturating_mul(2))?;
            // The odd chip goes to the Player out of position (the big blind).
            let bb = usize::from(1 - self.dealer);
            self.stacks[0] = add(self.stacks[0], half)?;
            self.stacks[1] = add(self.stacks[1], half)?;
            self.stacks[bb] = add(self.stacks[bb], odd)?;
            SPLIT
        };
        self.record_hand(result, pot, true, *holes);
        self.after_hand(now)
    }

    fn record_hand(&mut self, result: u8, pot: u64, showdown: bool, shown: [[u8; 2]; 2]) {
        self.last_hand_no = self.hand_no;
        self.last_result = result;
        self.last_pot = pot;
        self.last_showdown = showdown;
        self.last_shown = shown;
        self.last_board = self.board;
        self.committed = [0; 2];
        self.bets = [0; 2];
    }

    fn after_hand(&mut self, now: i64) -> Result<()> {
        if self.stacks[0] == 0 || self.stacks[1] == 0 {
            self.status = STATUS_OVER;
            self.winner = if self.stacks[0] == 0 { 1 } else { 0 };
            self.phase = PHASE_NONE;
            return Ok(());
        }
        self.begin_hand(now)
    }

    /// Ends the Match in favour of `winner` (forfeit).
    fn forfeit(&mut self, winner: usize) -> Result<()> {
        self.status = STATUS_OVER;
        self.winner = u8::try_from(winner).map_err(|_| error!(HoldemError::Overflow))?;
        self.phase = PHASE_NONE;
        Ok(())
    }

    /// Ends the Match with both entries to be refunded.
    fn cancel(&mut self) {
        self.status = STATUS_CANCELLED;
        self.winner = NO_WINNER;
        self.phase = PHASE_NONE;
    }

    /// Permissionless clock. `shuffle` is where the current hand's shuffle stands.
    pub fn timeout(
        &mut self,
        shuffle: Shuffle,
        board: &[u8; 5],
        holes: &[[u8; 2]; 2],
        now: i64,
    ) -> Result<()> {
        require!(self.status == STATUS_LIVE, HoldemError::NotLive);
        require!(now > self.deadline, HoldemError::NotTimedOut);
        if self.phase == PHASE_SHUFFLE {
            self.shuffle_timeout(shuffle, now)
        } else {
            self.turn_timeout(board, holes, now)
        }
    }

    fn shuffle_timeout(&mut self, shuffle: Shuffle, now: i64) -> Result<()> {
        match shuffle.contributed {
            [true, true] => {
                // Both Players are ready: the delay is the oracle's, nobody forfeits. The request
                // is made once per hand and never repeated, so a hand whose answer does not come
                // is refunded rather than re-rolled.
                if shuffle.vrf_ready || self.extensions < VRF_MAX_EXTENSIONS {
                    self.extensions = self.extensions.saturating_add(1);
                    self.deadline = add_time(now, ENTROPY_SECS)?;
                } else {
                    self.cancel();
                }
            }
            [false, false] => {
                if self.hand_no == 1 {
                    self.no_show = true;
                }
                self.cancel();
            }
            [seat0, _] => {
                let present = if seat0 { 0 } else { 1 };
                if self.hand_no == 1 {
                    self.cancel();
                } else {
                    self.forfeit(present)?;
                }
            }
        }
        Ok(())
    }

    fn turn_timeout(
        &mut self,
        board: &[u8; 5],
        holes: &[[u8; 2]; 2],
        now: i64,
    ) -> Result<()> {
        let seat = usize::from(self.to_act);
        self.missed[seat] = self.missed[seat].saturating_add(1);
        if self.missed[seat] >= MAX_MISSED {
            return self.forfeit(other(seat));
        }
        let action = if self.bets[seat] == self.current_bet() {
            Action::Check
        } else {
            Action::Fold
        };
        self.apply(seat, action, board, holes, now)
    }
}

fn add_time(now: i64, secs: i64) -> Result<i64> {
    now.checked_add(secs)
        .ok_or_else(|| error!(HoldemError::Overflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000;

    /// The hand the test chooses: the board and each seat's two cards.
    fn deck_of(seat0: [u8; 2], seat1: [u8; 2], board: [u8; 5]) -> ([u8; 5], [[u8; 2]; 2]) {
        (board, [seat0, seat1])
    }

    fn card(s: &str) -> u8 {
        let b = s.as_bytes();
        let rank = "23456789TJQKA".find(b[0] as char).expect("rank") as u8;
        let suit = "cdhs".find(b[1] as char).expect("suit") as u8;
        suit * 13 + rank
    }

    fn cards<const N: usize>(s: [&str; N]) -> [u8; N] {
        s.map(card)
    }

    fn table(speed: u8) -> GameMatch {
        let mut m = GameMatch {
            speed,
            ..GameMatch::default()
        };
        m.start(NOW).expect("start");
        m
    }

    fn dealt(
        m: &mut GameMatch,
        seat0: [&str; 2],
        seat1: [&str; 2],
        board: [&str; 5],
    ) -> ([u8; 5], [[u8; 2]; 2]) {
        let (deck, holes) = deck_of(cards(seat0), cards(seat1), cards(board));
        m.on_dealt(&deck, &holes, NOW).expect("deal");
        (deck, holes)
    }

    fn chips(m: &GameMatch) -> u64 {
        m.stacks[0] + m.stacks[1] + m.committed[0] + m.committed[1]
    }

    /// Chips a seat owns, behind or already in the pot.
    fn total(m: &GameMatch, seat: usize) -> u64 {
        m.stacks[seat] + m.committed[seat]
    }

    type Ctx = ([u8; 5], [[u8; 2]; 2]);

    fn act(m: &mut GameMatch, c: &Ctx, seat: usize, a: Action) -> Result<()> {
        m.act(seat, a, &c.0, &c.1, NOW)
    }

    #[test]
    fn blinds_follow_the_schedule() {
        assert_eq!(blinds(SPEED_STANDARD, 1).unwrap(), (25, 50));
        assert_eq!(blinds(SPEED_STANDARD, 4).unwrap(), (25, 50));
        assert_eq!(blinds(SPEED_STANDARD, 5).unwrap(), (50, 100));
        assert_eq!(blinds(SPEED_STANDARD, 1_000).unwrap(), (800, 1_600));
        assert_eq!(blinds(SPEED_TURBO, 1).unwrap(), (50, 100));
        assert_eq!(blinds(SPEED_TURBO, 2).unwrap(), (100, 200));
        assert_eq!(blinds(SPEED_TURBO, 99).unwrap(), (800, 1_600));
        assert!(blinds(9, 1).is_err());
    }

    #[test]
    fn hand_one_posts_blinds_button_is_small_blind() {
        let m = table(SPEED_STANDARD);
        assert_eq!(m.hand_no, 1);
        assert_eq!(m.dealer, 0);
        assert_eq!(m.bets, [25, 50]);
        assert_eq!(m.stacks, [1_475, 1_450]);
        assert_eq!(m.phase, PHASE_SHUFFLE);
        assert_eq!(chips(&m), 3_000);
    }

    #[test]
    fn button_acts_first_preflop_and_big_blind_first_after_the_flop() {
        let mut m = table(SPEED_STANDARD);
        let c = dealt(
            &mut m,
            ["As", "Ad"],
            ["Kc", "Kd"],
            ["2h", "7s", "9c", "Jd", "3h"],
        );
        assert_eq!(m.phase, PHASE_PREFLOP);
        assert_eq!(m.to_act, 0);
        assert!(
            act(&mut m, &c, 1, Action::Check).is_err(),
            "not seat 1's turn"
        );
        act(&mut m, &c, 0, Action::Call).unwrap();
        // The big blind still has the option.
        assert_eq!(m.phase, PHASE_PREFLOP);
        assert_eq!(m.to_act, 1);
        act(&mut m, &c, 1, Action::Check).unwrap();
        assert_eq!(m.phase, PHASE_FLOP);
        assert_eq!(m.board[..3], c.0[4..7]);
        assert_eq!(m.board[3], NO_CARD);
        assert_eq!(m.to_act, 1);
        assert_eq!(m.bets, [0, 0]);
        assert_eq!(m.committed, [50, 50]);
    }

    #[test]
    fn check_call_and_raise_legality() {
        let mut m = table(SPEED_STANDARD);
        let c = dealt(
            &mut m,
            ["As", "Ad"],
            ["Kc", "Kd"],
            ["2h", "7s", "9c", "Jd", "3h"],
        );
        // Small blind faces 25 to call: cannot check.
        assert!(act(&mut m, &c, 0, Action::Check).is_err());
        // Min raise: to 100 (call 50 + raise of 50); 99 is too small.
        assert!(act(&mut m, &c, 0, Action::Raise { to: 99 }).is_err());
        assert!(
            act(&mut m, &c, 0, Action::Raise { to: 50 }).is_err(),
            "not above the bet"
        );
        assert!(
            act(&mut m, &c, 0, Action::Raise { to: 5_000 }).is_err(),
            "more than the stack"
        );
        act(&mut m, &c, 0, Action::Raise { to: 100 }).unwrap();
        assert_eq!(m.last_raise, 50);
        // Big blind re-raises: min is 100 + 50.
        assert!(act(&mut m, &c, 1, Action::Raise { to: 149 }).is_err());
        act(&mut m, &c, 1, Action::Raise { to: 300 }).unwrap();
        assert_eq!(m.last_raise, 200);
        // Now the min re-raise is 300 + 200 = 500.
        assert!(act(&mut m, &c, 0, Action::Raise { to: 499 }).is_err());
        assert!(act(&mut m, &c, 0, Action::Check).is_err());
        act(&mut m, &c, 0, Action::Call).unwrap();
        assert_eq!(m.phase, PHASE_FLOP);
        assert_eq!(m.committed, [300, 300]);
        assert_eq!(chips(&m), 3_000);
    }

    #[test]
    fn postflop_bet_minimum_is_the_big_blind() {
        let mut m = table(SPEED_STANDARD);
        let c = dealt(
            &mut m,
            ["As", "Ad"],
            ["Kc", "Kd"],
            ["2h", "7s", "9c", "Jd", "3h"],
        );
        act(&mut m, &c, 0, Action::Call).unwrap();
        act(&mut m, &c, 1, Action::Check).unwrap();
        assert!(act(&mut m, &c, 1, Action::Raise { to: 49 }).is_err());
        act(&mut m, &c, 1, Action::Raise { to: 50 }).unwrap();
        act(&mut m, &c, 0, Action::Fold).unwrap();
        // Folded hand: the bettor wins the pot, a new hand starts with the button moved.
        assert_eq!(m.last_result, 1);
        assert_eq!(m.last_pot, 150);
        assert!(!m.last_showdown);
        assert_eq!(m.last_shown, [[NO_CARD; 2]; 2]);
        assert_eq!(m.hand_no, 2);
        assert_eq!(m.dealer, 1);
        assert_eq!(m.phase, PHASE_SHUFFLE);
        assert_eq!(chips(&m), 3_000);
    }

    #[test]
    fn check_down_to_showdown_pays_the_better_hand_and_reveals_only_then() {
        let mut m = table(SPEED_STANDARD);
        let c = dealt(
            &mut m,
            ["As", "Ad"],
            ["Kc", "Kd"],
            ["2h", "7s", "9c", "Jd", "3h"],
        );
        act(&mut m, &c, 0, Action::Call).unwrap();
        act(&mut m, &c, 1, Action::Check).unwrap();
        for _ in 0..3 {
            act(&mut m, &c, 1, Action::Check).unwrap();
            act(&mut m, &c, 0, Action::Check).unwrap();
        }
        // Aces beat kings; pot of 100.
        assert_eq!(m.last_result, 0);
        assert_eq!(m.last_pot, 100);
        assert!(m.last_showdown);
        assert_eq!(m.last_shown, [c.1[0], c.1[1]]);
        assert_eq!(m.last_board, cards(["2h", "7s", "9c", "Jd", "3h"]));
        assert_eq!([total(&m, 0), total(&m, 1)], [1_550, 1_450]);
        assert_eq!(m.hand_no, 2);
        assert_eq!(chips(&m), 3_000);
    }

    #[test]
    fn split_pot_returns_each_stack() {
        let mut m = table(SPEED_STANDARD);
        // Board plays for both (broadway straight).
        let c = dealt(
            &mut m,
            ["2s", "3d"],
            ["2c", "3h"],
            ["Ts", "Jd", "Qc", "Kh", "Ad"],
        );
        act(&mut m, &c, 0, Action::Call).unwrap();
        act(&mut m, &c, 1, Action::Check).unwrap();
        for _ in 0..3 {
            act(&mut m, &c, 1, Action::Check).unwrap();
            act(&mut m, &c, 0, Action::Check).unwrap();
        }
        assert_eq!(m.last_result, SPLIT);
        assert_eq!([total(&m, 0), total(&m, 1)], [1_500, 1_500]);
    }

    #[test]
    fn all_in_and_call_runs_out_the_board() {
        let mut m = table(SPEED_STANDARD);
        let c = dealt(
            &mut m,
            ["As", "Ad"],
            ["Kc", "Kd"],
            ["2h", "7s", "9c", "Jd", "3h"],
        );
        act(&mut m, &c, 0, Action::Raise { to: 1_500 }).unwrap();
        // The opponent is all-in-able: min-raise rules do not apply to a shove.
        assert_eq!(m.to_act, 1);
        assert!(act(&mut m, &c, 1, Action::Check).is_err());
        act(&mut m, &c, 1, Action::Call).unwrap();
        assert_eq!(m.status, STATUS_OVER);
        assert_eq!(m.winner, 0);
        assert_eq!(m.stacks, [3_000, 0]);
        assert_eq!(m.last_board, cards(["2h", "7s", "9c", "Jd", "3h"]));
    }

    #[test]
    fn call_for_less_returns_the_uncalled_chips() {
        let mut m = table(SPEED_STANDARD);
        m.stacks = [1_475, 275];
        let c = dealt(
            &mut m,
            ["As", "Ad"],
            ["Kc", "Kd"],
            ["2h", "7s", "9c", "Jd", "3h"],
        );
        act(&mut m, &c, 0, Action::Raise { to: 1_000 }).unwrap();
        // Seat 1 has 325 in total: calls all-in for less.
        act(&mut m, &c, 1, Action::Call).unwrap();
        // The 675 uncalled came back first; the pot is 650 and seat 0 wins it.
        assert_eq!(m.status, STATUS_OVER);
        assert_eq!(m.stacks, [1_825, 0]);
    }

    #[test]
    fn short_all_in_raise_needs_only_a_call_or_fold_and_cannot_be_reraised() {
        let mut m = table(SPEED_STANDARD);
        m.stacks = [1_475, 125];
        let before = chips(&m);
        let c = dealt(
            &mut m,
            ["2s", "3d"],
            ["Ac", "Ad"],
            ["9h", "7s", "8c", "Jd", "Kh"],
        );
        act(&mut m, &c, 0, Action::Call).unwrap();
        // Seat 1 shoves its last 175 in total.
        act(&mut m, &c, 1, Action::Raise { to: 175 }).unwrap();
        assert!(
            act(&mut m, &c, 0, Action::Raise { to: 400 }).is_err(),
            "opponent is all-in"
        );
        act(&mut m, &c, 0, Action::Call).unwrap();
        assert_eq!(m.status, STATUS_LIVE);
        assert_eq!(m.last_result, 1, "aces hold against 2-3 on this board");
        assert_eq!(chips(&m), before);
    }

    #[test]
    fn a_full_raise_sets_the_next_minimum() {
        let mut m = table(SPEED_STANDARD);
        m.phase = PHASE_FLOP;
        m.bets = [0, 0];
        m.acted = [false; 2];
        m.committed = [100, 100];
        m.stacks = [1_400, 1_400];
        m.to_act = 1;
        m.last_raise = 50;
        let c = deck_of([20, 21], [30, 31], [1, 2, 3, 4, 5]);
        act(&mut m, &c, 1, Action::Raise { to: 200 }).unwrap();
        assert_eq!(m.last_raise, 200);
        // Seat 0 shoves: a full raise, legal.
        act(&mut m, &c, 0, Action::Raise { to: 1_400 }).unwrap();
        assert_eq!(m.last_raise, 1_200);
    }

    #[test]
    fn min_raise_smaller_than_the_stack_is_rejected_but_all_in_short_is_allowed() {
        let mut m = table(SPEED_STANDARD);
        m.phase = PHASE_FLOP;
        m.bets = [0, 300];
        m.acted = [false, true];
        m.committed = [50, 350];
        m.stacks = [340, 1_000];
        m.to_act = 0;
        m.last_raise = 300;
        let c = deck_of([20, 21], [30, 31], [1, 2, 3, 4, 5]);
        // Seat 0 has 340: to 340 is a raise of 40 < 300 but it is all-in, so allowed.
        assert!(act(&mut m, &c, 0, Action::Raise { to: 339 }).is_err());
        act(&mut m, &c, 0, Action::Raise { to: 340 }).unwrap();
        assert_eq!(
            m.last_raise, 300,
            "an incomplete raise does not change the minimum"
        );
        // Seat 1 must call or fold; the raise option is gone since seat 0 is all-in.
        assert!(act(&mut m, &c, 1, Action::Raise { to: 900 }).is_err());
    }

    #[test]
    fn blinds_that_put_both_players_all_in_run_out_at_the_deal() {
        let mut m = table(SPEED_TURBO);
        m.stacks = [0, 0];
        m.bets = [60, 60];
        m.committed = [60, 60];
        let (deck, holes) = deck_of(
            cards(["As", "Ad"]),
            cards(["Kc", "Kd"]),
            cards(["2h", "7s", "9c", "Jd", "3h"]),
        );
        m.on_dealt(&deck, &holes, NOW).unwrap();
        assert_eq!(m.status, STATUS_OVER);
        assert_eq!(m.winner, 0);
        assert_eq!(m.stacks, [120, 0]);
    }

    #[test]
    fn match_ends_when_a_player_has_all_chips_and_seat_two_can_win() {
        let mut m = table(SPEED_STANDARD);
        let c = dealt(
            &mut m,
            ["2s", "3d"],
            ["Ac", "Ad"],
            ["9h", "7s", "8c", "Jd", "Kh"],
        );
        act(&mut m, &c, 0, Action::Raise { to: 1_500 }).unwrap();
        act(&mut m, &c, 1, Action::Call).unwrap();
        assert_eq!(m.status, STATUS_OVER);
        assert_eq!(m.winner, 1);
        assert_eq!(m.phase, PHASE_NONE);
        assert_eq!(m.stacks, [0, 3_000]);
        assert!(
            act(&mut m, &c, 0, Action::Check).is_err(),
            "no actions after the end"
        );
    }

    #[test]
    fn timeouts_check_when_free_and_fold_when_facing_a_bet() {
        let mut m = table(SPEED_STANDARD);
        let c = dealt(
            &mut m,
            ["As", "Ad"],
            ["Kc", "Kd"],
            ["2h", "7s", "9c", "Jd", "3h"],
        );
        let late = m.deadline + 1;
        assert!(
            m.timeout([true, true], &c.0, &c.1, m.deadline).is_err(),
            "not late yet"
        );
        // Seat 0 (small blind) faces 25: the timeout folds.
        m.timeout([true, true], &c.0, &c.1, late).unwrap();
        assert_eq!(m.last_result, 1);
        assert_eq!(m.hand_no, 2);
        assert_eq!(m.missed, [1, 0]);

        // Next hand: seat 1 is the button; seat 0 checks (BB) is not possible preflop; play on.
        let c2 = dealt(
            &mut m,
            ["As", "Ad"],
            ["Kc", "Kd"],
            ["2h", "7s", "9c", "Jd", "3h"],
        );
        act(&mut m, &c2, 1, Action::Call).unwrap();
        // Seat 0 (BB) is late with a free check.
        let late = m.deadline + 1;
        m.timeout([true, true], &c2.0, &c2.1, late).unwrap();
        assert_eq!(m.phase, PHASE_FLOP);
        assert_eq!(m.missed, [2, 0]);
    }

    #[test]
    fn three_missed_turns_forfeit_the_match() {
        let mut m = table(SPEED_STANDARD);
        let c = dealt(
            &mut m,
            ["As", "Ad"],
            ["Kc", "Kd"],
            ["2h", "7s", "9c", "Jd", "3h"],
        );
        m.missed = [2, 0];
        let late = m.deadline + 1;
        m.timeout([true, true], &c.0, &c.1, late).unwrap();
        assert_eq!(m.status, STATUS_OVER);
        assert_eq!(m.winner, 1);
    }

    #[test]
    fn a_voluntary_action_clears_the_missed_streak() {
        let mut m = table(SPEED_STANDARD);
        let c = dealt(
            &mut m,
            ["As", "Ad"],
            ["Kc", "Kd"],
            ["2h", "7s", "9c", "Jd", "3h"],
        );
        m.missed = [2, 0];
        act(&mut m, &c, 0, Action::Call).unwrap();
        assert_eq!(m.missed, [0, 0]);
    }

    fn waiting(contributed: [bool; 2]) -> Shuffle {
        Shuffle {
            contributed,
            vrf_ready: false,
        }
    }

    #[test]
    fn no_show_at_the_start_cancels_the_match() {
        let board = [0u8; 5];
        let holes = [[0u8; 2]; 2];
        // A Player never contributes entropy to hand one.
        let mut m = table(SPEED_STANDARD);
        assert!(m
            .timeout(waiting([true, false]), &board, &holes, m.deadline)
            .is_err());
        m.timeout(waiting([true, false]), &board, &holes, m.deadline + 1)
            .unwrap();
        assert_eq!(m.status, STATUS_CANCELLED);
        assert_eq!(m.winner, NO_WINNER);
        assert!(!m.no_show);

        // Neither does: both checked in and nobody took part, a no-show.
        let mut m = table(SPEED_STANDARD);
        m.timeout(waiting([false, false]), &board, &holes, m.deadline + 1)
            .unwrap();
        assert_eq!(m.status, STATUS_CANCELLED);
        assert!(m.no_show);
    }

    #[test]
    fn a_lost_vrf_answer_ends_the_hand_in_a_refund_after_a_bounded_wait() {
        let board = [0u8; 5];
        let holes = [[0u8; 2]; 2];
        let mut m = table(SPEED_STANDARD);
        for n in 0..VRF_MAX_EXTENSIONS {
            let d = m.deadline;
            m.timeout(waiting([true, true]), &board, &holes, d + 1)
                .unwrap();
            assert_eq!(m.status, STATUS_LIVE, "extension {n}");
        }
        let d = m.deadline;
        m.timeout(waiting([true, true]), &board, &holes, d + 1)
            .unwrap();
        assert_eq!(m.status, STATUS_CANCELLED);
        assert!(!m.no_show);

        // An answer that has arrived is only waiting for `deal`: never cancelled.
        let mut m = table(SPEED_STANDARD);
        let ready = Shuffle {
            contributed: [true, true],
            vrf_ready: true,
        };
        for _ in 0..(VRF_MAX_EXTENSIONS + 3) {
            let d = m.deadline;
            m.timeout(ready, &board, &holes, d + 1).unwrap();
        }
        assert_eq!(m.status, STATUS_LIVE);
    }

    #[test]
    fn absent_player_in_a_later_hand_forfeits_and_both_ready_only_extends() {
        let deck = [0u8; 5];
        let holes = [[0u8; 2]; 2];
        let mut m = table(SPEED_STANDARD);
        let c = dealt(
            &mut m,
            ["As", "Ad"],
            ["Kc", "Kd"],
            ["2h", "7s", "9c", "Jd", "3h"],
        );
        act(&mut m, &c, 0, Action::Fold).unwrap();
        assert_eq!(m.hand_no, 2);
        let d = m.deadline;
        m.timeout(waiting([true, true]), &deck, &holes, d + 1)
            .unwrap();
        assert_eq!(m.status, STATUS_LIVE);
        assert!(m.deadline > d);
        let d = m.deadline;
        m.timeout(waiting([false, true]), &deck, &holes, d + 1)
            .unwrap();
        assert_eq!(m.status, STATUS_OVER);
        assert_eq!(m.winner, 1);
    }

    /// Plays random legal actions against random decks and checks the invariants that matter to
    /// the Pot: Chips are conserved, the Match terminates, and every hand ends.
    #[test]
    fn random_play_conserves_chips_and_terminates() {
        let mut state = 0x1234_5678_9ABC_DEF1u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for game in 0..400 {
            let speed = if game % 2 == 0 {
                SPEED_STANDARD
            } else {
                SPEED_TURBO
            };
            let mut m = table(speed);
            let mut steps = 0;
            while m.status == STATUS_LIVE {
                steps += 1;
                assert!(steps < 20_000, "match did not terminate");
                let mut deck: Vec<u8> = (0..52).collect();
                for i in (1..52).rev() {
                    let j = (next() % (i as u64 + 1)) as usize;
                    deck.swap(i, j);
                }
                let holes = [[deck[0], deck[2]], [deck[1], deck[3]]];
                let deck: [u8; 5] = deck[4..9].try_into().expect("5");
                let hand = m.hand_no;
                m.on_dealt(&deck, &holes, NOW).unwrap();
                while m.status == STATUS_LIVE && m.hand_no == hand {
                    assert_eq!(chips(&m), 3_000);
                    let seat = usize::from(m.to_act);
                    let current = m.current_bet();
                    let roll = next() % 10;
                    let max_to = m.bets[seat] + m.stacks[seat];
                    let action = if roll < 2 {
                        Action::Fold
                    } else if roll < 6 {
                        if m.bets[seat] == current {
                            Action::Check
                        } else {
                            Action::Call
                        }
                    } else if roll < 9 && max_to > current && m.stacks[1 - seat] > 0 {
                        let min = current + m.last_raise;
                        let to = if min >= max_to {
                            max_to
                        } else {
                            min + next() % (max_to - min + 1)
                        };
                        Action::Raise { to }
                    } else if m.bets[seat] == current {
                        Action::Check
                    } else {
                        Action::Call
                    };
                    m.act(seat, action, &deck, &holes, NOW)
                        .unwrap_or_else(|e| panic!("{action:?} rejected: {e:?}\n{m:?}"));
                }
                if m.status == STATUS_LIVE {
                    assert_eq!(m.phase, PHASE_SHUFFLE);
                    assert_eq!(chips(&m), 3_000);
                }
            }
            assert_eq!(m.status, STATUS_OVER);
            assert_eq!(m.stacks[usize::from(m.winner)], 3_000);
            assert_eq!(m.stacks[1 - usize::from(m.winner)], 0);
        }
    }
}
