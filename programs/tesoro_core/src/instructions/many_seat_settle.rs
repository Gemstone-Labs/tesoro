//! Settling a many-seat Match (ADR 0015, Railcar ticket 03): the Game's result, anyone's refund,
//! the permissionless chunks, room for a blocked winner, and closing the seats and the car.
//! The rules are in `ledger::many_seat::settle`.
//!
//! * **Start.** `settle_many_seat_match` (the Game's settle authority) freezes the result and the
//!   payout and writes the receipt `["settled", match]`; `refund_many_seat_match` (anyone) starts
//!   a refund once the car's refund time passed or the Game's build changed.
//! * **Chunks.** `many_seat_chunk` (anyone) runs up to [`MAX_SEAT_CHUNK_STEPS`] steps. Its
//!   remaining accounts, found by what they are, never by position: the seat pages and Pots of the
//!   seats it walks, the baskets and spills it credits, the books of the lines' Sources, and for
//!   fee cuts the Source and its Position (as `match_chunk`). `ManySeatRecord::ahead` lists them.
//! * **Room.** A winner whose stores are full stops the forfeits until anyone grows its stores or
//!   pays for its overflow record for this Match (`reserve_many_seat_room`).
//! * **Close.** `close_many_seat` closes one paid seat (Pot, mark, hold, open-Match count), then
//!   `close_many_seat_match` closes the car with its pages.

use crate::error::{seat_err, ManySeatError, MatchError, TesoroError};
use crate::instructions::matching::{check_store, judged_slot_at, lc_err};
use crate::instructions::overflow::reserve_record;
use crate::instructions::settlement::ChainSettlement;
use crate::instructions::ticket::{close_pot_account, release_room};
use crate::ledger;
use crate::ledger::lifecycle::{ChunkReport, LcResult, LifecycleError, Settlement, SettlementLine};
use crate::ledger::many_seat::{
    ManySeatResult, ManyStage, Seat, SeatCredits, Seats, Started, KIND_WIN, SEATS_PER_PAGE,
};
use crate::pots::*;
use crate::state::*;
use crate::storage::*;
use crate::util::*;
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use super::many_seat::{close_to, create_pda, mark_in};
pub use crate::ledger::many_seat::{ManySeatResult, SeatPlace, SeatRefund};

/// Steps one many-seat chunk takes at most. Measured worst case in `tests/many_seat/settle.rs`
/// (100 seats with Entry Tickets, fee cuts across many Sources); the client takes fewer when the
/// accounts of the next steps would pass a transaction's account limit.
pub const MAX_SEAT_CHUNK_STEPS: u8 = 8;

#[event]
pub struct ManySeatRunStarted {
    pub match_state: Pubkey,
    pub opener: Pubkey,
    pub n: u64,
    pub game: Pubkey,
    /// Head-to-head run codes: 0 win, 4 abandoned, 5 Game upgraded, 6 refunded by the Game.
    pub kind: u8,
    pub entry: u64,
    pub seated: u8,
    pub places: u8,
    /// Platform, Studio and Leaderboard Fees cut.
    pub fees: [u64; 3],
    /// The fees were capped by the forfeits (the win earns no Points).
    pub fees_capped: bool,
    pub refunded: u64,
    pub forfeited: u64,
    pub ts: i64,
}

/// One paid place of a many-seat win (first place too; only `MatchWon` carries Points).
#[event]
pub struct ManySeatPlaced {
    pub match_state: Pubkey,
    pub opener: Pubkey,
    pub n: u64,
    /// 1 = first place.
    pub place: u8,
    pub seat: u8,
    pub player: Pubkey,
    pub funder: Pubkey,
    pub share_bps: u16,
    /// Forfeited Gemas the place gets on top of its entry.
    pub won: u64,
}

/// The lines one many-seat chunk moved. `pot_side` of each record is the seat index; purpose
/// 0-2 fee, 3 entry back, 4 winnings, 5 early refund.
#[event]
pub struct ManySeatChunkDone {
    pub opener: Pubkey,
    pub n: u64,
    pub chunk_no: u32,
    pub first_step: u32,
    pub steps: u32,
    pub done: bool,
    pub blocked: bool,
    pub overflowed: u32,
    pub lines: Vec<SettlementLine>,
}

