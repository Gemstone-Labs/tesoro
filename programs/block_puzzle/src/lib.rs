//! Block Puzzle as an on-chain Game of Tesoro: an async, head-to-head Match on a shared Seed.
//!
//! Flow (see docs/games/block-puzzle.md):
//!
//! 1. Base layer: the opener enters a `tesoro_core` Match for this Game (`open_match`) and
//!    `open_session` binds a `Session`, the opener's `Board` and a `SeedVault` to it. The Match is
//!    still Open: the opener can play before anyone is paired.
//! 2. `delegate_opener` sends the opener's Board and the SeedVault to the MagicBlock Private
//!    Ephemeral Rollup (TEE). `init_permission` makes a Board readable only by its Player;
//!    `init_vault_permission` makes the SeedVault readable by nobody. `request_seed` asks the VRF
//!    oracle (inside the TEE) for randomness, which the callback writes only into the SeedVault.
//! 3. Rollup: `begin_run` copies the Seed from the SeedVault into the Player's own Board and starts
//!    that Player's ~90 s clock, `play` submits moves that the program replays with the engine (the
//!    score is never reported by a client), `finish` ends the run.
//! 4. Base layer: when a second Player joins the Match (`join_match`), `join_session` creates their
//!    Board and pushes the Match's refund deadline out past the submission deadline;
//!    `delegate_joiner` sends it to the rollup, where they play the same Seed later.
//! 5. When both runs are closed, or the deadlines have passed, anybody calls `seal` and
//!    `commit_boards`: Boards are committed and undelegated, the first moment a Player's moves
//!    become public. `settle` (or `claim_timeout` for a Match nobody played) reads the committed
//!    Boards and settles the Pot through `tesoro_core` by CPI, signing as the Game's authority with
//!    the `["authority"]` PDA. Higher score wins, equal scores draw, a Player who never began
//!    forfeits. A Match nobody joins is refunded by `tesoro_core::refund_match`.

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
    anchor::{commit, delegate, ephemeral, vrf, vrf_callback},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
    vrf::{
        instructions::{create_request_scoped_randomness_ix, RequestRandomnessParams},
        types::SerializableAccountMeta,
    },
};
use tesoro_core::instructions::MatchResult;
use tesoro_core::ledger::MatchStatus;
use tesoro_core::state::{MatchState, TesoroAccount};

declare_id!("5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj");

pub const SESSION_SEED: &[u8] = b"session";
pub const BOARD_SEED: &[u8] = b"board";
pub const VAULT_SEED: &[u8] = b"vault";
pub const AUTHORITY_SEED: &[u8] = b"authority";

/// Identity of MagicBlock's TEE validator (devnet). Delegation is pinned to it: the validator a
/// delegation names is the only key that can commit state back, so a caller-chosen validator (or
/// none, which the delegation program reads as the public default validator) would let a Player
/// forge a Board or read the SeedVault outside the TEE.
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

/// Seconds of play from `begin_run`.
pub const PLAY_SECS: i64 = 90;
/// Extra seconds accepted for the last `play` transaction to land.
pub const PLAY_GRACE_SECS: i64 = 10;
/// From the second Player joining to the point where a Player who has not begun forfeits.
pub const SUBMISSION_SECS: i64 = 24 * 60 * 60;
/// How long past the submission deadline `tesoro_core` keeps refunds closed, so a Game
/// settlement always wins the race against a plain refund.
pub const SETTLE_GRACE_SECS: i64 = 60 * 60;
/// Moves per `play` transaction (compute bound).
pub const MAX_PLAY_BATCH: usize = 40;

const READ_FLAGS: u8 = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;
const MOVE_LOG: usize = engine::MAX_MOVES as usize;

