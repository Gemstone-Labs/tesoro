//! Block Puzzle as an on-chain Game of Tesoro: an async, head-to-head Match on a shared Seed.
//!
//! Flow (see docs/games/block-puzzle.md):
//!
//! 1. Base layer: two Players enter a `tesoro_core` Match for this Game (open + join).
//!    `start_session` binds a `Session` to it and commits to a future slot; `reveal_seed`
//!    derives the Seed from that slot's hash once it exists, so neither Player picks it, and
//!    asks `tesoro_core` to push the Match's refund deadline out to the submission deadline.
//! 2. `delegate_boards` sends both Players' `Board` accounts to the MagicBlock Private Ephemeral
//!    Rollup (TEE). `init_permission` makes each Board readable only by its own Player.
//! 3. Rollup: `begin_run` starts a Player's ~90 s clock, `play` submits moves that the program
//!    replays with the engine (the score is never reported by a client), `finish` ends the run.
//!    When both runs are closed, or the submission deadline has passed, anybody calls `seal` and
//!    `commit_boards`: Boards are committed and undelegated, which is the first moment a
//!    Player's moves become public.
//! 4. Base layer: `settle` (or `claim_timeout` for a Match nobody played) reads the committed
//!    Boards and settles the Pot through `tesoro_core` by CPI, signing as the Game's authority
//!    with the `["authority"]` PDA. Higher score wins, equal scores draw, a Player who never
//!    began forfeits.

pub mod engine;

use anchor_lang::{prelude::*, solana_program::hash::hashv, system_program};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi},
        structs::{
            EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED, TX_BALANCES_FLAG,
            TX_LOGS_FLAG, TX_MESSAGE_FLAG,
        },
    },
    anchor::{commit, delegate, ephemeral},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
};
use tesoro_core::instructions::MatchResult;
use tesoro_core::ledger::MatchStatus;
use tesoro_core::state::{MatchState, TesoroAccount};

declare_id!("5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj");

pub const SESSION_SEED: &[u8] = b"session";
pub const BOARD_SEED: &[u8] = b"board";
pub const AUTHORITY_SEED: &[u8] = b"authority";

/// Seconds of play from `begin_run`.
pub const PLAY_SECS: i64 = 90;
/// Extra seconds accepted for the last `play` transaction to land.
pub const PLAY_GRACE_SECS: i64 = 10;
/// From the Seed reveal to the point where a Player who has not begun forfeits.
pub const SUBMISSION_SECS: i64 = 24 * 60 * 60;
/// How long past the submission deadline `tesoro_core` keeps refunds closed, so a Game
/// settlement always wins the race against a plain refund.
pub const SETTLE_GRACE_SECS: i64 = 60 * 60;
/// The Seed comes from the hash of the first slot at or after `start slot + SEED_DELAY_SLOTS`.
pub const SEED_DELAY_SLOTS: u64 = 3;
/// If a committed slot is not revealed within this many slots, the commitment is renewed
/// (SlotHashes only keeps 512).
pub const SEED_EXPIRY_SLOTS: u64 = 400;
/// Moves per `play` transaction (compute bound).
pub const MAX_PLAY_BATCH: usize = 40;

const READ_FLAGS: u8 = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;
const MOVE_LOG: usize = engine::MAX_MOVES as usize;