#[event]
pub struct ManySeatSettled {
    pub match_state: Pubkey,
    pub opener: Pubkey,
    pub n: u64,
    pub kind: u8,
    pub chunks: u32,
}

#[event]
pub struct ManySeatSeatClosed {
    pub match_state: Pubkey,
    pub seat: u8,
    pub player: Pubkey,
    pub left: u8,
}

// ---------------------------------------------------------------------------------------------
// Seats and Pots from the remaining accounts
// ---------------------------------------------------------------------------------------------

/// Offset of seat `slot` in a page's data.
fn seat_at(slot: usize) -> usize {
    DISC + 80 + slot * Seat::LEN
}

/// The car's seat pages among `infos` (this program's, of a page's size and discriminator, naming
/// this car; only core creates pages, at their PDA), by index, and every other account.
struct ChainSeats<'b, 'info> {
    pages: [Option<&'b AccountInfo<'info>>; ledger::many_seat::MAX_SEAT_PAGES as usize],
    infos: &'b [AccountInfo<'info>],
    pot: Option<(ledger::Key, OnchainPot<'b, 'info>)>,
}

impl<'b, 'info> ChainSeats<'b, 'info> {
    fn find(match_key: &Pubkey, infos: &'b [AccountInfo<'info>]) -> Result<Self> {
        let mut pages = [None; ledger::many_seat::MAX_SEAT_PAGES as usize];
        for info in infos {
            if info.owner != &crate::ID || info.data_len() != SeatPage::SPACE {
                continue;
            }
            let index = {
                let data = info.try_borrow_data()?;
                if data[..DISC] != *SeatPage::DISCRIMINATOR || data[DISC..DISC + 32] != match_key.to_bytes() {
                    continue;
                }
                data[DISC + 72]
            };
            require!(info.is_writable, TesoroError::NotWritable);
            if let Some(slot) = pages.get_mut(index as usize) {
                *slot = Some(info);
            }
        }
        Ok(Self {
            pages,
            infos,
            pot: None,
        })
    }

    fn page(&self, i: u8) -> LcResult<&'b AccountInfo<'info>> {
        self.pages
            .get(i as usize / SEATS_PER_PAGE)
            .copied()
            .flatten()
            .ok_or(LifecycleError::MissingAccount)
    }
}

impl<'b, 'info> Seats<AccountWindow<'b, 'info>> for ChainSeats<'b, 'info> {
    fn seat(&mut self, i: u8) -> LcResult<Seat> {
        let info = self.page(i)?;
        let data = info
            .try_borrow_data()
            .map_err(|_| LifecycleError::MissingAccount)?;
        let at = seat_at(i as usize % SEATS_PER_PAGE);
        Ok(*bytemuck::from_bytes::<Seat>(&data[at..at + Seat::LEN]))
    }

    fn set_seat(&mut self, i: u8, seat: &Seat) -> LcResult<()> {
        let info = self.page(i)?;
        let mut data = info
            .try_borrow_mut_data()
            .map_err(|_| LifecycleError::MissingAccount)?;
        let at = seat_at(i as usize % SEATS_PER_PAGE);
        data[at..at + Seat::LEN].copy_from_slice(bytemuck::bytes_of(seat));
        Ok(())
    }

    fn pot(&mut self, _i: u8, key: &ledger::Key) -> LcResult<&mut OnchainPot<'b, 'info>> {
        if self.pot.as_ref().is_none_or(|(k, _)| k != key) {
            self.pot = None;
            let info = self
                .infos
                .iter()
                .find(|i| i.key.to_bytes() == *key && i.is_writable)
                .ok_or(LifecycleError::MissingAccount)?;
            let (pot, _) = load_pot(info).map_err(|_| LifecycleError::MissingAccount)?;
            self.pot = Some((*key, pot));
        }
        Ok(&mut self.pot.as_mut().ok_or(LifecycleError::MissingAccount)?.1)
    }
}

