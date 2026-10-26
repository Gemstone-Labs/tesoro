use anchor_lang::prelude::*;
pub use table_kit::{CommitGuard, Ring, Slot};

pub const CONFIG_SEED: &[u8] = b"config";
pub const SPONSOR_SEED: &[u8] = b"sponsor";
pub const FUEL_SEED: &[u8] = b"fuel";
pub const TABLE_SEED: &[u8] = b"table";
pub const ASSIGN_SEED: &[u8] = b"assign";
pub const HOLE_SEED: &[u8] = b"hole";
/// The address the VRF callback of one request must name (see `Table::vrf_nonce`).
pub const VRF_REQUEST_SEED: &[u8] = b"vrfreq";
/// The PDA registered in tesoro_core as this Game's settlement authority.
pub const AUTHORITY_SEED: &[u8] = b"authority";

pub const DECK_SIZE: usize = 52;
/// Cards a hand uses: two per Player and five on the board.
pub const USED_CARDS: usize = 9;
/// Marks an unrevealed card slot in the public Match.
pub const NO_CARD: u8 = 255;
/// `GameMatch.winner` / `last_result` sentinel: nobody yet.
pub const NO_WINNER: u8 = 255;
/// `last_result` value for a split pot.
pub const SPLIT: u8 = 2;

pub const STARTING_CHIPS: u64 = 1_500;
/// Seconds from the assignment within which both Players must have checked in.
pub const START_WINDOW_SECS: i64 = 300;
/// How long tesoro_core keeps refunds closed to everyone but this Game, counted from the
/// assignment. It must outlast the start window, the longest sit-and-go with every clock running
/// out (blinds top out after 40 hands, at most a few minutes of clocks each) and any outage of
/// the rollup, so that a finished Match is settled before anyone can refund it.
pub const TABLE_WINDOW_SECS: i64 = 24 * 60 * 60;
/// Seconds each Player has to contribute entropy at the start of a hand.
pub const ENTROPY_SECS: i64 = 60;
/// After both Players have contributed, how many times the shuffle clock may be extended while
/// the VRF request is outstanding or not yet made, before the hand is cancelled and refunded. The
/// request is made once per hand and never repeated, so a lost answer ends the Match.
pub const VRF_MAX_EXTENSIONS: u8 = 3;
/// Consecutive missed turns after which a Player forfeits the Match.
pub const MAX_MISSED: u8 = 3;

/// A finished table waits this long before it is reset, so clients can read the final board.
pub const RESET_DELAY_SECS: i64 = 30;
/// A receipt is trusted only this long after it was written (the rollup copies base accounts a
/// moment after they change).
pub const RELEASE_DELAY_SECS: i64 = 60;
/// A ring slot whose core Match account has vanished is freed after this long.
pub const STALE_SLOT_SECS: i64 = 15 * 24 * 60 * 60;
/// Hard ceiling on tables per generation, whatever `Config.max_tables` says.
pub const MAX_TABLES_HARD: u16 = 256;
/// Lamports a new table gets for the rent of its ephemeral seats and permissions.
pub const TABLE_BUFFER_LAMPORTS: u64 = 20_000_000;

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

/// A table between Matches.
pub const TABLE_IDLE: u8 = 0;
/// A Match began; the seats are handed to its Players and they check in.
pub const TABLE_WAITING: u8 = 1;
pub const TABLE_LIVE: u8 = 2;
/// The result is in the ring; the table waits to be committed, wiped and reset.
pub const TABLE_OVER: u8 = 3;

/// A Player's decision. `Raise { to }` is the total bet for the street after the raise (a bet
/// when nothing is open); `to` equal to the Player's whole stack is an all-in.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    Fold,
    Check,
    Call,
    Raise { to: u64 },
}

/// Game-wide settings. The upgrade authority names the operator (the key that creates tables and
/// assigns Matches), the current table generation (which may only rise) and the table cap.
#[account]
#[derive(InitSpace, Debug)]
pub struct TableConfig {
    pub bump: u8,
    pub operator: Pubkey,
    pub generation: u16,
    pub max_tables: u16,
}

/// A program-owned lamport holder, delegated once, that pays the commits as the fee payer.
#[account]
#[derive(InitSpace, Debug)]
pub struct Sponsor {
    pub bump: u8,
}