#[error_code]
pub enum BlockPuzzleError {
    #[msg("account does not match")]
    InvalidAccount,
    #[msg("match is not an active Block Puzzle match")]
    InvalidMatch,
    #[msg("seed is already revealed")]
    SeedAlreadyRevealed,
    #[msg("seed is not revealed yet")]
    SeedNotReady,
    #[msg("committed slot has not passed yet")]
    SeedTooEarly,
    #[msg("slot hashes are malformed")]
    BadSlotHashes,
    #[msg("signer is not this board's player")]
    NotThePlayer,
    #[msg("board permission is not set up")]
    PermissionNotReady,
    #[msg("run already began")]
    AlreadyBegan,
    #[msg("run has not begun")]
    NotBegan,
    #[msg("run is finished")]
    RunClosed,
    #[msg("play window closed")]
    PlayWindowClosed,
    #[msg("submission deadline passed")]
    DeadlinePassed,
    #[msg("submit between 1 and 40 moves")]
    BadBatch,
    #[msg("illegal move")]
    IllegalMove,
    #[msg("board is not ready to seal yet")]
    NotSealable,
    #[msg("boards are not sealed")]
    NotSealed,
    #[msg("session already settled")]
    AlreadySettled,
    #[msg("deadline not reached")]
    NotExpired,
    #[msg("arithmetic overflow")]
    Overflow,
}

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize)]
pub struct MoveArg {
    pub piece: u16,
    pub x: u8,
    pub y: u8,
}

#[event]
pub struct SessionSettled {
    pub match_state: Pubkey,
    /// 0 = opener wins, 1 = joiner wins, 2 = draw.
    pub result: u8,
    pub scores: [u32; 2],
    pub forfeited: [bool; 2],
}

#[ephemeral]
#[program]
pub mod block_puzzle {
    use super::*;