impl<'info> SeatCredits for ChainSettlement<'info> {
    fn settlement(&mut self) -> &mut dyn Settlement {
        self
    }
    fn set_hold(&mut self, owner: &ledger::Key, slots: u32) {
        self.set_holds(&[RoomHold {
            account: *owner,
            left: slots,
        }]);
    }
    fn hold_of(&self, owner: &ledger::Key) -> u32 {
        ChainSettlement::hold_of(self, owner).unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------------------------

/// The settlement receipt's bytes, the same as `SettlementReceipt`'s Borsh form with
/// `RunKind::Win { winner: seat }` or the refund kind, written by hand so the head-to-head
/// serializer is not shared.
fn receipt_bytes(
    bump: u8,
    match_key: &Pubkey,
    payer: &Pubkey,
    id: &ledger::lifecycle::MatchId,
    (kind, winner): (u8, u8),
    at: i64,
) -> [u8; SettlementReceipt::SPACE] {
    let mut out = [0u8; SettlementReceipt::SPACE];
    out[..DISC].copy_from_slice(SettlementReceipt::DISCRIMINATOR);
    let mut i = DISC;
    out[i] = bump;
    i += 1;
    out[i..i + 32].copy_from_slice(match_key.as_ref());
    i += 32;
    out[i..i + 32].copy_from_slice(payer.as_ref());
    i += 32;
    out[i..i + 40].copy_from_slice(&id.seed());
    i += 40;
    out[i] = kind;
    i += 1;
    if kind == KIND_WIN {
        out[i] = winner;
        i += 1;
    }
    out[i..i + 8].copy_from_slice(&at.to_le_bytes());
    out
}

fn write_receipt<'info>(
    receipt: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    (match_key, bump): (&Pubkey, u8),
    id: &ledger::lifecycle::MatchId,
    kind: (u8, u8),
    at: i64,
) -> Result<()> {
    let b = [bump];
    create_pda(
        receipt,
        payer,
        system,
        &[ledger::lifecycle::RECEIPT_SEED, match_key.as_ref(), &b],
        SettlementReceipt::SPACE,
    )?;
    let bytes = receipt_bytes(bump, match_key, payer.key, id, kind, at);
    receipt.try_borrow_mut_data()?.copy_from_slice(&bytes);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

/// The Game's settle authority starts settling a Departed car with its result: the places and
/// refunds are written into the seats, the payout frozen, the receipt written, and for a win
/// `MatchWon` emitted (first place; its opponent for the Points cap is second place's Player, or
/// the unplaced seat that lost most). Refused once seven days passed since the car opened, or if
/// the Game's build changed (only a refund can start then).
///
/// `remaining_accounts`: every seat page of the car.
#[event_cpi]
#[derive(Accounts)]
pub struct SettleManySeatMatch<'info> {
    pub game_authority: Signer<'info>,
    /// Pays the receipt's rent (back to it 14 days later, `close_receipt`).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [GAME_SEED, match_state.load()?.inner.game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: the Game program the car was opened for; its loader state is read.
    #[account(address = Pubkey::new_from_array(match_state.load()?.inner.game))]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData; `judged_slot_at` derives and checks it.
    pub program_data: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [
            MATCH_SEED,
            match_state.load()?.inner.opener.as_ref(),
            &match_state.load()?.inner.n
        ],
        bump = match_state.load()?.bump
    )]
    pub match_state: AccountLoader<'info, ManySeatMatch>,
    /// CHECK: the receipt PDA, created here (it must not exist).
    #[account(mut, seeds = [ledger::lifecycle::RECEIPT_SEED, match_state.key().as_ref()], bump)]
    pub receipt: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn settle_many_seat_match<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleManySeatMatch<'info>>,
    result: ManySeatResult,
) -> Result<()> {
    let ts = now()?;
    let match_key = ctx.accounts.match_state.key();
    let slot = {
        let car = ctx.accounts.match_state.load()?;
        judged_slot_at(
            &ctx.accounts.game_record,
            (car.inner.deploy_slot(), car.listing_epoch()),
            &ctx.accounts.game_program.to_account_info(),
            &ctx.accounts.program_data.to_account_info(),
        )?
    };
    let lb = ctx.accounts.config.leaderboard_terms().bps;
    let authority = ctx.accounts.game_authority.key().to_bytes();
    let started = {
        let mut seats = ChainSeats::find(&match_key, ctx.remaining_accounts)?;
        let mut car = ctx.accounts.match_state.load_mut()?;
        car.inner
            .start_settle(ts, &authority, slot, lb, &result, &mut seats)
            .map_err(seat_err)?
    };
    let car = *ctx.accounts.match_state.load()?;
    let first_seat = car.inner.run.places().first().map_or(0, |p| p.seat);
    write_receipt(
        &ctx.accounts.receipt.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        (&match_key, ctx.bumps.receipt),
        &car.inner.id(),
        (started.kind, first_seat),
        ts,
    )?;
    emit_started(&ctx, &car, &started, ts)
}