/// A delegated lamport reserve the operator empties into the Sponsor inside the rollup (a base
/// transfer to a delegated account is not seen there).
#[account]
#[derive(InitSpace, Debug)]
pub struct Fuel {
    pub bump: u8,
    pub n: u8,
}

/// The write-once binding of one tesoro_core Match to one table and one epoch. Created on base by
/// the operator, read by the table in the rollup and by `finalize` on base.
#[account]
#[derive(InitSpace, Debug)]
pub struct Assignment {
    pub bump: u8,
    pub tesoro_match: Pubkey,
    pub generation: u16,
    pub index: u16,
    pub epoch: u64,
    /// Seat 0 opened the tesoro_core Match, seat 1 joined (the Players' authorities).
    pub players: [Pubkey; 2],
    /// `SPEED_STANDARD` or `SPEED_TURBO`, from the Match's `meta.asset`.
    pub speed: u8,
    /// Unix time by which both Players must have checked in.
    pub start_deadline: i64,
    /// Who paid this account's rent; it goes back there when the Assignment is closed.
    pub payer: Pubkey,
}

/// The public part of a Match, played on a table. Readable by anyone; holds no hidden card.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub struct GameMatch {
    /// Seat 0 opened the tesoro_core Match, seat 1 joined.
    pub players: [Pubkey; 2],
    pub speed: u8,
    pub status: u8,
    /// Winning seat when `status == STATUS_OVER`, else `NO_WINNER`.
    pub winner: u8,
    /// Both Players checked in and neither took part in the first hand: a no-show, not a refund.
    pub no_show: bool,
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
    /// Times the shuffle clock was extended this hand while both Players were ready.
    pub extensions: u8,
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
            players: [Pubkey::default(); 2],
            speed: SPEED_STANDARD,
            status: STATUS_CREATED,
            winner: NO_WINNER,
            no_show: false,
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
            extensions: 0,
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

/// A persistent table. Delegated once and never undelegated in normal running; only this public
/// account is ever committed to Solana. Its two `Hole` seats are rollup-only accounts that live as
/// long as the table does.
#[account]
#[derive(InitSpace, Debug)]
pub struct Table {
    pub bump: u8,
    pub generation: u16,
    pub index: u16,
    /// Rises at every reset; a Match is bound to one epoch.
    pub epoch: u64,
    pub phase: u8,
    /// The two Hole seats exist (created once, kept for the table's life).
    pub seats_created: bool,
    /// The seats belong to the current Match's Players.
    pub seats_open: bool,
    /// The result is in and not yet committed.
    pub dirty: bool,
    /// The Match on the table (default key while Idle).
    pub tesoro_match: Pubkey,
    /// Its ring slot.
    pub slot: u8,
    pub start_deadline: i64,
    pub checked_in: [bool; 2],
    pub over_at: i64,
    /// Counts VRF requests on this table, never reset. The callback of request `n` must name the
    /// address `["vrfreq", table, n]`, so an answer to any other request is refused.
    pub vrf_nonce: u64,
    /// The number of the latest request.
    pub req_nonce: u64,
    /// A VRF request is outstanding.
    pub req_pending: bool,
    pub req_epoch: u64,
    pub req_hand: u32,
    pub req_at: i64,
    /// The answer arrived and waits for `deal`.
    pub vrf_ready: bool,
    pub game: GameMatch,
    /// Results of finished Matches, kept until tesoro_core has frozen them.
    pub ring: Ring,
    /// When the table may be committed again if a commit was lost on its way to base.
    pub commit: CommitGuard,
}

impl Table {
    pub fn new(bump: u8, generation: u16, index: u16) -> Self {
        Self {
            bump,
            generation,
            index,
            epoch: 0,
            phase: TABLE_IDLE,
            seats_created: false,
            seats_open: false,
            dirty: false,
            tesoro_match: Pubkey::default(),
            slot: 0,
            start_deadline: 0,
            checked_in: [false; 2],
            over_at: 0,
            vrf_nonce: 0,
            req_nonce: 0,
            req_pending: false,
            req_epoch: 0,
            req_hand: 0,
            req_at: 0,
            vrf_ready: false,
            game: GameMatch::default(),
            ring: Ring::default(),
            commit: CommitGuard::default(),
        }
    }