#[error_code]
pub enum BlockPuzzleError {
    #[msg("account does not match")]
    InvalidAccount,
    #[msg("match is not a Block Puzzle match in the right state")]
    InvalidMatch,
    #[msg("seed is already drawn")]
    SeedAlreadyDrawn,
    #[msg("seed is not drawn yet")]
    SeedNotReady,
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
    #[msg("a second Player already joined this session")]
    AlreadyJoined,
    #[msg("no second Player has joined this session")]
    NotJoined,
    #[msg("delegation must name the TEE validator")]
    InvalidValidator,
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

/// The Seed for a Match from the VRF output. Only ever computed inside the rollup.
pub fn derive_seed(match_state: &Pubkey, randomness: &[u8; 32]) -> u64 {
    let digest = hashv(&[
        b"tesoro/block-puzzle/seed",
        match_state.as_ref(),
        randomness,
    ])
    .to_bytes();
    let mut word = [0u8; 8];
    word.copy_from_slice(&digest[..8]);
    u64::from_le_bytes(word)
}

#[ephemeral]
#[program]
pub mod block_puzzle {
    use super::*;

    /// Base layer, anyone, right after `tesoro_core::open_match`. Binds a Session, the opener's
    /// Board and a SeedVault to the Match. The opener may play before anybody joins. A Match that
    /// somebody joined before its Session existed (`tesoro_core::join_match` cannot require one)
    /// is still bound while its refund window is open, and `join_session` follows.
    ///
    /// The opener's Board deadline is the Queue window's end plus `SUBMISSION_SECS`, which is never
    /// earlier than the joiner's (`join + SUBMISSION_SECS`, joins happen inside the window). Joining
    /// in the last second of the window therefore cannot forfeit an opener who has not begun: the
    /// opener keeps the same time to play as the joiner.
    pub fn open_session(ctx: Context<OpenSession>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let opener_deadline = {
            let m = &ctx.accounts.match_state.inner;
            require!(
                m.game == crate::ID.to_bytes()
                    && matches!(m.status, MatchStatus::Open | MatchStatus::Active),
                BlockPuzzleError::InvalidMatch
            );
            require!(
                ctx.accounts.account_a.key().to_bytes() == m.a.player,
                BlockPuzzleError::InvalidAccount
            );
            require!(now < m.deadline, BlockPuzzleError::DeadlinePassed);
            m.deadline
                .max(now)
                .checked_add(SUBMISSION_SECS)
                .ok_or(BlockPuzzleError::Overflow)?
        };

        // Each delegated account pays the rent of its ephemeral permission from its own balance.
        prefund_permission(
            &ctx.accounts.payer,
            &ctx.accounts.board_0.to_account_info(),
            &ctx.accounts.system_program,
            1,
        )?;
        prefund_permission(
            &ctx.accounts.payer,
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.system_program,
            0,
        )?;

        let session_key = ctx.accounts.session.key();
        let player = ctx.accounts.account_a.authority;
        let (_, authority_bump) = Pubkey::find_program_address(&[AUTHORITY_SEED], &crate::ID);
        let session = &mut ctx.accounts.session;
        session.bump = ctx.bumps.session;
        session.authority_bump = authority_bump;
        session.match_state = ctx.accounts.match_state.key();
        session.players = [player, Pubkey::default()];
        session.opener_deadline = opener_deadline;

        let board_0 = &mut ctx.accounts.board_0;
        board_0.bump = ctx.bumps.board_0;
        board_0.session = session_key;
        board_0.seat = 0;
        board_0.player = player;
        board_0.deadline = opener_deadline;

        let vault = &mut ctx.accounts.vault;
        vault.bump = ctx.bumps.vault;
        vault.session = session_key;
        vault.match_state = ctx.accounts.match_state.key();
        Ok(())
    }