fn emit_started<'info>(
    ctx: &Context<'_, '_, 'info, 'info, SettleManySeatMatch<'info>>,
    car: &ManySeatMatch,
    started: &Started,
    ts: i64,
) -> Result<()> {
    let rec = &car.inner;
    let run = &rec.run;
    let id = rec.id();
    let opener = Pubkey::new_from_array(id.opener);
    let match_state = ctx.accounts.match_state.key();
    if started.kind == KIND_WIN {
        if let Some(first) = run.places().first() {
            let listed = rec.meta().listed;
            emit_cpi!(MatchWon {
                opener,
                n: id.n,
                game: Pubkey::new_from_array(rec.game),
                entry: rec.entry(),
                player: Pubkey::new_from_array(first.player),
                funder: Pubkey::new_from_array(first.funder),
                points: if listed && !run.fees_capped() {
                    ledger::points_for_win(rec.entry())
                } else {
                    0
                },
                pool_fee: run.fees()[2],
                season: ledger::season_at(ts).unwrap_or(0),
                ts,
                loser: Pubkey::new_from_array(started.opponent),
                challenge: false,
                asset: rec.meta().asset,
                opened_at: rec.opened_at(),
            });
        }
    }
    emit_cpi!(ManySeatRunStarted {
        match_state,
        opener,
        n: id.n,
        game: Pubkey::new_from_array(rec.game),
        kind: started.kind,
        entry: rec.entry(),
        seated: rec.seated,
        places: run.places().len() as u8,
        fees: run.fees(),
        fees_capped: run.fees_capped(),
        refunded: started.refunded,
        forfeited: started.forfeited,
        ts,
    });
    for (k, p) in run.places().iter().enumerate() {
        emit_cpi!(ManySeatPlaced {
            match_state,
            opener,
            n: id.n,
            place: k as u8 + 1,
            seat: p.seat,
            player: Pubkey::new_from_array(p.player),
            funder: Pubkey::new_from_array(p.funder),
            share_bps: p.share_bps(),
            won: p.won(),
        });
    }
    Ok(())
}

/// Anyone starts refunding a Departed car once its refund time passed (a day after it left, or
/// seven days after it opened), or at once when the Game's build changed since it opened.
#[event_cpi]
#[derive(Accounts)]
pub struct RefundManySeatMatch<'info> {
    pub caller: Signer<'info>,
    /// Pays the receipt's rent (back to it 14 days later).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [GAME_SEED, match_state.load()?.inner.game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: the Game program the car was opened for; its loader state is read.
    #[account(address = Pubkey::new_from_array(match_state.load()?.inner.game))]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData; `judged_slot_at` derives and checks it.
    pub program_data: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [
            MATCH_SEED,
            match_state.load()?.inner.opener.as_ref(),
            &match_state.load()?.inner.n
        ],
        bump = match_state.load()?.bump
    )]
    pub match_state: AccountLoader<'info, ManySeatMatch>,
    /// CHECK: the receipt PDA, created here (it must not exist).
    #[account(mut, seeds = [ledger::lifecycle::RECEIPT_SEED, match_state.key().as_ref()], bump)]
    pub receipt: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn refund_many_seat_match(ctx: Context<RefundManySeatMatch>) -> Result<()> {
    let ts = now()?;
    let match_key = ctx.accounts.match_state.key();
    let kind = {
        let mut car = ctx.accounts.match_state.load_mut()?;
        let slot = judged_slot_at(
            &ctx.accounts.game_record,
            (car.inner.deploy_slot(), car.listing_epoch()),
            &ctx.accounts.game_program.to_account_info(),
            &ctx.accounts.program_data.to_account_info(),
        )?;
        car.inner.start_refund(ts, slot).map_err(seat_err)?
    };
    let car = *ctx.accounts.match_state.load()?;
    let rec = &car.inner;
    write_receipt(
        &ctx.accounts.receipt.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        (&match_key, ctx.bumps.receipt),
        &rec.id(),
        (kind, 0),
        ts,
    )?;
    let id = rec.id();
    emit_cpi!(ManySeatRunStarted {
        match_state: match_key,
        opener: Pubkey::new_from_array(id.opener),
        n: id.n,
        game: Pubkey::new_from_array(rec.game),
        kind,
        entry: rec.entry(),
        seated: rec.seated,
        places: 0,
        fees: [0; 3],
        fees_capped: false,
        refunded: 0,
        forfeited: 0,
        ts,
    });
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------------------------

/// Runs up to `max_steps` steps of a Settling or Refunding car. Anyone may call it, in any order,
/// as often as needed: progress is in the car's record and its Pots. See the module docs for the
/// remaining accounts.
#[event_cpi]
#[derive(Accounts)]
pub struct ManySeatChunk<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [
            MATCH_SEED,
            match_state.load()?.inner.opener.as_ref(),
            &match_state.load()?.inner.n
        ],
        bump = match_state.load()?.bump
    )]
    pub match_state: AccountLoader<'info, ManySeatMatch>,
}