    /// Base layer, anyone. Binds a Session and one Board per Player to an Active `tesoro_core`
    /// Match of this Game, and commits to a future slot for the Seed.
    pub fn start_session(ctx: Context<StartSession>) -> Result<()> {
        {
            let m = &ctx.accounts.match_state.inner;
            require!(
                m.game == crate::ID.to_bytes() && m.status == MatchStatus::Active,
                BlockPuzzleError::InvalidMatch
            );
            let b = m.b.as_ref().ok_or(BlockPuzzleError::InvalidMatch)?;
            require!(
                ctx.accounts.account_a.key().to_bytes() == m.a.player
                    && ctx.accounts.account_b.key().to_bytes() == b.player,
                BlockPuzzleError::InvalidAccount
            );
        }

        // Each Board pays the rent of its ephemeral permission from its own balance.
        let permission_rent =
            ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(1) as u32);
        for board in [&ctx.accounts.board_0, &ctx.accounts.board_1] {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: board.to_account_info(),
                    },
                ),
                permission_rent,
            )?;
        }

        let session_key = ctx.accounts.session.key();
        let players = [
            ctx.accounts.account_a.authority,
            ctx.accounts.account_b.authority,
        ];
        let (_, authority_bump) = Pubkey::find_program_address(&[AUTHORITY_SEED], &crate::ID);
        let session = &mut ctx.accounts.session;
        session.bump = ctx.bumps.session;
        session.authority_bump = authority_bump;
        session.match_state = ctx.accounts.match_state.key();
        session.players = players;
        session.commit_slot = Clock::get()?
            .slot
            .checked_add(SEED_DELAY_SLOTS)
            .ok_or(BlockPuzzleError::Overflow)?;

        let board_0 = &mut ctx.accounts.board_0;
        board_0.bump = ctx.bumps.board_0;
        board_0.session = session_key;
        board_0.seat = 0;
        board_0.player = players[0];
        let board_1 = &mut ctx.accounts.board_1;
        board_1.bump = ctx.bumps.board_1;
        board_1.session = session_key;
        board_1.seat = 1;
        board_1.player = players[1];
        Ok(())
    }

    /// Base layer, anyone. Once the committed slot is behind us, the Seed is the hash of that
    /// slot's SlotHashes entry mixed with the Match address. Nobody knew it when the Match was
    /// joined or when the slot was committed, and nobody can withhold it (anyone may call).
    /// Also sets the submission deadline and extends the `tesoro_core` refund deadline past it.
    pub fn reveal_seed(ctx: Context<RevealSeed>) -> Result<()> {
        let clock = Clock::get()?;
        let session = &mut ctx.accounts.session;
        require!(!session.seed_ready, BlockPuzzleError::SeedAlreadyRevealed);
        require!(
            clock.slot > session.commit_slot,
            BlockPuzzleError::SeedTooEarly
        );
        if clock.slot
            > session
                .commit_slot
                .checked_add(SEED_EXPIRY_SLOTS)
                .ok_or(BlockPuzzleError::Overflow)?
        {
            session.commit_slot = clock
                .slot
                .checked_add(SEED_DELAY_SLOTS)
                .ok_or(BlockPuzzleError::Overflow)?;
            return Ok(());
        }
        let hash = {
            let data = ctx.accounts.slot_hashes.try_borrow_data()?;
            slot_hash_at_or_after(&data, session.commit_slot)?
        };
        let digest = hashv(&[
            b"tesoro/block-puzzle/seed",
            session.match_state.as_ref(),
            &hash,
            &session.commit_slot.to_le_bytes(),
        ])
        .to_bytes();
        let mut word = [0u8; 8];
        word.copy_from_slice(&digest[..8]);
        let seed = u64::from_le_bytes(word);
        let deadline = clock
            .unix_timestamp
            .checked_add(SUBMISSION_SECS)
            .ok_or(BlockPuzzleError::Overflow)?;
        session.seed = seed;
        session.deadline = deadline;
        session.seed_ready = true;
        for board in [&mut ctx.accounts.board_0, &mut ctx.accounts.board_1] {
            board.seed = seed;
            board.deadline = deadline;
        }

        let refund_after = deadline
            .checked_add(SETTLE_GRACE_SECS)
            .ok_or(BlockPuzzleError::Overflow)?;
        let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, &[ctx.accounts.session.authority_bump]];
        let signer = &[authority_seeds];
        tesoro_core::cpi::extend_match_deadline(
            CpiContext::new_with_signer(
                ctx.accounts.tesoro_core_program.to_account_info(),
                tesoro_core::cpi::accounts::ExtendMatchDeadline {
                    game_authority: ctx.accounts.authority.to_account_info(),
                    config: ctx.accounts.config.to_account_info(),
                    match_state: ctx.accounts.match_state.to_account_info(),
                },
                signer,
            ),
            refund_after,
        )
    }

    /// Base layer, anyone. Delegates both Boards to the TEE validator (pass its identity).
    pub fn delegate_boards(ctx: Context<DelegateBoards>) -> Result<()> {
        let config = || DelegateConfig {
            validator: ctx.accounts.validator.as_ref().map(|v| v.key()),
            ..Default::default()
        };
        let session_key = ctx.accounts.session.key();
        ctx.accounts.delegate_board_0(
            &ctx.accounts.payer,
            &[BOARD_SEED, session_key.as_ref(), &[0]],
            config(),
        )?;
        ctx.accounts.delegate_board_1(
            &ctx.accounts.payer,
            &[BOARD_SEED, session_key.as_ref(), &[1]],
            config(),
        )?;
        Ok(())
    }

    /// Rollup, anyone. Creates the Board's permission: private, readable only by its Player.
    pub fn init_permission(ctx: Context<InitPermission>) -> Result<()> {
        let board_info = ctx.accounts.board.to_account_info();
        let seat = [ctx.accounts.board.seat];
        let bump = [ctx.accounts.board.bump];
        let session = ctx.accounts.board.session;
        let player = ctx.accounts.board.player;
        if ctx.accounts.permission.lamports() == 0 {
            CreateEphemeralPermissionCpi {
                payer: board_info.clone(),
                permissioned_account: board_info,
                permission: ctx.accounts.permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                args: EphemeralMembersArgs {
                    is_private: true,
                    members: vec![Member {
                        flags: READ_FLAGS,
                        pubkey: player,
                    }],
                },
            }
            .invoke_signed(&[&[BOARD_SEED, session.as_ref(), &seat, &bump]])?;
        }
        ctx.accounts.board.permission_ready = true;
        Ok(())
    }

    /// Rollup, the Player. Starts the Player's clock.
    pub fn begin_run(ctx: Context<PlayerAction>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let board = &mut ctx.accounts.board;
        require!(board.permission_ready, BlockPuzzleError::PermissionNotReady);
        require!(board.started_at == 0, BlockPuzzleError::AlreadyBegan);
        require!(now < board.deadline, BlockPuzzleError::DeadlinePassed);
        board.started_at = now;
        Ok(())
    }

    /// Rollup, the Player. Replays `moves` on the Board with the engine. An illegal move
    /// rejects the whole transaction. The run ends when the engine reports game over.
    pub fn play(ctx: Context<PlayerAction>, moves: Vec<MoveArg>) -> Result<()> {
        require!(
            !moves.is_empty() && moves.len() <= MAX_PLAY_BATCH,
            BlockPuzzleError::BadBatch
        );
        let now = Clock::get()?.unix_timestamp;
        let board = &mut ctx.accounts.board;
        require!(board.started_at > 0, BlockPuzzleError::NotBegan);
        require!(!board.finished, BlockPuzzleError::RunClosed);
        require!(now < board.deadline, BlockPuzzleError::DeadlinePassed);
        require!(
            now <= board.play_ends()?,
            BlockPuzzleError::PlayWindowClosed
        );
        let mut state = board.engine_state();
        let mut index = usize::from(state.moves);
        for m in moves {
            state
                .apply(engine::Move {
                    piece: m.piece,
                    x: m.x,
                    y: m.y,
                })
                .map_err(|e| {
                    msg!("illegal move {}: {}", index, e.name());
                    error!(BlockPuzzleError::IllegalMove)
                })?;
            let slot = board
                .log
                .get_mut(index)
                .ok_or(BlockPuzzleError::IllegalMove)?;
            *slot = pack(m);
            index = index.checked_add(1).ok_or(BlockPuzzleError::Overflow)?;
        }
        board.store_engine_state(&state);
        if state.over {
            board.finished = true;
        }
        Ok(())
    }

    /// Rollup, the Player. Ends the run early; the score is what has been replayed.
    pub fn finish(ctx: Context<PlayerAction>) -> Result<()> {
        let board = &mut ctx.accounts.board;
        require!(board.started_at > 0, BlockPuzzleError::NotBegan);
        board.finished = true;
        Ok(())
    }

    /// Rollup, anyone. Marks both Boards final: allowed only when both runs are closed
    /// (finished, game over, or their window elapsed) or the submission deadline passed, so
    /// nobody's moves are exposed while the other Player can still play. The permissionless
    /// timeout: a Player who never began simply forfeits.
    pub fn seal(ctx: Context<Seal>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        for board in [&mut ctx.accounts.board_0, &mut ctx.accounts.board_1] {
            require!(
                board.run_closed(now)? || now >= board.deadline,
                BlockPuzzleError::NotSealable
            );
        }
        ctx.accounts.board_0.sealed = true;
        ctx.accounts.board_1.sealed = true;
        Ok(())
    }

    /// Rollup, anyone. Closes both permissions and commits + undelegates the sealed Boards to
    /// the base layer, where their contents become public.
    pub fn commit_boards(ctx: Context<CommitBoards>) -> Result<()> {
        require!(
            ctx.accounts.board_0.sealed && ctx.accounts.board_1.sealed,
            BlockPuzzleError::NotSealed
        );
        let session = ctx.accounts.board_0.session;
        let boards = [
            (
                ctx.accounts.board_0.to_account_info(),
                &ctx.accounts.permission_0,
                [ctx.accounts.board_0.seat],
                [ctx.accounts.board_0.bump],
            ),
            (
                ctx.accounts.board_1.to_account_info(),
                &ctx.accounts.permission_1,
                [ctx.accounts.board_1.seat],
                [ctx.accounts.board_1.bump],
            ),
        ];
        for (info, permission, seat, bump) in boards {
            CloseEphemeralPermissionCpi {
                payer: info.clone(),
                permissioned_account: info.clone(),
                permission: permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                authority: info,
                authority_is_signer: false,
            }
            .invoke_signed(&[&[BOARD_SEED, session.as_ref(), &seat, &bump]])?;
        }
        ctx.accounts.board_0.exit(&ID)?;
        ctx.accounts.board_1.exit(&ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[
            ctx.accounts.board_0.to_account_info(),
            ctx.accounts.board_1.to_account_info(),
        ])
        .build_and_invoke()?;
        Ok(())
    }

    /// Base layer, anyone. Settles the Pot through `tesoro_core` from the committed Boards.
    /// `remaining_accounts` are the payout accounts as for `tesoro_core::settle_match`.
    pub fn settle<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>) -> Result<()> {
        let a = &ctx.accounts.board_0;
        let b = &ctx.accounts.board_1;
        require!(a.sealed && b.sealed, BlockPuzzleError::NotSealed);
        let forfeited = [a.started_at == 0, b.started_at == 0];
        let scores = [a.score, b.score];
        let result = decide(forfeited, scores);
        finalize(ctx, result, scores, forfeited)
    }

    /// Base layer, anyone, after the submission deadline. For a Match whose Boards were never
    /// delegated (nobody played): both Players forfeit, so both entries are refunded. A Board
    /// that is still delegated cannot be claimed here; `seal` + `commit_boards` come first.
    pub fn claim_timeout<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>) -> Result<()> {
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.session.deadline,
            BlockPuzzleError::NotExpired
        );
        require!(
            ctx.accounts.session.seed_ready,
            BlockPuzzleError::SeedNotReady
        );
        let a = &ctx.accounts.board_0;
        let b = &ctx.accounts.board_1;
        require!(
            !a.sealed && !b.sealed && a.started_at == 0 && b.started_at == 0,
            BlockPuzzleError::NotExpired
        );
        finalize(ctx, MatchResult::Draw, [0, 0], [true, true])
    }
}