    /// Base layer, anyone, right after `tesoro_core::join_match`. Creates the joiner's Board,
    /// sets their submission deadline and asks `tesoro_core` to push the Match's refund deadline
    /// out past it.
    pub fn join_session(ctx: Context<JoinSession>) -> Result<()> {
        require!(
            !ctx.accounts.session.joined,
            BlockPuzzleError::AlreadyJoined
        );
        {
            let m = &ctx.accounts.match_state.inner;
            require!(
                m.game == crate::ID.to_bytes() && m.status == MatchStatus::Active,
                BlockPuzzleError::InvalidMatch
            );
            let b = m.b.as_ref().ok_or(BlockPuzzleError::InvalidMatch)?;
            require!(
                ctx.accounts.account_b.key().to_bytes() == b.player,
                BlockPuzzleError::InvalidAccount
            );
        }
        prefund_permission(
            &ctx.accounts.payer,
            &ctx.accounts.board_1.to_account_info(),
            &ctx.accounts.system_program,
            1,
        )?;

        let deadline = Clock::get()?
            .unix_timestamp
            .checked_add(SUBMISSION_SECS)
            .ok_or(BlockPuzzleError::Overflow)?;
        let player = ctx.accounts.account_b.authority;
        let session_key = ctx.accounts.session.key();
        let session = &mut ctx.accounts.session;
        session.players[1] = player;
        session.joined = true;
        session.deadline = deadline;
        let authority_bump = session.authority_bump;

        let board_1 = &mut ctx.accounts.board_1;
        board_1.bump = ctx.bumps.board_1;
        board_1.session = session_key;
        board_1.seat = 1;
        board_1.player = player;
        board_1.deadline = deadline;

        let refund_after = deadline
            .max(ctx.accounts.session.opener_deadline)
            .checked_add(SETTLE_GRACE_SECS)
            .ok_or(BlockPuzzleError::Overflow)?;
        let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, &[authority_bump]];
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

    /// Base layer, anyone. Delegates the opener's Board and the SeedVault to the TEE validator
    /// (pass its identity).
    pub fn delegate_opener(ctx: Context<DelegateOpener>) -> Result<()> {
        let config = || tee_config(&ctx.accounts.validator);
        let session_key = ctx.accounts.session.key();
        ctx.accounts.delegate_board_0(
            &ctx.accounts.payer,
            &[BOARD_SEED, session_key.as_ref(), &[0]],
            config()?,
        )?;
        ctx.accounts.delegate_vault(
            &ctx.accounts.payer,
            &[VAULT_SEED, session_key.as_ref()],
            config()?,
        )?;
        Ok(())
    }

    /// Base layer, anyone. Delegates the joiner's Board to the TEE validator.
    pub fn delegate_joiner(ctx: Context<DelegateJoiner>) -> Result<()> {
        let config = tee_config(&ctx.accounts.validator)?;
        let session_key = ctx.accounts.session.key();
        ctx.accounts.delegate_board_1(
            &ctx.accounts.payer,
            &[BOARD_SEED, session_key.as_ref(), &[1]],
            config,
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
        if ctx.accounts.permission.lamports() > 0 {
            require_real_permission(
                &ctx.accounts.permission,
                &board_info.key(),
                error!(BlockPuzzleError::PermissionNotReady),
            )?;
        } else {
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

    /// Rollup, anyone. Creates the SeedVault's permission: private with no member at all, so
    /// nobody can read the Seed from outside the program.
    pub fn init_vault_permission(ctx: Context<InitVaultPermission>) -> Result<()> {
        let vault_info = ctx.accounts.vault.to_account_info();
        let bump = [ctx.accounts.vault.bump];
        let session = ctx.accounts.vault.session;
        if ctx.accounts.permission.lamports() > 0 {
            require_real_permission(
                &ctx.accounts.permission,
                &vault_info.key(),
                error!(BlockPuzzleError::PermissionNotReady),
            )?;
        } else {
            CreateEphemeralPermissionCpi {
                payer: vault_info.clone(),
                permissioned_account: vault_info,
                permission: ctx.accounts.permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                args: EphemeralMembersArgs {
                    is_private: true,
                    members: vec![],
                },
            }
            .invoke_signed(&[&[VAULT_SEED, session.as_ref(), &bump]])?;
        }
        ctx.accounts.vault.permission_ready = true;
        Ok(())
    }

    /// Rollup, anyone. Requests VRF randomness from the delegated oracle queue; the oracle calls
    /// back into `seed_callback` inside the rollup, which writes it only into the SeedVault. May
    /// be repeated until the output arrives.
    pub fn request_seed(ctx: Context<RequestSeed>, client_seed: u8) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(vault.permission_ready, BlockPuzzleError::PermissionNotReady);
        require!(!vault.ready, BlockPuzzleError::SeedAlreadyDrawn);
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::SeedCallback::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: ctx.accounts.vault.key(),
                is_signer: false,
                is_writable: true,
            }]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// Rollup, called by the VRF program only. Stores the Seed in the private SeedVault.
    pub fn seed_callback(ctx: Context<SeedCallback>, randomness: [u8; 32]) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.ready, BlockPuzzleError::SeedAlreadyDrawn);
        vault.seed = derive_seed(&vault.match_state, &randomness);
        vault.ready = true;
        Ok(())
    }