pub(crate) fn many_seat_chunk<'info>(
    ctx: Context<'_, '_, 'info, 'info, ManySeatChunk<'info>>,
    max_steps: u8,
) -> Result<()> {
    let steps = max_steps.clamp(1, MAX_SEAT_CHUNK_STEPS) as u32;
    let match_key = ctx.accounts.match_state.key();
    let (report, overflowed, settled) = {
        let mut car = ctx.accounts.match_state.load_mut()?;
        let was_paid = car.inner.stage() == ManyStage::Paid;
        let mut seats = ChainSeats::find(&match_key, ctx.remaining_accounts)?;
        let mut settlement = ChainSettlement::load(ctx.remaining_accounts)?;
        settlement.set_match(&car.inner.id());
        let report = car
            .inner
            .chunk(&mut seats, &mut settlement, steps)
            .map_err(lc_err)?;
        drop(seats);
        let overflowed = settlement.overflowed();
        settlement.finish()?;
        let settled = (!was_paid && report.done).then(|| (car.inner.run.kind(), report.chunk_no));
        (report, overflowed, settled)
    };
    let id = ctx.accounts.match_state.load()?.inner.id();
    let opener = Pubkey::new_from_array(id.opener);
    emit_seat_lines(&ctx, opener, id.n, &report, overflowed)?;
    if let Some((kind, chunks)) = settled {
        emit_cpi!(ManySeatSettled {
            match_state: match_key,
            opener,
            n: id.n,
            kind,
            chunks,
        });
    }
    Ok(())
}

/// The chunk's line records in one event CPI: the event's Borsh header, then the records' bytes
/// as they are (`SettlementLine` is plain bytes; its Borsh form is the same).
#[inline(never)]
fn emit_seat_lines(
    ctx: &Context<ManySeatChunk>,
    opener: Pubkey,
    n: u64,
    report: &ChunkReport,
    overflowed: u32,
) -> Result<()> {
    use anchor_lang::solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    };
    let event = ManySeatChunkDone {
        opener,
        n,
        chunk_no: report.chunk_no,
        first_step: if report.lines.is_empty() {
            0
        } else {
            report.prior_steps.saturating_add(1)
        },
        steps: report.steps,
        done: report.done,
        blocked: report.blocked.is_some(),
        overflowed,
        lines: Vec::new(),
    };
    let mut data = Vec::with_capacity(
        96 + report.lines.len() * std::mem::size_of::<SettlementLine>(),
    );
    data.extend_from_slice(anchor_lang::event::EVENT_IX_TAG_LE);
    data.extend_from_slice(ManySeatChunkDone::DISCRIMINATOR);
    event
        .serialize(&mut data)
        .map_err(|_| anchor_lang::error::ErrorCode::InstructionDidNotSerialize)?;
    let len_at = data.len() - 4;
    data[len_at..].copy_from_slice(&(report.lines.len() as u32).to_le_bytes());
    data.extend_from_slice(bytemuck::cast_slice(&report.lines));
    let authority = ctx.accounts.event_authority.to_account_info();
    let bump = [ctx.bumps.event_authority];
    let ix = Instruction {
        program_id: crate::ID,
        accounts: vec![AccountMeta::new_readonly(*authority.key, true)],
        data,
    };
    invoke_signed(&ix, &[authority], &[&[b"__event_authority", &bump]])?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Room for a blocked winner
