use anchor_lang::prelude::*;

pub const MATCH_SEED: &[u8] = b"match";
pub const DECK_SEED: &[u8] = b"deck";
pub const HOLE_SEED: &[u8] = b"hole";
/// The PDA registered in tesoro_core as this Game's settlement authority.
pub const AUTHORITY_SEED: &[u8] = b"authority";

pub const DECK_SIZE: usize = 52;
/// Marks an unrevealed card slot in the public Match.
pub const NO_CARD: u8 = 255;
/// `GameMatch.winner` / `last_result` sentinel: nobody yet.
pub const NO_WINNER: u8 = 255;
/// `last_result` value for a split pot.
pub const SPLIT: u8 = 2;

pub const STARTING_CHIPS: u64 = 1_500;
/// Seconds after creation within which both Players must have delegated and started the Match.
pub const START_WINDOW_SECS: i64 = 300;
/// Seconds each Player has to contribute entropy at the start of a hand.
pub const ENTROPY_SECS: i64 = 60;
/// Consecutive missed turns after which a Player forfeits the Match.
pub const MAX_MISSED: u8 = 3;

pub const SPEED_STANDARD: u8 = 0;
pub const SPEED_TURBO: u8 = 1;

pub const STATUS_CREATED: u8 = 0;
pub const STATUS_LIVE: u8 = 1;
pub const STATUS_OVER: u8 = 2;
pub const STATUS_CANCELLED: u8 = 3;

pub const PHASE_SHUFFLE: u8 = 0;
pub const PHASE_PREFLOP: u8 = 1;
pub const PHASE_FLOP: u8 = 2;
pub const PHASE_TURN: u8 = 3;
pub const PHASE_RIVER: u8 = 4;
/// No hand in progress (Match over or not started).
pub const PHASE_NONE: u8 = 5;

/// A Player's decision. `Raise { to }` is the total bet for the street after the raise (a bet
/// when nothing is open); `to` equal to the Player's whole stack is an all-in.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    Fold,
    Check,
    Call,
    Raise { to: u64 },
}

/// The public table. Readable by both Players; holds no hidden card.
#[account]
#[derive(InitSpace, Debug)]
pub struct GameMatch {
    pub bump: u8,
    /// Canonical bump of the `authority` PDA, stored so settlement never re-derives it.
    pub authority_bump: u8,
    /// Same id as the tesoro_core Match this Game settles.
    pub match_id: u64,
    pub tesoro_match: Pubkey,
    /// Seat 0 opened the tesoro_core Match, seat 1 joined.
    pub players: [Pubkey; 2],
    pub speed: u8,
    pub status: u8,
    /// Set on the base layer once tesoro_core has been settled or refunded.
    pub finalized: bool,
    /// Winning seat when `status == STATUS_OVER`, else `NO_WINNER`.
    pub winner: u8,
    pub start_deadline: i64,
    pub hand_no: u32,
    /// Seat of the button; in heads-up it posts the small blind and acts first preflop.
    pub dealer: u8,
    pub phase: u8,
    pub small_blind: u64,
    pub big_blind: u64,
    /// Chips behind, per seat.
    pub stacks: [u64; 2],
    /// Chips put in during the current street.
    pub bets: [u64; 2],
    /// Chips put in during the whole hand.
    pub committed: [u64; 2],
    pub to_act: u8,
    pub acted: [bool; 2],
    /// Size of the last full raise this street: the minimum next raise.
    pub last_raise: u64,
    pub board: [u8; 5],
    pub deadline: i64,
    pub missed: [u8; 2],
    pub last_hand_no: u32,
    /// Winning seat of the last hand, or `SPLIT`.
    pub last_result: u8,
    pub last_pot: u64,
    pub last_showdown: bool,
    /// Hole cards shown at the last showdown (`NO_CARD` when not shown).
    pub last_shown: [[u8; 2]; 2],
    pub last_board: [u8; 5],
}

impl Default for GameMatch {
    fn default() -> Self {
        Self {
            bump: 0,
            authority_bump: 0,
            match_id: 0,
            tesoro_match: Pubkey::default(),
            players: [Pubkey::default(); 2],
            speed: SPEED_STANDARD,
            status: STATUS_CREATED,
            finalized: false,
            winner: NO_WINNER,
            start_deadline: 0,
            hand_no: 0,
            dealer: 0,
            phase: PHASE_NONE,
            small_blind: 0,
            big_blind: 0,
            stacks: [0; 2],
            bets: [0; 2],
            committed: [0; 2],
            to_act: 0,
            acted: [false; 2],
            last_raise: 0,
            board: [NO_CARD; 5],
            deadline: 0,
            missed: [0; 2],
            last_hand_no: 0,
            last_result: NO_WINNER,
            last_pot: 0,
            last_showdown: false,
            last_shown: [[NO_CARD; 2]; 2],
            last_board: [NO_CARD; 5],
        }
    }
}

/// Hidden. Zero-member permission: nobody but the program reads it. Reshuffled every hand from
/// fresh Player secrets and a fresh VRF output.
#[account]
#[derive(InitSpace)]
pub struct Deck {
    pub bump: u8,
    pub game_match: Pubkey,
    /// The hand this deck state belongs to; a stale value means "reset on first use".
    pub hand_no: u32,
    pub entropy: [u8; 32],
    pub contributed: [bool; 2],
    pub vrf_seen: bool,
    pub vrf: [u8; 32],
    pub dealt: bool,
    pub cards: [u8; DECK_SIZE],
}

impl Deck {
    pub fn reset_for(&mut self, hand_no: u32) {
        self.hand_no = hand_no;
        self.entropy = [0; 32];
        self.contributed = [false; 2];
        self.vrf_seen = false;
        self.vrf = [0; 32];
        self.dealt = false;
        self.cards = [0; DECK_SIZE];
    }
}

/// Hidden. Readable only by its Player through the permission program.
#[account]
#[derive(InitSpace)]
pub struct Hole {
    pub bump: u8,
    pub game_match: Pubkey,
    pub player: Pubkey,
    pub hand_no: u32,
    pub dealt: bool,
    pub cards: [u8; 2],
}