    /// Rollup, anyone. Succeeds once the Seed is drawn and reveals nothing: clients poll it to
    /// know when a run can begin, because the SeedVault itself cannot be read.
    pub fn check_seed(ctx: Context<CheckSeed>) -> Result<()> {
        require!(ctx.accounts.vault.ready, BlockPuzzleError::SeedNotReady);
        Ok(())
    }

    /// Rollup, the Player. Copies the Seed from the SeedVault into the Player's own (private)
    /// Board and starts the Player's clock: this is the first moment the Player can learn the
    /// piece sequence.
    pub fn begin_run(ctx: Context<BeginRun>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let board = &mut ctx.accounts.board;
        require!(board.permission_ready, BlockPuzzleError::PermissionNotReady);
        require!(ctx.accounts.vault.ready, BlockPuzzleError::SeedNotReady);
        require!(board.started_at == 0, BlockPuzzleError::AlreadyBegan);
        require!(now < board.deadline, BlockPuzzleError::DeadlinePassed);
        board.seed = ctx.accounts.vault.seed;
        board.started_at = now;
        board.start_slot = clock.slot;
        Ok(())
    }

    /// Rollup, the Player. Replays `moves` on the Board with the engine. An illegal move
    /// rejects the whole transaction. The run ends when the engine reports game over.
    pub fn play(ctx: Context<PlayerAction>, moves: Vec<MoveArg>) -> Result<()> {
        require!(
            !moves.is_empty() && moves.len() <= MAX_PLAY_BATCH,
            BlockPuzzleError::BadBatch
        );
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let board = &mut ctx.accounts.board;
        let offset = move_offset(board.start_slot, clock.slot);
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
            *board
                .move_slots
                .get_mut(index)
                .ok_or(BlockPuzzleError::IllegalMove)? = offset;
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
    /// (finished, game over, or their window elapsed) or their deadlines passed, so nobody's
    /// moves are exposed while the other Player can still play. Needs both Boards in the rollup,
    /// so it cannot happen before a second Player has joined. The permissionless timeout: a
    /// Player who never began simply forfeits.
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

    /// Rollup, anyone. Closes the permissions and commits + undelegates the sealed Boards to the
    /// base layer, where their contents become public, and the emptied SeedVault with them.
    pub fn commit_boards(ctx: Context<CommitBoards>) -> Result<()> {
        require!(
            ctx.accounts.board_0.sealed && ctx.accounts.board_1.sealed,
            BlockPuzzleError::NotSealed
        );
        let session = ctx.accounts.board_0.session;
        ctx.accounts.vault.seed = 0;
        let (bump_0, bump_1, bump_v) = (
            [ctx.accounts.board_0.bump],
            [ctx.accounts.board_1.bump],
            [ctx.accounts.vault.bump],
        );
        let (board_0, board_1, vault) = (
            ctx.accounts.board_0.to_account_info(),
            ctx.accounts.board_1.to_account_info(),
            ctx.accounts.vault.to_account_info(),
        );
        for (info, permission, seeds) in [
            (
                &board_0,
                &ctx.accounts.permission_0,
                vec![BOARD_SEED, session.as_ref(), &[0], &bump_0],
            ),
            (
                &board_1,
                &ctx.accounts.permission_1,
                vec![BOARD_SEED, session.as_ref(), &[1], &bump_1],
            ),
            (
                &vault,
                &ctx.accounts.vault_permission,
                vec![VAULT_SEED, session.as_ref(), &bump_v],
            ),
        ] {
            CloseEphemeralPermissionCpi {
                payer: info.clone(),
                permissioned_account: info.clone(),
                permission: permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                authority: info.clone(),
                authority_is_signer: false,
            }
            .invoke_signed(&[&seeds])?;
        }
        ctx.accounts.board_0.exit(&ID)?;
        ctx.accounts.board_1.exit(&ID)?;
        ctx.accounts.vault.exit(&ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[
            ctx.accounts.board_0.to_account_info(),
            ctx.accounts.board_1.to_account_info(),
            ctx.accounts.vault.to_account_info(),
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
        let seed = if a.seed != 0 { a.seed } else { b.seed };
        ctx.accounts.session.seed = seed;
        finalize(ctx, result, scores, forfeited)
    }

    /// Base layer, anyone, after the submission deadline. For a Match whose Boards were never
    /// delegated (nobody played): both Players forfeit, so both entries are refunded. A Board
    /// that is still delegated cannot be claimed here; `seal` + `commit_boards` come first.
    pub fn claim_timeout<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>) -> Result<()> {
        require!(ctx.accounts.session.joined, BlockPuzzleError::NotJoined);
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.session.deadline,
            BlockPuzzleError::NotExpired
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

/// The only delegation config the Game accepts: the TEE validator, and no automatic commits (an
/// automatic commit would publish a private Board to the base layer mid-run).
fn tee_config(validator: &Option<AccountInfo>) -> Result<DelegateConfig> {
    require!(
        validator.as_ref().is_some_and(|v| v.key() == TEE_VALIDATOR),
        BlockPuzzleError::InvalidValidator
    );
    Ok(DelegateConfig {
        validator: Some(TEE_VALIDATOR),
        commit_frequency_ms: u32::MAX,
    })
}

/// A permission address that already holds lamports is only accepted as "created" if it really is
/// a private permission of `permissioned` owned by the permission program. Lamports alone prove
/// nothing: anyone can send some to the (predictable) address before the Game creates the
/// permission, which would mark a hidden account ready without ever making it private.
fn require_real_permission(
    permission: &AccountInfo,
    permissioned: &Pubkey,
    err: Error,
) -> Result<()> {
    if permission.owner != &PERMISSION_PROGRAM_ID {
        return Err(err);
    }
    let data = permission.try_borrow_data()?;
    match EphemeralPermission::from_bytes(&data) {
        Ok(p) if p.permissioned_account == *permissioned && p.private => Ok(()),
        _ => Err(err),
    }
}

fn prefund_permission<'info>(
    payer: &Signer<'info>,
    target: &AccountInfo<'info>,
    system: &Program<'info, System>,
    members: usize,
) -> Result<()> {
    let rent = ephemeral_rollups_sdk::ephemeral_accounts::rent(
        EphemeralPermission::size_of(members) as u32,
    );
    system_program::transfer(
        CpiContext::new(
            system.to_account_info(),
            system_program::Transfer {
                from: payer.to_account_info(),
                to: target.clone(),
            },
        ),
        rent,
    )
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

/// Slots between `begin_run` and this `play`, saturating at `u16::MAX` (a 100 s run is
/// ~250 slots at 400 ms, ~2,000 at the rollup's 50 ms).
fn move_offset(start_slot: u64, slot: u64) -> u16 {
    u16::try_from(slot.saturating_sub(start_slot)).unwrap_or(u16::MAX)
}

fn pack(m: MoveArg) -> u32 {
    u32::from(m.piece) | (u32::from(m.x) << 16) | (u32::from(m.y) << 24)
}

#[derive(Accounts)]
pub struct OpenSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(owner = tesoro_core::ID)]
    pub match_state: Account<'info, MatchState>,
    #[account(owner = tesoro_core::ID)]
    pub account_a: Account<'info, TesoroAccount>,
    #[account(
        init, payer = payer, space = 8 + Session::INIT_SPACE,
        seeds = [SESSION_SEED, match_state.key().as_ref()], bump
    )]
    pub session: Account<'info, Session>,
    #[account(
        init, payer = payer, space = 8 + Board::INIT_SPACE,
        seeds = [BOARD_SEED, session.key().as_ref(), &[0]], bump
    )]
    pub board_0: Box<Account<'info, Board>>,
    #[account(
        init, payer = payer, space = 8 + SeedVault::INIT_SPACE,
        seeds = [VAULT_SEED, session.key().as_ref()], bump
    )]
    pub vault: Account<'info, SeedVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [SESSION_SEED, session.match_state.as_ref()], bump = session.bump
    )]
    pub session: Account<'info, Session>,
    #[account(mut, owner = tesoro_core::ID, address = session.match_state)]
    pub match_state: Account<'info, MatchState>,
    #[account(owner = tesoro_core::ID)]
    pub account_b: Account<'info, TesoroAccount>,
    #[account(
        init, payer = payer, space = 8 + Board::INIT_SPACE,
        seeds = [BOARD_SEED, session.key().as_ref(), &[1]], bump
    )]
    pub board_1: Box<Account<'info, Board>>,
    /// CHECK: the Game's authority PDA; signs the `tesoro_core` CPI
    #[account(seeds = [AUTHORITY_SEED], bump = session.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: `tesoro_core` config, validated by `tesoro_core`
    #[account(owner = tesoro_core::ID)]
    pub config: UncheckedAccount<'info>,
    pub tesoro_core_program: Program<'info, tesoro_core::program::TesoroCore>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateOpener<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [SESSION_SEED, session.match_state.as_ref()], bump = session.bump
    )]
    pub session: Account<'info, Session>,
    /// CHECK: Board PDA (seat 0) to delegate
    #[account(mut, del, seeds = [BOARD_SEED, session.key().as_ref(), &[0]], bump)]
    pub board_0: AccountInfo<'info>,
    /// CHECK: SeedVault PDA to delegate
    #[account(mut, del, seeds = [VAULT_SEED, session.key().as_ref()], bump)]
    pub vault: AccountInfo<'info>,
    /// CHECK: TEE validator identity, checked by the delegation program
    pub validator: Option<AccountInfo<'info>>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateJoiner<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [SESSION_SEED, session.match_state.as_ref()], bump = session.bump,
        constraint = session.joined @ BlockPuzzleError::NotJoined
    )]
    pub session: Account<'info, Session>,
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
    pub board: Box<Account<'info, Board>>,
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
pub struct InitVaultPermission<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.session.as_ref()], bump = vault.bump
    )]
    pub vault: Account<'info, SeedVault>,
    /// CHECK: permission PDA of the SeedVault, verified by the permission program
    #[account(mut, seeds = [PERMISSION_SEED, vault.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
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