// ---------------------------------------------------------------------------------------------

/// Anyone pays to create or grow `account`'s overflow record for this car (rent back to the payer
/// when the record is claimed empty after the car closed), so a winnings or Studio Fee credit
/// that finds `account`'s stores full lands there. Only for an Account the run pays: a place's
/// Player or funder, or the outside studio.
#[derive(Accounts)]
#[instruction(account: Pubkey)]
pub struct ReserveManySeatRoom<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [
            MATCH_SEED,
            match_state.load()?.inner.opener.as_ref(),
            &match_state.load()?.inner.n
        ],
        bump = match_state.load()?.bump
    )]
    pub match_state: AccountLoader<'info, ManySeatMatch>,
    /// CHECK: `account`'s overflow record for this car, created or grown here.
    #[account(mut)]
    pub record: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn reserve_many_seat_room(
    ctx: Context<ReserveManySeatRoom>,
    account: Pubkey,
    lines: u32,
) -> Result<()> {
    let car = *ctx.accounts.match_state.load()?;
    let rec = &car.inner;
    require!(
        rec.stage() == ManyStage::Settling,
        ManySeatError::NotDeparted
    );
    let who = account.to_bytes();
    let paid = rec
        .run
        .places()
        .iter()
        .any(|p| p.player == who || p.funder == who)
        || rec.terms().studio_owner == Some(who);
    require!(paid, ManySeatError::NotPaidHere);
    reserve_record(
        std::slice::from_ref(&ctx.accounts.record.to_account_info()),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &account,
        OVERFLOW_MATCH,
        &rec.id().seed(),
        lines as usize,
    )
}

// ---------------------------------------------------------------------------------------------
// Close a seat
// ---------------------------------------------------------------------------------------------

/// Closes one seat of a paid car (anyone): the seat's empty Pot goes back to whoever paid it
/// (sponsor first), the hold left in the funder's spill is released, the Player's open-Match count
/// goes down and the seat mark's rent goes back to its payer. The car closes once every seat is.
#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct CloseManySeat<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [
            MATCH_SEED,
            match_state.load()?.inner.opener.as_ref(),
            &match_state.load()?.inner.n
        ],
        bump = match_state.load()?.bump
    )]
    pub match_state: AccountLoader<'info, ManySeatMatch>,
    #[account(
        mut,
        seeds = [
            SEAT_PAGE_SEED,
            match_state.key().as_ref(),
            &[seat / SEATS_PER_PAGE as u8]
        ],
        bump = seat_page.load()?.bump
    )]
    pub seat_page: AccountLoader<'info, SeatPage>,
    /// CHECK: the seat Player's mark in this car; checked against the seat, closed here.
    #[account(mut)]
    pub seat_mark: UncheckedAccount<'info>,
    /// CHECK: receives the mark's rent; checked against the mark.
    #[account(mut)]
    pub mark_payer: UncheckedAccount<'info>,
    #[account(mut)]
    pub player_counters: Account<'info, AccountCounters>,
    /// CHECK: the seat's Pot, checked against the seat.
    #[account(mut)]
    pub pot: UncheckedAccount<'info>,
    /// CHECK: whoever paid the Pot; checked against its head.
    #[account(mut)]
    pub pot_payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Option<Account<'info, SponsorState>>,
    /// CHECK: the funder's spill, needed when the seat still holds slots there; checked by seeds.
    #[account(mut)]
    pub funder_spill: Option<UncheckedAccount<'info>>,
}

