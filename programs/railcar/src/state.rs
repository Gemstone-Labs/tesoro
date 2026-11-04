//! Railcar accounts and constants. See `.scratch/railcar/06-ride-decision.md` for why each lives
//! where it does.

use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const CAR_SEED: &[u8] = b"car";
pub const TABLE_SEED: &[u8] = b"table";
pub const VAULT_SEED: &[u8] = b"vault";
pub const SPONSOR_SEED: &[u8] = b"sponsor";
pub const FUEL_SEED: &[u8] = b"fuel";
/// A Table seat's Brake seat: `["brake", table, seat]`.
pub const BRAKE_SEED: &[u8] = b"brake";
/// The address the VRF callback of one request must name (see `Table::vrf_nonce`).
pub const VRF_REQUEST_SEED: &[u8] = b"vrfreq";
/// The PDA registered in tesoro_core as Railcar's settle authority.
pub const AUTHORITY_SEED: &[u8] = b"authority";

/// Every car's entry (decision Q3b: one entry, one Queue).
pub const ENTRY_GEMAS: u64 = 500;
pub const MIN_SEATS: u8 = 5;
pub const MAX_SEATS: u8 = 100;
/// The countdown from the first time the car holds `MIN_SEATS` (decision Q30).
pub const COUNTDOWN_SECS: i64 = 30;
/// Tables a Config may name: enough for a ride in progress and the next car boarding.
pub const MIN_TABLES: u16 = 2;
pub const MAX_TABLES: u16 = 16;

/// Rollup slots per second (Block Burst's devnet-tee measure); a ride's clock runs in slots.
pub const SLOTS_PER_SEC: u64 = 100;
pub const MS_PER_SLOT: u64 = 1_000 / SLOTS_PER_SEC;
/// From `start_ride`, how long the VRF answer may take before the ride is void.
pub const DRAW_WINDOW_SECS: u64 = 90;
pub const DRAW_WINDOW_SLOTS: u64 = DRAW_WINDOW_SECS * SLOTS_PER_SEC;
/// A request is retried this long after the last one while no answer has come.
pub const DRAW_RETRY_SLOTS: u64 = 20 * SLOTS_PER_SEC;
pub const MAX_DRAW_REQUESTS: u8 = 3;
/// Room in the Vault's press list: one per seat, plus one slot a Brake that does nothing writes.
pub const PRESS_ROOM: usize = MAX_SEATS as usize + 1;

/// Lamports a new Table gets for the rent of its Vault and the Vault's permission.
pub const TABLE_BUFFER_LAMPORTS: u64 = 10_000_000;

/// Table phases.
pub const PHASE_IDLE: u8 = 0;
/// A car is on the Table; the draw is being asked for.
pub const PHASE_DRAWING: u8 = 1;
/// The draw is in; the ride clock runs from `ride_slot`.
pub const PHASE_RIDING: u8 = 2;
/// The result is written; the Table waits for core to freeze the car before the next one.
pub const PHASE_OVER: u8 = 3;

/// Ride outcomes.
pub const OUTCOME_NONE: u8 = 0;
/// The last Players off are placed, early Jumpers refunded by the schedule.
pub const OUTCOME_PLACED: u8 = 1;
/// Every entry back in full, no fees.
pub const OUTCOME_REFUND: u8 = 2;

/// Why a ride ended the way it did.
pub const REASON_NONE: u8 = 0;
/// Impact, or the last Player aboard Jumped.
pub const REASON_PLAYED: u8 = 1;
/// Impact with nobody off: full refund.
pub const REASON_NOBODY_JUMPED: u8 = 2;
/// The draw never came: full refund.
pub const REASON_NO_DRAW: u8 = 3;

/// No Table seat.
pub const NO_SEAT: u8 = 255;

/// Railcar's settings and its one boarding line. The upgrade authority names the operator and
/// the number of Tables (fixed once the first car opened, since a car's Table is
/// `car_no % tables`).
#[account]
#[derive(InitSpace, Debug)]
pub struct RailcarConfig {
    pub bump: u8,
    pub operator: Pubkey,
    pub tables: u16,
    /// The number the next car gets.
    pub next_car: u64,
    /// The core Match of the car boarding now (default before the first car).
    pub boarding_match: Pubkey,
}