fn decide(forfeited: [bool; 2], scores: [u32; 2]) -> MatchResult {
    match forfeited {
        [true, true] => MatchResult::Draw,
        [true, false] => MatchResult::Joiner,
        [false, true] => MatchResult::Opener,
        [false, false] => match scores[0].cmp(&scores[1]) {
            core::cmp::Ordering::Greater => MatchResult::Opener,
            core::cmp::Ordering::Less => MatchResult::Joiner,
            core::cmp::Ordering::Equal => MatchResult::Draw,
        },
    }
}

fn finalize<'info>(
    ctx: Context<'_, '_, 'info, 'info, Settle<'info>>,
    result: MatchResult,
    scores: [u32; 2],
    forfeited: [bool; 2],
) -> Result<()> {
    let code = match result {
        MatchResult::Opener => 0,
        MatchResult::Joiner => 1,
        MatchResult::Draw => 2,
    };
    let session = &mut ctx.accounts.session;
    require!(!session.settled, BlockPuzzleError::AlreadySettled);
    session.settled = true;
    session.result = code;
    session.scores = scores;
    let match_key = session.match_state;
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, &[session.authority_bump]];
    let signer = &[authority_seeds];
    tesoro_core::cpi::settle_match(
        CpiContext::new_with_signer(
            ctx.accounts.tesoro_core_program.to_account_info(),
            tesoro_core::cpi::accounts::SettleMatch {
                game_authority: ctx.accounts.authority.to_account_info(),
                config: ctx.accounts.config.to_account_info(),
                match_state: ctx.accounts.match_state.to_account_info(),
            },
            signer,
        )
        .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
        result,
    )?;
    emit!(SessionSettled {
        match_state: match_key,
        result: code,
        scores,
        forfeited,
    });
    Ok(())
}