pub(crate) fn close_many_seat(ctx: Context<CloseManySeat>, seat: u8) -> Result<()> {
    let match_key = ctx.accounts.match_state.key();
    let slot = seat as usize % SEATS_PER_PAGE;
    let mut s = {
        let p = ctx.accounts.seat_page.load()?;
        require!(
            p.match_key == match_key.to_bytes(),
            ManySeatError::WrongSeat
        );
        p.seats[slot]
    };
    let player = Pubkey::new_from_array(s.player());
    // the mark is the Player's in this car
    let mark_info = ctx.accounts.seat_mark.to_account_info();
    let (mark_key, _) = Pubkey::find_program_address(
        &[SEAT_SEED, match_key.as_ref(), player.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(mark_key, *mark_info.key, ManySeatError::WrongSeat);
    let mark_payer = {
        let data = mark_info.try_borrow_data()?;
        let mark = mark_in(&mark_info, &data)?;
        require!(
            mark.seat == seat && mark.returning == 0,
            ManySeatError::WrongSeat
        );
        mark.payer
    };
    require!(
        ctx.accounts.mark_payer.key.to_bytes() == mark_payer,
        TesoroError::InvalidAccount
    );
    require_keys_eq!(
        ctx.accounts.player_counters.key(),
        crate::instructions::matching::counters_pda(&player),
        ManySeatError::WrongSeat
    );
    let (seat_pot, hold, funder) = (s.pot(), s.hold(), Pubkey::new_from_array(s.funder()));
    let pot = ctx.accounts.pot.to_account_info();
    require!(pot.key.to_bytes() == seat_pot, ManySeatError::WrongSeat);
    // the seat: free, and the car one seat fewer
    let left = {
        let mut car = ctx.accounts.match_state.load_mut()?;
        car.inner.close_seat(&mut s).map_err(seat_err)?;
        car.inner.seated
    };
    ctx.accounts.seat_page.load_mut()?.seats[slot] = s;
    // the Pot is empty and goes back to its payer
    require!(pot_total(&pot)? == 0, MatchError::PotNotEmpty);
    let (_, extra) = load_pot(&pot)?;
    require_keys_eq!(
        extra.payer,
        *ctx.accounts.pot_payer.key,
        TesoroError::InvalidAccount
    );
    close_pot_account(
        &pot,
        &ctx.accounts.pot_payer.to_account_info(),
        ctx.accounts.sponsor.as_mut(),
        extra.sponsored_lamports,
    )?;
    if hold > 0 {
        let spill = ctx
            .accounts
            .funder_spill
            .as_ref()
            .ok_or_else(|| error!(MatchError::AccountMissing))?
            .to_account_info();
        check_store(&spill, SPILL_SEED, &funder)?;
        release_room(&spill, hold)?;
    }
    ctx.accounts.player_counters.open_matches =
        ctx.accounts.player_counters.open_matches.saturating_sub(1);
    close_to(&mark_info, &ctx.accounts.mark_payer.to_account_info())?;
    emit!(ManySeatSeatClosed {
        match_state: match_key,
        seat,
        player,
        left,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::lifecycle::{MatchId, Receipt, RunKind};

    #[test]
    fn the_receipt_is_written_byte_for_byte_as_its_borsh_form() {
        let id = MatchId {
            opener: [3; 32],
            n: 77,
        };
        let (m, p) = (Pubkey::new_from_array([5; 32]), Pubkey::new_from_array([6; 32]));
        for (kind, run) in [
            ((0u8, 42u8), RunKind::Win { winner: 42 }),
            ((4, 0), RunKind::Abandoned),
            ((5, 0), RunKind::GameUpgraded),
            ((6, 0), RunKind::ByGame),
        ] {
            let mut want = SettlementReceipt::DISCRIMINATOR.to_vec();
            SettlementReceipt {
                bump: 254,
                match_key: m,
                payer: p,
                receipt: Receipt {
                    id,
                    kind: run,
                    at: -9,
                },
            }
            .serialize(&mut want)
            .unwrap();
            want.resize(SettlementReceipt::SPACE, 0);
            assert_eq!(receipt_bytes(254, &m, &p, &id, kind, -9).to_vec(), want);
        }
    }

    #[test]
    fn a_seat_sits_where_the_page_layout_puts_it() {
        let mut page: SeatPage = bytemuck::Zeroable::zeroed();
        page.seats[3].player = [9; 32];
        let mut data = SeatPage::DISCRIMINATOR.to_vec();
        data.extend_from_slice(bytemuck::bytes_of(&page));
        let at = seat_at(3);
        let seat: &Seat = bytemuck::from_bytes(&data[at..at + Seat::LEN]);
        assert_eq!(seat.player, [9; 32]);
        assert_eq!(data[DISC + 72], page.index);
    }
}