/// One car: the core many-seat Match it boards and the Table it rides on. On base, never
/// delegated; the rollup reads it. Closed once core froze its Match.
#[account]
#[derive(InitSpace, Debug)]
pub struct Car {
    pub bump: u8,
    pub car_no: u64,
    pub tesoro_match: Pubkey,
    pub table: u16,
    /// `Config.tables` when the car opened: the car after it on the same Table is
    /// `car_no + tables`.
    pub tables: u16,
    pub opened_at: i64,
    /// Who paid this account's rent; it goes back there when the car closes.
    pub payer: Pubkey,
}

/// A program-owned lamport holder, delegated once, that pays the commits as the fee payer.
#[account]
#[derive(InitSpace, Debug)]
pub struct Sponsor {
    pub bump: u8,
}

/// A delegated lamport reserve the operator empties into the Sponsor inside the rollup.
#[account]
#[derive(InitSpace, Debug)]
pub struct Fuel {
    pub bump: u8,
    pub n: u8,
}

/// The private half of a ride: the VRF output, what it decides and the Brakes pressed. A
/// rollup-only account behind a private permission with no member, created once per Table;
/// nobody reads it during a ride.
#[account]
#[derive(InitSpace, Debug)]
pub struct Vault {
    pub version: u8,
    pub bump: u8,
    pub table: Pubkey,
    /// The car the draw below belongs to.
    pub car_no: u64,
    pub ready: bool,
    pub draw: [u8; 32],
    pub crash_ms: u32,
    pub screw_at_ms: u32,
    pub bolt_at_ms: u32,
    pub spark_at_ms: u32,
    pub false_screws: [u32; 4],
    pub false_len: u8,
    /// The Brake schedule: every press adds one 5 s slow piece after the earlier ones, so its end
    /// (`slow_end_ms`) and the slow time in all (`slow_total_ms`) give the track position at any
    /// moment from the last press on (`ride::half_position`).
    pub slow_end_ms: u32,
    pub slow_total_ms: u32,
    /// Presses in the order they landed (ride ms, ascending) and their Table seats, for the
    /// refunds and the reveal at the end.
    pub press_count: u8,
    pub presses: [u32; PRESS_ROOM],
    pub press_seat: [u8; PRESS_ROOM],
    /// Room for the outage rule (ticket 08) and later.
    pub reserved: [u8; 128],
}

impl Vault {
    pub const VERSION: u8 = 1;

    pub fn blank(bump: u8, table: Pubkey) -> Self {
        Self {
            version: Self::VERSION,
            bump,
            table,
            car_no: 0,
            ready: false,
            draw: [0; 32],
            crash_ms: 0,
            screw_at_ms: 0,
            bolt_at_ms: 0,
            spark_at_ms: 0,
            false_screws: [0; 4],
            false_len: 0,
            slow_end_ms: 0,
            slow_total_ms: 0,
            press_count: 0,
            presses: [0; PRESS_ROOM],
            press_seat: [0; PRESS_ROOM],
            reserved: [0; 128],
        }
    }

    /// Forgets the last ride and binds the Vault to `car_no`.
    pub fn reset(&mut self, car_no: u64) {
        *self = Self::blank(self.bump, self.table);
        self.car_no = car_no;
    }

    /// Stores the draw and the ride it gives.
    pub fn store(&mut self, draw: [u8; 32]) {
        let r = crate::engine::ride(&draw);
        let falses = r.false_screws();
        self.draw = draw;
        self.crash_ms = r.crash_ms;
        self.screw_at_ms = r.screw_at_ms;
        self.bolt_at_ms = r.bolt_at_ms;
        self.spark_at_ms = r.spark_at_ms;
        self.false_screws = [0; 4];
        self.false_screws[..falses.len()].copy_from_slice(falses);
        self.false_len = falses.len() as u8;
        self.ready = true;
    }

    /// The Brakes pressed so far, ascending.
    pub fn pressed(&self) -> &[u32] {
        &self.presses[..usize::from(self.press_count).min(PRESS_ROOM)]
    }
}