fn pack(m: MoveArg) -> u32 {
    u32::from(m.piece) | (u32::from(m.x) << 16) | (u32::from(m.y) << 24)
}

/// Hash of the first SlotHashes entry whose slot is `>= slot`. Entries are sorted by slot,
/// newest first, each `(slot: u64, hash: [u8; 32])` after a `u64` length.
fn slot_hash_at_or_after(data: &[u8], slot: u64) -> Result<[u8; 32]> {
    const ENTRY: usize = 40;
    let len_bytes: [u8; 8] = data
        .get(..8)
        .and_then(|s| s.try_into().ok())
        .ok_or(BlockPuzzleError::BadSlotHashes)?;
    let len = usize::try_from(u64::from_le_bytes(len_bytes))
        .map_err(|_| error!(BlockPuzzleError::BadSlotHashes))?;
    let entry = |i: usize| -> Result<(u64, [u8; 32])> {
        let start = i
            .checked_mul(ENTRY)
            .and_then(|o| o.checked_add(8))
            .ok_or(BlockPuzzleError::BadSlotHashes)?;
        let raw = data
            .get(start..start + ENTRY)
            .ok_or(BlockPuzzleError::BadSlotHashes)?;
        let mut s = [0u8; 8];
        s.copy_from_slice(&raw[..8]);
        let mut h = [0u8; 32];
        h.copy_from_slice(&raw[8..]);
        Ok((u64::from_le_bytes(s), h))
    };
    // Descending slots: find the last index whose slot is still >= `slot`.
    let (mut lo, mut hi) = (0usize, len);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if entry(mid)?.0 >= slot {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let idx = lo.checked_sub(1).ok_or(BlockPuzzleError::SeedTooEarly)?;
    Ok(entry(idx)?.1)
}

#[derive(Accounts)]
pub struct StartSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(owner = tesoro_core::ID)]
    pub match_state: Account<'info, MatchState>,
    #[account(owner = tesoro_core::ID)]
    pub account_a: Account<'info, TesoroAccount>,
    #[account(owner = tesoro_core::ID)]
    pub account_b: Account<'info, TesoroAccount>,
    #[account(
        init, payer = payer, space = 8 + Session::INIT_SPACE,
        seeds = [SESSION_SEED, match_state.key().as_ref()], bump
    )]
    pub session: Account<'info, Session>,
    #[account(
        init, payer = payer, space = 8 + Board::INIT_SPACE,
        seeds = [BOARD_SEED, session.key().as_ref(), &[0]], bump
    )]
    pub board_0: Account<'info, Board>,
    #[account(
        init, payer = payer, space = 8 + Board::INIT_SPACE,
        seeds = [BOARD_SEED, session.key().as_ref(), &[1]], bump
    )]
    pub board_1: Account<'info, Board>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealSeed<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [SESSION_SEED, session.match_state.as_ref()], bump = session.bump
    )]
    pub session: Account<'info, Session>,
    #[account(
        mut,
        seeds = [BOARD_SEED, session.key().as_ref(), &[0]], bump = board_0.bump
    )]
    pub board_0: Account<'info, Board>,
    #[account(
        mut,
        seeds = [BOARD_SEED, session.key().as_ref(), &[1]], bump = board_1.bump
    )]
    pub board_1: Account<'info, Board>,
    /// CHECK: SlotHashes sysvar
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    /// CHECK: the Game's authority PDA; signs the `tesoro_core` CPI
    #[account(seeds = [AUTHORITY_SEED], bump = session.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: `tesoro_core` config, validated by `tesoro_core`
    #[account(owner = tesoro_core::ID)]
    pub config: UncheckedAccount<'info>,
    /// CHECK: the Match, bound to the Session, validated by `tesoro_core`
    #[account(mut, owner = tesoro_core::ID, address = session.match_state)]
    pub match_state: UncheckedAccount<'info>,
    pub tesoro_core_program: Program<'info, tesoro_core::program::TesoroCore>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateBoards<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [SESSION_SEED, session.match_state.as_ref()], bump = session.bump,
        constraint = session.seed_ready @ BlockPuzzleError::SeedNotReady
    )]
    pub session: Account<'info, Session>,
    /// CHECK: Board PDA (seat 0) to delegate
    #[account(mut, del, seeds = [BOARD_SEED, session.key().as_ref(), &[0]], bump)]
    pub board_0: AccountInfo<'info>,
    /// CHECK: Board PDA (seat 1) to delegate
    #[account(mut, del, seeds = [BOARD_SEED, session.key().as_ref(), &[1]], bump)]
    pub board_1: AccountInfo<'info>,
    /// CHECK: TEE validator identity, checked by the delegation program
    pub validator: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