#[vrf]
#[derive(Accounts)]
pub struct RequestSeed<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [VAULT_SEED, vault.session.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, SeedVault>,
    /// CHECK: validated by the VRF program
    #[account(mut, address = ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct SeedCallback<'info> {
    #[account(mut, seeds = [VAULT_SEED, vault.session.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, SeedVault>,
}

#[derive(Accounts)]
pub struct CheckSeed<'info> {
    pub payer: Signer<'info>,
    #[account(seeds = [VAULT_SEED, vault.session.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, SeedVault>,
}

#[derive(Accounts)]
pub struct BeginRun<'info> {
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [BOARD_SEED, board.session.as_ref(), &[board.seat]], bump = board.bump,
        has_one = player @ BlockPuzzleError::NotThePlayer
    )]
    pub board: Box<Account<'info, Board>>,
    #[account(seeds = [VAULT_SEED, board.session.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, SeedVault>,
}

#[derive(Accounts)]
pub struct PlayerAction<'info> {
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [BOARD_SEED, board.session.as_ref(), &[board.seat]], bump = board.bump,
        has_one = player @ BlockPuzzleError::NotThePlayer
    )]
    pub board: Box<Account<'info, Board>>,
}

#[derive(Accounts)]
pub struct Seal<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [BOARD_SEED, board_0.session.as_ref(), &[0]], bump = board_0.bump
    )]
    pub board_0: Box<Account<'info, Board>>,
    #[account(
        mut,
        seeds = [BOARD_SEED, board_0.session.as_ref(), &[1]], bump = board_1.bump
    )]
    pub board_1: Box<Account<'info, Board>>,
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
    pub board_0: Box<Account<'info, Board>>,
    #[account(
        mut,
        seeds = [BOARD_SEED, board_0.session.as_ref(), &[1]], bump = board_1.bump
    )]
    pub board_1: Box<Account<'info, Board>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, board_0.session.as_ref()], bump = vault.bump
    )]
    pub vault: Account<'info, SeedVault>,
    /// CHECK: permission PDA of Board 0
    #[account(mut, seeds = [PERMISSION_SEED, board_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission_0: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Board 1
    #[account(mut, seeds = [PERMISSION_SEED, board_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission_1: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the SeedVault
    #[account(mut, seeds = [PERMISSION_SEED, vault.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub vault_permission: UncheckedAccount<'info>,
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
    pub board_0: Box<Account<'info, Board>>,
    #[account(
        seeds = [BOARD_SEED, session.key().as_ref(), &[1]], bump = board_1.bump
    )]
    pub board_1: Box<Account<'info, Board>>,
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
    /// Wallets of the seats: 0 opened the `tesoro_core` Match, 1 joined (default until then).
    pub players: [Pubkey; 2],
    /// The opener must begin before this or forfeits: the Queue window's end plus
    /// `SUBMISSION_SECS`, so never earlier than the joiner's deadline.
    pub opener_deadline: i64,
    pub joined: bool,
    /// From the join: Players who have not begun by then forfeit. Zero until a Player joins.
    pub deadline: i64,
    pub settled: bool,
    /// 0 = opener wins, 1 = joiner wins, 2 = draw.
    pub result: u8,
    pub scores: [u32; 2],
    /// Copied from the committed Boards at settlement (public by then); zero before.
    pub seed: u64,
}