/// One Table seat's own Brake, readable only by its Player (permission members: the Player's
/// wallet and seat key). Rollup-only, created the first time the seat index rides on its Table,
/// then zeroed and handed to each ride's Player by `bind_brake` (never closed while the Table
/// runs: closing publishes its past transactions).
#[account]
#[derive(InitSpace, Debug)]
pub struct BrakeSeat {
    pub version: u8,
    pub bump: u8,
    pub table: Pubkey,
    pub seat: u8,
    /// 1 once bound to `car_no`.
    pub bound: u8,
    pub car_no: u64,
    /// 1 once the Player has Braked on this ride, at ride ms `press_ms`.
    pub used: u8,
    pub press_ms: u32,
    pub reserved: [u8; 16],
}

impl BrakeSeat {
    pub const VERSION: u8 = 1;

    /// Whether the seat belongs to the ride of car `car_no`.
    pub fn bound_to(&self, car_no: u64) -> bool {
        self.bound == 1 && self.car_no == car_no
    }
}

/// One seat of a ride, public. Byte arrays only (alignment 1).
#[zero_copy]
#[derive(Debug, PartialEq, Eq)]
pub struct RideSeat {
    /// The seat's index in the core many-seat Match.
    pub seat: u8,
    /// 0 while aboard, else the Player's place in the Jump order (1 = first off).
    pub order: u8,
    pub flags: u8,
    pub reserved0: u8,
    /// Ride time of the Jump, real ms since the ride clock started.
    jump_ms: [u8; 4],
    /// Gemas of the entry the result refunds (written when the ride ends).
    refund: [u8; 8],
    /// The Player's core Account.
    pub account: [u8; 32],
    /// The seat key core recorded for this seat at join (seat-keys decision D4); zero when none
    /// is recorded, and then only the Player's wallet acts for the seat.
    pub signer: [u8; 32],
    /// After the ride: the Player's Brake, ride ms + 1 (0: no Brake). Zero during the ride.
    brake_at: [u8; 4],
    pub reserved: [u8; 4],
}

impl RideSeat {
    pub const LEN: usize = 88;

    pub fn jump_ms(&self) -> u32 {
        u32::from_le_bytes(self.jump_ms)
    }
    pub fn refund(&self) -> u64 {
        u64::from_le_bytes(self.refund)
    }
    pub fn set_jump(&mut self, order: u8, ms: u32) {
        self.order = order;
        self.jump_ms = ms.to_le_bytes();
    }
    pub fn set_refund(&mut self, gemas: u64) {
        self.refund = gemas.to_le_bytes();
    }
    pub fn aboard(&self) -> bool {
        self.order == 0
    }
    /// The revealed Brake: ride ms of the press, if the Player Braked.
    pub fn brake_ms(&self) -> Option<u32> {
        u32::from_le_bytes(self.brake_at).checked_sub(1)
    }
    pub fn reveal_brake(&mut self, ms: u32) {
        self.brake_at = ms.saturating_add(1).to_le_bytes();
    }
}

/// A Table: one ride at a time, delegated to the TEE validator and kept for months. Public: who
/// boarded and who is aboard, the Jump order, the Tell stage, the ride start, the entry (the
/// Gemas at stake are `entry * seated`) and the outcome. Read in place (no Borsh): a signal comes
/// several times a second and touches a few bytes. Byte arrays only (alignment 1, no padding).
#[account(zero_copy)]
#[derive(Debug)]
pub struct Table {
    pub version: u8,
    pub bump: u8,
    pub index: [u8; 2],
    pub phase: u8,
    pub outcome: u8,
    pub reason: u8,
    /// Tell stages passed (0 none, 1 screws, 2 bolt and panel, 3 sparks and creak).
    pub tell: u8,
    /// False screws passed.
    pub false_screws: u8,
    pub seated: u8,
    pub aboard: u8,
    pub jumps: u8,
    /// Table seats of the places, last Player off first (`NO_SEAT` when unused).
    pub places: [u8; 3],
    /// The Vault exists (`init_vault`).
    pub vault_ready: u8,
    /// A result waits for its first commit.
    pub dirty: u8,
    pub req_pending: u8,
    pub req_count: u8,
    pub commit_tries: u8,
    pub reserved0: [u8; 4],
    car_no: [u8; 8],
    /// The car this Table takes next (`car_no % tables == index`, strictly in order).
    next_car: [u8; 8],
    /// The Railcar `Car` account and its core Match.
    pub car: [u8; 32],
    pub tesoro_match: [u8; 32],
    entry: [u8; 8],
    vrf_nonce: [u8; 8],
    req_nonce: [u8; 8],
    req_slot: [u8; 8],
    /// Slot of `start_ride` (the draw window runs from here).
    started_slot: [u8; 8],
    /// The ride clock: slot and time of the draw's arrival.
    ride_slot: [u8; 8],
    ride_ts: [u8; 8],
    /// Ride ms and unix time at the end.
    over_ms: [u8; 4],
    over_at: [u8; 8],
    commit_at: [u8; 8],
    /// After the ride: the draw (with the seats' `brake_ms`, enough for the engine to recompute
    /// the ride), and `revealed` = 1. Zero during the ride.
    pub reveal_draw: [u8; 32],
    pub revealed: u8,
    /// Seats whose Brake seat is bound to this ride; no Brake counts until all are.
    pub brakes_bound: u8,
    /// Room for the outage rule (ticket 08).
    pub reserved: [u8; 94],
    pub seats: [RideSeat; 100],
}