pub struct InitPermission<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [BOARD_SEED, board.session.as_ref(), &[board.seat]], bump = board.bump
    )]
    pub board: Account<'info, Board>,
    /// CHECK: permission PDA of the Board, verified by the permission program
    #[account(mut, seeds = [PERMISSION_SEED, board.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Permission Program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: Magic Program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PlayerAction<'info> {
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [BOARD_SEED, board.session.as_ref(), &[board.seat]], bump = board.bump,
        has_one = player @ BlockPuzzleError::NotThePlayer
    )]
    pub board: Account<'info, Board>,
}

#[derive(Accounts)]
pub struct Seal<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [BOARD_SEED, board_0.session.as_ref(), &[0]], bump = board_0.bump
    )]
    pub board_0: Account<'info, Board>,
    #[account(
        mut,
        seeds = [BOARD_SEED, board_0.session.as_ref(), &[1]], bump = board_1.bump
    )]
    pub board_1: Account<'info, Board>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitBoards<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [BOARD_SEED, board_0.session.as_ref(), &[0]], bump = board_0.bump
    )]
    pub board_0: Account<'info, Board>,
    #[account(
        mut,
        seeds = [BOARD_SEED, board_0.session.as_ref(), &[1]], bump = board_1.bump
    )]
    pub board_1: Account<'info, Board>,
    /// CHECK: permission PDA of Board 0
    #[account(mut, seeds = [PERMISSION_SEED, board_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission_0: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Board 1
    #[account(mut, seeds = [PERMISSION_SEED, board_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission_1: UncheckedAccount<'info>,
    /// CHECK: Permission Program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
}