    /// Forgets the finished Match and moves to the next epoch. The ring, the seats' existence and
    /// the request counter stay.
    pub fn reset(&mut self) -> Option<()> {
        let epoch = self.epoch.checked_add(1)?;
        let (ring, nonce, created, commit) =
            (self.ring, self.vrf_nonce, self.seats_created, self.commit);
        *self = Self::new(self.bump, self.generation, self.index);
        self.epoch = epoch;
        self.ring = ring;
        self.vrf_nonce = nonce;
        self.seats_created = created;
        self.commit = commit;
        Some(())
    }

    /// The address a VRF callback must name for the request numbered `nonce`.
    pub fn request_marker(table: &Pubkey, nonce: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[VRF_REQUEST_SEED, table.as_ref(), &nonce.to_le_bytes()],
            &crate::ID,
        )
        .0
    }
}

/// One Player's hidden seat: an ephemeral account (rollup-only, never committed) behind a private
/// permission, created once with the table and kept for its life. Between Matches the data is
/// zeroed and the permission's member is swapped to nobody and then to the next Player; the
/// account and its permission are never closed or left without a private permission while a
/// Match may be live.
///
/// It holds this Player's own secret and one half of the VRF output until `deal`, then the
/// Player's two hole cards and their share of each board card. Neither Hole alone says anything
/// about the board, the shuffle or the other Hole.
#[account]
#[derive(InitSpace)]
pub struct Hole {
    pub bump: u8,
    pub table: Pubkey,
    pub seat: u8,
    /// The Player who may read this seat now; default while the seat is wiped.
    pub player: Pubkey,
    /// The hand the contribution below belongs to.
    pub hand_no: u32,
    pub contributed: bool,
    pub secret: [u8; 32],
    /// Hash of the last secret this seat took, to refuse a repeated secret. Zero when wiped.
    pub last_secret_hash: [u8; 32],
    pub half_set: bool,
    pub half: [u8; 32],
    /// Reserved for entropy a future confidential source may write; mixed into the seed. Zero
    /// today, and no instruction writes it.
    pub ext_entropy: [u8; 32],
    pub dealt: bool,
    pub cards: [u8; 2],
    /// This seat's XOR share of each board card; the two seats' shares combine to the card.
    pub shares: [u8; 5],
}

impl Hole {
    /// A seat with no Player and no data.
    pub fn blank(bump: u8, table: Pubkey, seat: u8) -> Self {
        Self {
            bump,
            table,
            seat,
            player: Pubkey::default(),
            hand_no: 0,
            contributed: false,
            secret: [0; 32],
            last_secret_hash: [0; 32],
            half_set: false,
            half: [0; 32],
            ext_entropy: [0; 32],
            dealt: false,
            cards: [0; 2],
            shares: [0; 5],
        }
    }

    /// Nothing the previous Match left is readable: the seat is back to a blank state.
    pub fn wipe(&mut self) {
        *self = Self::blank(self.bump, self.table, self.seat);
    }

    /// The hand is over: the cards and shares go, the seat stays with its Player.
    pub fn clear_hand(&mut self) {
        self.dealt = false;
        self.cards = [0; 2];
        self.shares = [0; 5];
    }

    /// The secrets are spent at the deal: only the hash that refuses a repeat stays.
    pub fn spend_secrets(&mut self) {
        self.contributed = false;
        self.secret = [0; 32];
        self.half_set = false;
        self.half = [0; 32];
    }

    pub fn is_blank(&self) -> bool {
        *self == Self::blank(self.bump, self.table, self.seat)
    }
}

impl PartialEq for Hole {
    fn eq(&self, o: &Self) -> bool {
        self.bump == o.bump
            && self.table == o.table
            && self.seat == o.seat
            && self.player == o.player
            && self.hand_no == o.hand_no
            && self.contributed == o.contributed
            && self.secret == o.secret
            && self.last_secret_hash == o.last_secret_hash
            && self.half_set == o.half_set
            && self.half == o.half
            && self.ext_entropy == o.ext_entropy
            && self.dealt == o.dealt
            && self.cards == o.cards
            && self.shares == o.shares
    }
}

/// Lengths of the pre-table per-Match `Hole` records still on devnet. `retire_legacy_account`
/// closes exactly these; the guard treats them as retire-only. A current `Hole` is never one of them.
pub const LEGACY_HOLE_LENGTHS: [usize; 2] = [76, 80];
const _: () = {
    let mut i = 0;
    while i < LEGACY_HOLE_LENGTHS.len() {
        assert!(LEGACY_HOLE_LENGTHS[i] != 8 + Hole::INIT_SPACE);
        i += 1;
    }
};