/// Holds the Seed for a Match inside the rollup. Delegated with a private permission that has no
/// member, so no wallet can read it; only `begin_run` moves it, into the beginning Player's own
/// Board. Wiped before it is committed back.
#[account]
#[derive(InitSpace)]
pub struct SeedVault {
    pub bump: u8,
    pub session: Pubkey,
    pub match_state: Pubkey,
    pub permission_ready: bool,
    pub ready: bool,
    pub seed: u64,
}

/// One Player's run. Private in the rollup; public once committed after both runs close. The
/// Seed is zero until the Player calls `begin_run`.
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
    /// Clock slot of `begin_run`. Appended after `log` so earlier fields keep their offsets.
    pub start_slot: u64,
    /// Per logged move: slots from `start_slot` to the transaction that carried it. A batch
    /// (up to 40 moves) shares one offset, so reviewers read the cadence of batches, not of moves.
    pub move_slots: [u16; MOVE_LOG],
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

    #[test]
    fn seed_depends_on_the_output_and_the_match() {
        let m = Pubkey::new_unique();
        let r = [7u8; 32];
        assert_eq!(derive_seed(&m, &r), derive_seed(&m, &r));
        assert_ne!(derive_seed(&m, &r), derive_seed(&m, &[8u8; 32]));
        assert_ne!(derive_seed(&m, &r), derive_seed(&Pubkey::new_unique(), &r));
    }
}