/// `remaining_accounts`: per payout, in `tesoro_core`'s order, the recipient's `TesoroAccount`
/// then its Holding of the payout's Source.
#[derive(Accounts)]
pub struct Settle<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [SESSION_SEED, session.match_state.as_ref()], bump = session.bump
    )]
    pub session: Account<'info, Session>,
    #[account(
        seeds = [BOARD_SEED, session.key().as_ref(), &[0]], bump = board_0.bump
    )]
    pub board_0: Account<'info, Board>,
    #[account(
        seeds = [BOARD_SEED, session.key().as_ref(), &[1]], bump = board_1.bump
    )]
    pub board_1: Account<'info, Board>,
    /// CHECK: the Game's authority PDA; signs the `tesoro_core` CPI
    #[account(seeds = [AUTHORITY_SEED], bump = session.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: `tesoro_core` config, validated by `tesoro_core`
    #[account(owner = tesoro_core::ID)]
    pub config: UncheckedAccount<'info>,
    /// CHECK: the Match, bound to the Session, validated by `tesoro_core`
    #[account(mut, owner = tesoro_core::ID, address = session.match_state)]
    pub match_state: UncheckedAccount<'info>,
    pub tesoro_core_program: Program<'info, tesoro_core::program::TesoroCore>,
}

#[account]
#[derive(InitSpace)]
pub struct Session {
    pub bump: u8,
    pub authority_bump: u8,
    pub match_state: Pubkey,
    /// Wallets of the seats: 0 opened the `tesoro_core` Match, 1 joined.
    pub players: [Pubkey; 2],
    pub commit_slot: u64,
    pub seed_ready: bool,
    pub seed: u64,
    /// End of the submission window: Players who have not begun by then forfeit.
    pub deadline: i64,
    pub settled: bool,
    /// 0 = opener wins, 1 = joiner wins, 2 = draw.
    pub result: u8,
    pub scores: [u32; 2],
}