macro_rules! le {
    ($get:ident, $set:ident, $field:ident, $t:ty) => {
        pub fn $get(&self) -> $t {
            <$t>::from_le_bytes(self.$field)
        }
        pub fn $set(&mut self, v: $t) {
            self.$field = v.to_le_bytes();
        }
    };
}

impl Table {
    pub const SPACE: usize = 8 + std::mem::size_of::<Table>();
    pub const VERSION: u8 = 1;

    le!(index, set_index, index, u16);
    le!(car_no, set_car_no, car_no, u64);
    le!(next_car, set_next_car, next_car, u64);
    le!(entry, set_entry, entry, u64);
    le!(vrf_nonce, set_vrf_nonce, vrf_nonce, u64);
    le!(req_nonce, set_req_nonce, req_nonce, u64);
    le!(req_slot, set_req_slot, req_slot, u64);
    le!(started_slot, set_started_slot, started_slot, u64);
    le!(ride_slot, set_ride_slot, ride_slot, u64);
    le!(ride_ts, set_ride_ts, ride_ts, i64);
    le!(over_ms, set_over_ms, over_ms, u32);
    le!(over_at, set_over_at, over_at, i64);
    le!(commit_at, set_commit_at, commit_at, i64);

    /// A new Table: idle, waiting for its first car (`car_no == index`).
    pub fn init(&mut self, bump: u8, index: u16) {
        *self = bytemuck::Zeroable::zeroed();
        self.version = Self::VERSION;
        self.bump = bump;
        self.set_index(index);
        self.set_next_car(u64::from(index));
        self.places = [NO_SEAT; 3];
    }

    /// Forgets the finished ride: what lasts is the Table's identity, its place in the car
    /// order, the request counter and the Vault's existence.
    pub fn reset(&mut self) {
        let (bump, index, next, nonce, vault) = (
            self.bump,
            self.index(),
            self.next_car(),
            self.vrf_nonce(),
            self.vault_ready,
        );
        self.init(bump, index);
        self.set_next_car(next);
        self.set_vrf_nonce(nonce);
        self.vault_ready = vault;
    }

    /// Ride ms at `slot` (0 before the clock started).
    pub fn ride_ms(&self, slot: u64) -> u32 {
        let ms = slot
            .saturating_sub(self.ride_slot())
            .saturating_mul(MS_PER_SLOT);
        u32::try_from(ms).unwrap_or(u32::MAX)
    }

    /// The first slot at which a ride whose Impact is `impact_ms` after the clock has hit the
    /// wall.
    pub fn impact_slot(&self, impact_ms: u32) -> u64 {
        self.ride_slot()
            .saturating_add(u64::from(impact_ms).div_ceil(MS_PER_SLOT))
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

const _: () = assert!(std::mem::size_of::<RideSeat>() == RideSeat::LEN);
const _: () = assert!(std::mem::align_of::<Table>() == 1);
// A Table is created by one system-program call, which caps an account at 10,240 bytes.
const _: () = assert!(Table::SPACE <= 10_240);