/// One Player's run. Private in the rollup; public once committed after both runs close.
#[account]
#[derive(InitSpace)]
pub struct Board {
    pub bump: u8,
    pub session: Pubkey,
    pub seat: u8,
    pub player: Pubkey,
    pub seed: u64,
    pub deadline: i64,
    pub permission_ready: bool,
    pub started_at: i64,
    pub finished: bool,
    pub sealed: bool,
    pub occ: u64,
    pub gems: u64,
    pub score: u32,
    pub moves: u16,
    pub used: u8,
    pub over: bool,
    /// Packed moves: `piece | x << 16 | y << 24`. Lets anyone re-verify the score.
    pub log: [u32; MOVE_LOG],
}

impl Board {
    fn play_ends(&self) -> Result<i64> {
        self.started_at
            .checked_add(PLAY_SECS)
            .and_then(|t| t.checked_add(PLAY_GRACE_SECS))
            .ok_or_else(|| error!(BlockPuzzleError::Overflow))
    }

    /// Finished, game over, or began and out of time.
    fn run_closed(&self, now: i64) -> Result<bool> {
        Ok(self.finished || self.over || (self.started_at > 0 && now > self.play_ends()?))
    }

    fn engine_state(&self) -> engine::State {
        engine::State {
            seed: self.seed,
            occ: self.occ,
            gems: self.gems,
            score: self.score,
            moves: self.moves,
            used: self.used,
            over: self.over,
        }
    }

    fn store_engine_state(&mut self, s: &engine::State) {
        self.occ = s.occ;
        self.gems = s.gems;
        self.score = s.score;
        self.moves = s.moves;
        self.used = s.used;
        self.over = s.over;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(entries: &[(u64, u8)]) -> Vec<u8> {
        let mut d = (entries.len() as u64).to_le_bytes().to_vec();
        for (slot, fill) in entries {
            d.extend_from_slice(&slot.to_le_bytes());
            d.extend_from_slice(&[*fill; 32]);
        }
        d
    }

    #[test]
    fn slot_hash_picks_first_slot_at_or_after() {
        let d = data(&[(10, 1), (9, 2), (7, 3), (6, 4)]);
        assert_eq!(slot_hash_at_or_after(&d, 9).unwrap()[0], 2);
        assert_eq!(slot_hash_at_or_after(&d, 8).unwrap()[0], 2);
        assert_eq!(slot_hash_at_or_after(&d, 7).unwrap()[0], 3);
        assert_eq!(slot_hash_at_or_after(&d, 1).unwrap()[0], 4);
        assert_eq!(slot_hash_at_or_after(&d, 10).unwrap()[0], 1);
        assert!(slot_hash_at_or_after(&d, 11).is_err());
        assert!(slot_hash_at_or_after(&[], 1).is_err());
    }

    #[test]
    fn decide_forfeit_and_ties() {
        assert!(matches!(decide([false, false], [5, 5]), MatchResult::Draw));
        assert!(matches!(
            decide([false, false], [6, 5]),
            MatchResult::Opener
        ));
        assert!(matches!(
            decide([false, true], [0, 99]),
            MatchResult::Opener
        ));
        assert!(matches!(decide([true, false], [9, 0]), MatchResult::Joiner));
        assert!(matches!(decide([true, true], [0, 0]), MatchResult::Draw));
    }
}
