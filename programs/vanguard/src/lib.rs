//! Vanguard (blitz Stratego) as a Tesoro Game.
//!
//! One Match per tesoro_core Match. The public `Battle`, a private `Army` per seat and a zero-member `Secret` are
//! delegated to a MagicBlock Private Ephemeral Rollup (TEE). Both Players fold a secret into the Secret, a VRF
//! output is stored by callback, and a permissionless `deal` draws the sides, the layouts and the storm. Moves
//! run the pure `engine` (the referee) over the Battle and both Armies. When the Match is over `close_match`
//! wipes the Armies and the Secret and commits everything back, and `finalize` settles or refunds the
//! tesoro_core Match by CPI signed by this program's `authority` PDA.
//!
//! Layers: `tesoro_core` open/join on base, then `create_match` + `delegate_match` on base, everything else in
//! the rollup, `close_match` in the rollup, `finalize` on base. `set_config` (base) names the TEE validator.

pub mod engine;
pub mod state;

use anchor_lang::{prelude::*, solana_program::hash::hashv, system_program};
use engine::{Army as Side, Events, Refusal, CHAIN_CLOCK, PIECE_SLOTS};
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
use tesoro_core::{
    instructions::MatchResult,
    ledger::MatchStatus,
    state::{
        Config, MatchState, TesoroAccount, ACCOUNT_SEED, CONFIG_SEED as CORE_CONFIG_SEED,
        MATCH_SEED as CORE_MATCH_SEED,
    },
};

pub use state::*;

declare_id!("TS3iowavNFV2pMUrHcbmGNC9SW2Vv54i52DqjKebYKH");

const READ_FLAGS: u8 = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;

#[error_code]
pub enum VanguardError {
    #[msg("Signer is not a Player of this Match")]
    NotAPlayer,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("The tesoro_core Match is not an Active Match of this Game")]
    BadTesoroMatch,
    #[msg("Already settled or refunded")]
    AlreadyFinalized,
    #[msg("Delegation must name the TEE validator")]
    InvalidValidator,
    #[msg("A permission for this account is missing or is not a real permission")]
    PermissionNotReady,
    #[msg("Only the program's upgrade authority may do this")]
    NotUpgradeAuthority,
    #[msg("Match is not live")]
    NotLive,
    #[msg("Not valid in this phase of the Match")]
    WrongPhase,
    #[msg("Entropy already contributed")]
    AlreadyContributed,
    #[msg("Both Players must contribute entropy and the VRF output must arrive first")]
    EntropyIncomplete,
    #[msg("Already set up")]
    AlreadyDealt,
    #[msg("Match already started")]
    AlreadyStarted,
    #[msg("Deadline has not passed")]
    NotTimedOut,
    #[msg("The Match is not over")]
    MatchNotOver,
    #[msg("The Match is over")]
    MatchOver,
    #[msg("The time cap has passed")]
    CapPassed,
    #[msg("The turn has expired")]
    TurnExpired,
    #[msg("It is not your turn")]
    NotYourTurn,
    #[msg("Not allowed")]
    IllegalMove,
    #[msg("No Two-Step Turn to spend")]
    NoTwoStep,
    #[msg("Inconsistent account state")]
    BadState,
}

fn refused(r: Refusal) -> Error {
    match r {
        Refusal::MatchOver => error!(VanguardError::MatchOver),
        Refusal::CapPassed => error!(VanguardError::CapPassed),
        Refusal::TurnExpired => error!(VanguardError::TurnExpired),
        Refusal::TurnNotExpired => error!(VanguardError::NotTimedOut),
        Refusal::NotYourTurn => error!(VanguardError::NotYourTurn),
        Refusal::NoSuchPiece | Refusal::IllegalMove => error!(VanguardError::IllegalMove),
        Refusal::NoTwoStep => error!(VanguardError::NoTwoStep),
    }
}

#[ephemeral]
#[program]
pub mod vanguard {
    use super::*;

    /// Base layer, upgrade authority only. Names the TEE validator the Battle may be delegated to, so the
    /// program has no compiled-in validator and a mainnet deploy needs no code change.
    pub fn set_config(ctx: Context<SetConfig>, tee_validator: Pubkey) -> Result<()> {
        require!(
            tee_validator != Pubkey::default(),
            VanguardError::InvalidValidator
        );
        let config = &mut ctx.accounts.config;
        config.bump = ctx.bumps.config;
        config.tee_validator = tee_validator;
        Ok(())
    }

    /// Base layer. Binds a new Battle to an Active tesoro_core Match of this Game and pre-funds the ephemeral
    /// permission rent of each account. Either Player may create it.
    pub fn create_match(ctx: Context<CreateMatch>, match_id: u64) -> Result<()> {
        let tesoro = &ctx.accounts.tesoro_match;
        require!(tesoro.id == match_id, VanguardError::BadTesoroMatch);
        require!(
            tesoro.inner.status == MatchStatus::Active
                && tesoro.inner.game == ID.to_bytes()
                && tesoro.inner.a.player == ctx.accounts.account_a.key().to_bytes()
                && tesoro
                    .inner
                    .b
                    .as_ref()
                    .is_some_and(|b| b.player == ctx.accounts.account_b.key().to_bytes()),
            VanguardError::BadTesoroMatch
        );
        let players = [
            ctx.accounts.account_a.authority,
            ctx.accounts.account_b.authority,
        ];
        require!(
            players.contains(&ctx.accounts.creator.key()),
            VanguardError::NotAPlayer
        );

        let permission_rent =
            ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(2) as u32);
        for target in [
            ctx.accounts.battle.to_account_info(),
            ctx.accounts.secret.to_account_info(),
            ctx.accounts.army_0.to_account_info(),
            ctx.accounts.army_1.to_account_info(),
        ] {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.creator.to_account_info(),
                        to: target,
                    },
                ),
                permission_rent,
            )?;
        }

        let now = Clock::get()?.unix_timestamp;

        // tesoro_core lets anyone refund an Active Match one hour after it started, and the Battle plays in the
        // rollup, where tesoro_core cannot be called. Push the refund deadline out; `finalize` refunds a
        // cancelled Battle through the Game authority, which needs no deadline.
        let authority_bump = [ctx.bumps.authority];
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &authority_bump]];
        tesoro_core::cpi::extend_match_deadline(
            CpiContext::new_with_signer(
                ctx.accounts.tesoro_program.to_account_info(),
                tesoro_core::cpi::accounts::ExtendMatchDeadline {
                    game_authority: ctx.accounts.authority.to_account_info(),
                    config: ctx.accounts.config.to_account_info(),
                    match_state: ctx.accounts.tesoro_match.to_account_info(),
                },
                signer_seeds,
            ),
            now.checked_add(TABLE_WINDOW_SECS)
                .ok_or(VanguardError::Overflow)?,
        )?;

        let battle_key = ctx.accounts.battle.key();
        ctx.accounts.battle.load_init()?.init(
            ctx.bumps.battle,
            ctx.bumps.authority,
            match_id,
            ctx.accounts.tesoro_match.key(),
            players,
            now.checked_add(START_WINDOW_SECS)
                .ok_or(VanguardError::Overflow)?,
        );
        **ctx.accounts.secret = Secret::blank(ctx.bumps.secret, battle_key);
        **ctx.accounts.army_0 = Army::blank(ctx.bumps.army_0, battle_key, 0, players[0]);
        **ctx.accounts.army_1 = Army::blank(ctx.bumps.army_1, battle_key, 1, players[1]);
        Ok(())
    }

    /// Base layer. Delegates the Battle, the Secret and both Armies to the configured TEE validator.
    pub fn delegate_match(ctx: Context<DelegateMatch>, match_id: u64) -> Result<()> {
        // Permissionless, so only a Battle that has not started may be delegated: once it is committed back,
        // delegating it again would leave `finalize` unable to read it.
        {
            let data = ctx.accounts.battle.try_borrow_data()?;
            require!(
                data.len() == 8 + core::mem::size_of::<Battle>()
                    && data[..8] == *Battle::DISCRIMINATOR,
                VanguardError::BadState
            );
            let battle: &Battle = anchor_lang::__private::bytemuck::from_bytes(&data[8..]);
            require!(
                battle.status == STATUS_CREATED && battle.finalized == 0,
                VanguardError::AlreadyStarted
            );
        }
        let config = || tee_config(&ctx.accounts.validator, &ctx.accounts.config);
        let battle_key = ctx.accounts.battle.key();
        ctx.accounts.delegate_battle(
            &ctx.accounts.payer,
            &[BATTLE_SEED, &match_id.to_le_bytes()],
            config()?,
        )?;
        ctx.accounts.delegate_secret(
            &ctx.accounts.payer,
            &[SECRET_SEED, battle_key.as_ref()],
            config()?,
        )?;
        ctx.accounts.delegate_army_0(
            &ctx.accounts.payer,
            &[ARMY_SEED, battle_key.as_ref(), &[0]],
            config()?,
        )?;
        ctx.accounts.delegate_army_1(
            &ctx.accounts.payer,
            &[ARMY_SEED, battle_key.as_ref(), &[1]],
            config()?,
        )?;
        Ok(())
    }

    /// Rollup. Creates the four permissions (the Battle is public, each Army is readable by its Player only, the
    /// Secret by nobody) and opens the setup phase: both Players have a minute to contribute entropy.
    pub fn init_permissions(ctx: Context<InitPermissions>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let mut battle = ctx.accounts.battle.load_mut()?;
            require!(
                battle.status == STATUS_CREATED && battle.permissioned == 0,
                VanguardError::AlreadyStarted
            );
            require!(now <= battle.start_deadline, VanguardError::NotLive);
            battle.status = STATUS_SETUP;
            battle.permissioned = 1;
            battle.entropy_deadline = now
                .checked_add(ENTROPY_SECS)
                .ok_or(VanguardError::Overflow)?;
        }

        let (players, match_id, battle_bump) = {
            let b = ctx.accounts.battle.load()?;
            (b.players, b.match_id.to_le_bytes(), b.bump)
        };
        let battle_key = ctx.accounts.battle.key();
        let player_member = |pubkey: Pubkey| Member {
            flags: READ_FLAGS,
            pubkey,
        };

        create_permission(
            &*ctx.accounts,
            &ctx.accounts.battle.to_account_info(),
            &ctx.accounts.battle_permission,
            EphemeralMembersArgs {
                is_private: false,
                members: vec![],
            },
            &[BATTLE_SEED, &match_id, &[battle_bump]],
            false,
        )?;
        create_permission(
            &*ctx.accounts,
            &ctx.accounts.secret.to_account_info(),
            &ctx.accounts.secret_permission,
            EphemeralMembersArgs {
                is_private: true,
                members: vec![],
            },
            &[
                SECRET_SEED,
                battle_key.as_ref(),
                &[ctx.accounts.secret.bump],
            ],
            true,
        )?;
        create_permission(
            &*ctx.accounts,
            &ctx.accounts.army_0.to_account_info(),
            &ctx.accounts.army_0_permission,
            EphemeralMembersArgs {
                is_private: true,
                members: vec![player_member(players[0])],
            },
            &[
                ARMY_SEED,
                battle_key.as_ref(),
                &[0],
                &[ctx.accounts.army_0.bump],
            ],
            true,
        )?;
        create_permission(
            &*ctx.accounts,
            &ctx.accounts.army_1.to_account_info(),
            &ctx.accounts.army_1_permission,
            EphemeralMembersArgs {
                is_private: true,
                members: vec![player_member(players[1])],
            },
            &[
                ARMY_SEED,
                battle_key.as_ref(),
                &[1],
                &[ctx.accounts.army_1.bump],
            ],
            true,
        )?;
        Ok(())
    }

    /// Rollup. A Player folds a fresh secret into the Secret's entropy. The secret only ever exists in this
    /// transaction (inside the TEE) and in the Secret account.
    pub fn contribute_entropy(ctx: Context<ContributeEntropy>, secret: [u8; 32]) -> Result<()> {
        let seat = {
            let battle = ctx.accounts.battle.load()?;
            require!(battle.status == STATUS_SETUP, VanguardError::WrongPhase);
            seat_of(&battle, &ctx.accounts.player.key())?
        };
        let s = &mut ctx.accounts.secret;
        require!(!s.contributed[seat], VanguardError::AlreadyContributed);
        s.entropy = hashv(&[&s.entropy, &secret, &[seat as u8]]).to_bytes();
        s.contributed[seat] = true;
        Ok(())
    }

    /// Rollup. Requests VRF randomness from the delegated oracle queue; the oracle calls back into
    /// `vrf_callback_store` inside the rollup. May be repeated until the output arrives.
    pub fn request_vrf(ctx: Context<RequestVrf>, client_seed: u8) -> Result<()> {
        let secret = &ctx.accounts.secret;
        require!(
            ctx.accounts.battle.load()?.status == STATUS_SETUP,
            VanguardError::WrongPhase
        );
        require!(
            secret.contributed.iter().all(|c| *c),
            VanguardError::EntropyIncomplete
        );
        require!(!secret.vrf_seen, VanguardError::AlreadyDealt);
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::VrfCallbackStore::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            accounts_metas: Some(vec![
                SerializableAccountMeta {
                    pubkey: ctx.accounts.secret.key(),
                    is_signer: false,
                    is_writable: true,
                },
                SerializableAccountMeta {
                    pubkey: ctx.accounts.battle.key(),
                    is_signer: false,
                    is_writable: false,
                },
            ]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// Rollup. VRF callback: only stores the output, and only while the Battle is still waiting to start, so a
    /// late output can never restart a cancelled Match. The setup itself is `deal`.
    pub fn vrf_callback_store(ctx: Context<VrfCallbackStore>, randomness: [u8; 32]) -> Result<()> {
        require!(
            ctx.accounts.battle.load()?.status == STATUS_SETUP,
            VanguardError::WrongPhase
        );
        let secret = &mut ctx.accounts.secret;
        require!(
            secret.contributed.iter().all(|c| *c),
            VanguardError::EntropyIncomplete
        );
        require!(!secret.vrf_seen, VanguardError::AlreadyDealt);
        secret.vrf = randomness;
        secret.vrf_seen = true;
        Ok(())
    }

    /// Rollup, permissionless. Draws the sides, both layouts and the storm from `H(entropy || vrf)` and starts
    /// the first turn's clock. The US Army moves first; which seat plays it is the draw.
    pub fn deal(ctx: Context<Deal>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut battle = ctx.accounts.battle.load_mut()?;
        let secret = &mut ctx.accounts.secret;
        require!(battle.status == STATUS_SETUP, VanguardError::WrongPhase);
        require!(
            secret.contributed.iter().all(|c| *c) && secret.vrf_seen,
            VanguardError::EntropyIncomplete
        );
        require!(!secret.dealt, VanguardError::AlreadyDealt);

        let seed = hashv(&[&secret.entropy, &secret.vrf]).to_bytes();
        let us_seat = hashv(&[&seed, b"us"]).to_bytes()[0] & 1;
        let drawn = engine::setup(&seed);
        let game = engine::Game::start(
            &drawn.pieces,
            Side::Us,
            drawn.storm_at,
            drawn.storm_seed,
            now,
            CHAIN_CLOCK,
        )
        .map_err(|_| error!(VanguardError::BadState))?;

        battle.us_seat = us_seat;
        battle.absorb(&game, &[0; PIECE_SLOTS]);
        battle.status = STATUS_LIVE;
        battle.started_at = now;
        for (seat, army) in [&mut ctx.accounts.army_0, &mut ctx.accounts.army_1]
            .into_iter()
            .enumerate()
        {
            let side = battle
                .side_of_seat(seat)
                .ok_or_else(|| error!(VanguardError::BadState))?;
            army.place(side, &drawn.pieces);
        }
        secret.storm_at = drawn.storm_at;
        secret.storm_seed = drawn.storm_seed;
        secret.dealt = true;
        Ok(())
    }

    /// Rollup. The Player to act moves a piece, or attacks with it. Writes no logs.
    pub fn move_piece(ctx: Context<Play>, piece: u8, to: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let seat = acting_seat(&*ctx.accounts.battle.load()?, &ctx.accounts.player.key())?;
        play(ctx.accounts, |g, out| g.move_piece(piece, to, now, out))?;
        let mover = if seat == 0 {
            &mut ctx.accounts.army_0
        } else {
            &mut ctx.accounts.army_1
        };
        mover.moves = mover.moves.wrapping_add(1);
        Ok(())
    }

    /// Rollup. The Player to act spends a banked Two-Step Turn before the first step of the turn. Does not move
    /// the deadline.
    pub fn start_two_step(ctx: Context<StartTwoStep>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut battle = ctx.accounts.battle.load_mut()?;
        acting_seat(&battle, &ctx.accounts.player.key())?;
        let mut g = battle.shell(0, 0)?;
        g.start_two_step(now).map_err(refused)?;
        battle.two_step = g.two_step;
        battle.two_step_active = g.two_step_active as u8;
        battle.steps_left = g.steps_left;
        Ok(())
    }

    /// Rollup, permissionless. Past the start window or the entropy window it cancels the Match; once the
    /// turn's deadline has passed it passes the turn (three in a row lose); once the time cap has passed it ends
    /// the Match on the tiebreak.
    pub fn claim_timeout(mut ctx: Context<ClaimTimeout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let status = ctx.accounts.battle.load()?.status;
        match status {
            STATUS_CREATED => {
                let mut battle = ctx.accounts.battle.load_mut()?;
                require!(now > battle.start_deadline, VanguardError::NotTimedOut);
                battle.status = STATUS_CANCELLED;
            }
            STATUS_SETUP => {
                let both = ctx.accounts.secret.contributed.iter().all(|c| *c);
                let mut battle = ctx.accounts.battle.load_mut()?;
                require!(now > battle.entropy_deadline, VanguardError::NotTimedOut);
                if both {
                    // The randomness is late, which is the oracle's fault: nobody forfeits.
                    battle.entropy_deadline = now
                        .checked_add(ENTROPY_SECS)
                        .ok_or(VanguardError::Overflow)?;
                } else {
                    battle.status = STATUS_CANCELLED;
                }
            }
            STATUS_LIVE => {
                let accounts = &mut ctx.accounts;
                let mut battle = accounts.battle.load_mut()?;
                run(
                    &mut battle,
                    &mut accounts.army_0,
                    &mut accounts.army_1,
                    &accounts.secret,
                    |g, out| g.timeout(now, out),
                )?;
            }
            _ => return err!(VanguardError::MatchOver),
        }
        Ok(())
    }

    /// Rollup. After the Match is over or cancelled: wipes the Armies and the Secret, closes the permissions and
    /// commits + undelegates everything. Whatever is in state at commit becomes public, hence the wipe.
    pub fn close_match(ctx: Context<CloseMatch>) -> Result<()> {
        let (match_id, battle_bump) = {
            let battle = ctx.accounts.battle.load()?;
            require!(
                battle.status == STATUS_OVER || battle.status == STATUS_CANCELLED,
                VanguardError::MatchNotOver
            );
            require!(battle.permissioned != 0, VanguardError::WrongPhase);
            (battle.match_id.to_le_bytes(), battle.bump)
        };
        let battle_key = ctx.accounts.battle.key();
        ctx.accounts.secret.wipe();
        ctx.accounts.army_0.wipe();
        ctx.accounts.army_1.wipe();
        ctx.accounts.battle.exit(&ID)?;
        ctx.accounts.secret.exit(&ID)?;
        ctx.accounts.army_0.exit(&ID)?;
        ctx.accounts.army_1.exit(&ID)?;

        close_permission(
            &*ctx.accounts,
            &ctx.accounts.battle.to_account_info(),
            &ctx.accounts.battle_permission,
            &[BATTLE_SEED, &match_id, &[battle_bump]],
        )?;
        close_permission(
            &*ctx.accounts,
            &ctx.accounts.secret.to_account_info(),
            &ctx.accounts.secret_permission,
            &[
                SECRET_SEED,
                battle_key.as_ref(),
                &[ctx.accounts.secret.bump],
            ],
        )?;
        close_permission(
            &*ctx.accounts,
            &ctx.accounts.army_0.to_account_info(),
            &ctx.accounts.army_0_permission,
            &[
                ARMY_SEED,
                battle_key.as_ref(),
                &[0],
                &[ctx.accounts.army_0.bump],
            ],
        )?;
        close_permission(
            &*ctx.accounts,
            &ctx.accounts.army_1.to_account_info(),
            &ctx.accounts.army_1_permission,
            &[
                ARMY_SEED,
                battle_key.as_ref(),
                &[1],
                &[ctx.accounts.army_1.bump],
            ],
        )?;

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[
            ctx.accounts.battle.to_account_info(),
            ctx.accounts.secret.to_account_info(),
            ctx.accounts.army_0.to_account_info(),
            ctx.accounts.army_1.to_account_info(),
        ])
        .build_and_invoke()?;
        Ok(())
    }

    /// Rollup. A Battle cancelled before its permissions existed has none to close: commits + undelegates it as
    /// it is, which lets `finalize` refund both entries.
    pub fn close_unstarted(ctx: Context<CloseUnstarted>) -> Result<()> {
        {
            let battle = ctx.accounts.battle.load()?;
            require!(
                battle.status == STATUS_CANCELLED && battle.permissioned == 0,
                VanguardError::MatchNotOver
            );
        }
        ctx.accounts.battle.exit(&ID)?;
        ctx.accounts.secret.exit(&ID)?;
        ctx.accounts.army_0.exit(&ID)?;
        ctx.accounts.army_1.exit(&ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[
            ctx.accounts.battle.to_account_info(),
            ctx.accounts.secret.to_account_info(),
            ctx.accounts.army_0.to_account_info(),
            ctx.accounts.army_1.to_account_info(),
        ])
        .build_and_invoke()?;
        Ok(())
    }

    /// Base layer, permissionless. Settles the tesoro_core Match from the committed result by CPI, signing as
    /// this Game's `authority` PDA: the winner takes the Pot minus Fees. A draw, a cancelled Battle, or one never
    /// started before its start deadline refunds both entries. A Match tesoro_core already refunded (its
    /// deadline passed first) is only marked finalized. `remaining_accounts` are the payout accounts
    /// tesoro_core expects (recipient `TesoroAccount` then its Holding, per payout, sorted by recipient and
    /// Source).
    pub fn finalize<'info>(ctx: Context<'_, '_, 'info, 'info, Finalize<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (status, winner, start_deadline, authority_bump) = {
            let b = ctx.accounts.battle.load()?;
            require!(b.finalized == 0, VanguardError::AlreadyFinalized);
            (b.status, b.winner, b.start_deadline, b.authority_bump)
        };
        if ctx.accounts.tesoro_match.inner.status != MatchStatus::Active {
            ctx.accounts.battle.load_mut()?.finalized = 1;
            return Ok(());
        }

        let bump = [authority_bump];
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &bump]];
        let remaining = ctx.remaining_accounts.to_vec();
        let refund = match status {
            STATUS_OVER => winner == DRAW,
            STATUS_CANCELLED => true,
            STATUS_CREATED => {
                require!(now > start_deadline, VanguardError::NotTimedOut);
                true
            }
            _ => return err!(VanguardError::MatchNotOver),
        };
        if refund {
            let cpi = CpiContext::new_with_signer(
                ctx.accounts.tesoro_program.to_account_info(),
                tesoro_core::cpi::accounts::RefundMatch {
                    caller: ctx.accounts.authority.to_account_info(),
                    config: ctx.accounts.config.to_account_info(),
                    match_state: ctx.accounts.tesoro_match.to_account_info(),
                    opener_protections: None,
                },
                signer_seeds,
            )
            .with_remaining_accounts(remaining);
            tesoro_core::cpi::refund_match(cpi)?;
        } else {
            let cpi = CpiContext::new_with_signer(
                ctx.accounts.tesoro_program.to_account_info(),
                tesoro_core::cpi::accounts::SettleMatch {
                    game_authority: ctx.accounts.authority.to_account_info(),
                    config: ctx.accounts.config.to_account_info(),
                    match_state: ctx.accounts.tesoro_match.to_account_info(),
                },
                signer_seeds,
            )
            .with_remaining_accounts(remaining);
            let result = if winner == 0 {
                MatchResult::Opener
            } else {
                MatchResult::Joiner
            };
            tesoro_core::cpi::settle_match(cpi, result)?;
        }
        ctx.accounts.battle.load_mut()?.finalized = 1;
        Ok(())
    }
}

/// The only delegation config the Game accepts: the configured TEE validator, and no automatic commits (an
/// automatic commit would publish the hidden accounts to the base layer mid-Match).
fn tee_config(validator: &Option<AccountInfo>, config: &VanguardConfig) -> Result<DelegateConfig> {
    require!(
        validator
            .as_ref()
            .is_some_and(|v| v.key() == config.tee_validator),
        VanguardError::InvalidValidator
    );
    Ok(DelegateConfig {
        validator: Some(config.tee_validator),
        commit_frequency_ms: u32::MAX,
    })
}

fn seat_of(battle: &Battle, key: &Pubkey) -> Result<usize> {
    battle
        .seat_of(key)
        .ok_or_else(|| error!(VanguardError::NotAPlayer))
}

/// The seat of `key`, if it is the Player whose army is to act.
fn acting_seat(battle: &Battle, key: &Pubkey) -> Result<usize> {
    require!(battle.status == STATUS_LIVE, VanguardError::NotLive);
    let seat = seat_of(battle, key)?;
    let side = battle
        .side_of_seat(seat)
        .ok_or_else(|| error!(VanguardError::BadState))?;
    require!(side.idx() as u8 == battle.turn, VanguardError::NotYourTurn);
    Ok(seat)
}

fn play(
    accounts: &mut Play<'_>,
    f: impl FnOnce(&mut engine::Game, &mut Events) -> core::result::Result<(), Refusal>,
) -> Result<()> {
    let mut battle = accounts.battle.load_mut()?;
    run(
        &mut battle,
        &mut accounts.army_0,
        &mut accounts.army_1,
        &accounts.secret,
        f,
    )
}

/// Assemble the engine's Game from the public Battle and both private Armies, run one action and write the
/// result back.
fn run(
    battle: &mut Battle,
    army_0: &mut Army,
    army_1: &mut Army,
    secret: &Secret,
    f: impl FnOnce(&mut engine::Game, &mut Events) -> core::result::Result<(), Refusal>,
) -> Result<()> {
    let mut g = battle.game([&*army_0, &*army_1], secret)?;
    let mut before = [0u8; PIECE_SLOTS];
    for (slot, p) in before.iter_mut().zip(g.pieces.iter()) {
        *slot = p.rank;
    }
    let mut out = Events::new();
    f(&mut g, &mut out).map_err(refused)?;
    battle.absorb(&g, &before);
    battle.push_events(&out);
    army_0.absorb(&g);
    army_1.absorb(&g);
    Ok(())
}

/// Every permission CPI is signed by the permissioned PDA itself, which also pays the rent.
fn create_permission<'info, T: PermissionAccounts<'info>>(
    accounts: &T,
    data: &AccountInfo<'info>,
    permission: &UncheckedAccount<'info>,
    args: EphemeralMembersArgs,
    seeds: &[&[u8]],
    private: bool,
) -> Result<()> {
    if permission.lamports() > 0 {
        return require_real_permission(
            permission,
            data.key,
            private,
            error!(VanguardError::PermissionNotReady),
        );
    }
    CreateEphemeralPermissionCpi {
        payer: data.clone(),
        permissioned_account: data.clone(),
        permission: permission.to_account_info(),
        vault: accounts.ephemeral_vault(),
        magic_program: accounts.magic_program(),
        permission_program: accounts.permission_program(),
        args,
    }
    .invoke_signed(&[seeds])?;
    Ok(())
}

/// A permission address that already holds lamports is accepted as "created" only if it really is a permission
/// of `permissioned`, owned by the permission program, with the expected privacy. Lamports alone prove nothing:
/// anyone can send some to the predictable address before the Game creates the permission, which would mark a
/// hidden account ready without ever making it private.
fn require_real_permission(
    permission: &AccountInfo,
    permissioned: &Pubkey,
    private: bool,
    err: Error,
) -> Result<()> {
    if permission.owner != &PERMISSION_PROGRAM_ID {
        return Err(err);
    }
    let data = permission.try_borrow_data()?;
    match EphemeralPermission::from_bytes(&data) {
        Ok(p) if p.permissioned_account == *permissioned && p.private == private => Ok(()),
        _ => Err(err),
    }
}

fn close_permission<'info, T: PermissionAccounts<'info>>(
    accounts: &T,
    data: &AccountInfo<'info>,
    permission: &UncheckedAccount<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    CloseEphemeralPermissionCpi {
        payer: data.clone(),
        permissioned_account: data.clone(),
        permission: permission.to_account_info(),
        vault: accounts.ephemeral_vault(),
        magic_program: accounts.magic_program(),
        permission_program: accounts.permission_program(),
        authority: data.clone(),
        authority_is_signer: false,
    }
    .invoke_signed(&[seeds])?;
    Ok(())
}

trait PermissionAccounts<'info> {
    fn ephemeral_vault(&self) -> AccountInfo<'info>;
    fn magic_program(&self) -> AccountInfo<'info>;
    fn permission_program(&self) -> AccountInfo<'info>;
}

macro_rules! impl_permission_accounts {
    ($ty:ident) => {
        impl<'info> PermissionAccounts<'info> for $ty<'info> {
            fn ephemeral_vault(&self) -> AccountInfo<'info> {
                self.ephemeral_vault.to_account_info()
            }
            fn magic_program(&self) -> AccountInfo<'info> {
                self.magic_program.to_account_info()
            }
            fn permission_program(&self) -> AccountInfo<'info> {
                self.permission_program.to_account_info()
            }
        }
    };
}
impl_permission_accounts!(InitPermissions);
impl_permission_accounts!(CloseMatch);

#[derive(Accounts)]
pub struct SetConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed, payer = authority, space = 8 + VanguardConfig::INIT_SPACE,
        seeds = [PROGRAM_CONFIG_SEED], bump
    )]
    pub config: Account<'info, VanguardConfig>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ VanguardError::NotUpgradeAuthority
    )]
    pub program: Program<'info, crate::program::Vanguard>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ VanguardError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CreateMatch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [CORE_MATCH_SEED, &tesoro_match.id.to_le_bytes()],
        bump = tesoro_match.bump,
        seeds::program = tesoro_core::ID
    )]
    pub tesoro_match: Box<Account<'info, MatchState>>,
    #[account(seeds = [CORE_CONFIG_SEED], bump = config.bump, seeds::program = tesoro_core::ID)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [ACCOUNT_SEED, account_a.authority.as_ref()],
        bump = account_a.bump,
        seeds::program = tesoro_core::ID
    )]
    pub account_a: Account<'info, TesoroAccount>,
    #[account(
        seeds = [ACCOUNT_SEED, account_b.authority.as_ref()],
        bump = account_b.bump,
        seeds::program = tesoro_core::ID
    )]
    pub account_b: Account<'info, TesoroAccount>,
    /// CHECK: this Game's settlement authority PDA; only its canonical bump is read here.
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        init, payer = creator, space = 8 + core::mem::size_of::<Battle>(),
        seeds = [BATTLE_SEED, &match_id.to_le_bytes()], bump
    )]
    pub battle: AccountLoader<'info, Battle>,
    #[account(
        init, payer = creator, space = 8 + Secret::INIT_SPACE,
        seeds = [SECRET_SEED, battle.key().as_ref()], bump
    )]
    pub secret: Box<Account<'info, Secret>>,
    #[account(
        init, payer = creator, space = 8 + Army::INIT_SPACE,
        seeds = [ARMY_SEED, battle.key().as_ref(), &[0]], bump
    )]
    pub army_0: Box<Account<'info, Army>>,
    #[account(
        init, payer = creator, space = 8 + Army::INIT_SPACE,
        seeds = [ARMY_SEED, battle.key().as_ref(), &[1]], bump
    )]
    pub army_1: Box<Account<'info, Army>>,
    pub tesoro_program: Program<'info, tesoro_core::program::TesoroCore>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct DelegateMatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Battle PDA to delegate
    #[account(mut, del, seeds = [BATTLE_SEED, &match_id.to_le_bytes()], bump)]
    pub battle: AccountInfo<'info>,
    /// CHECK: Secret PDA to delegate
    #[account(mut, del, seeds = [SECRET_SEED, battle.key().as_ref()], bump)]
    pub secret: AccountInfo<'info>,
    /// CHECK: Army PDA (seat 0) to delegate
    #[account(mut, del, seeds = [ARMY_SEED, battle.key().as_ref(), &[0]], bump)]
    pub army_0: AccountInfo<'info>,
    /// CHECK: Army PDA (seat 1) to delegate
    #[account(mut, del, seeds = [ARMY_SEED, battle.key().as_ref(), &[1]], bump)]
    pub army_1: AccountInfo<'info>,
    #[account(seeds = [PROGRAM_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, VanguardConfig>,
    /// CHECK: TEE validator identity, checked against the config
    pub validator: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
pub struct InitPermissions<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [BATTLE_SEED, &battle.load()?.match_id.to_le_bytes()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(seeds = [SECRET_SEED, battle.key().as_ref()], bump = secret.bump)]
    pub secret: Box<Account<'info, Secret>>,
    #[account(seeds = [ARMY_SEED, battle.key().as_ref(), &[0]], bump = army_0.bump)]
    pub army_0: Box<Account<'info, Army>>,
    #[account(seeds = [ARMY_SEED, battle.key().as_ref(), &[1]], bump = army_1.bump)]
    pub army_1: Box<Account<'info, Army>>,
    /// CHECK: permission PDA of the Battle, verified by the permission program
    #[account(mut, seeds = [PERMISSION_SEED, battle.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub battle_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the Secret
    #[account(mut, seeds = [PERMISSION_SEED, secret.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub secret_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Army 0
    #[account(mut, seeds = [PERMISSION_SEED, army_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub army_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Army 1
    #[account(mut, seeds = [PERMISSION_SEED, army_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub army_1_permission: UncheckedAccount<'info>,
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
pub struct ContributeEntropy<'info> {
    pub player: Signer<'info>,
    #[account(seeds = [BATTLE_SEED, &battle.load()?.match_id.to_le_bytes()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(mut, seeds = [SECRET_SEED, battle.key().as_ref()], bump = secret.bump)]
    pub secret: Box<Account<'info, Secret>>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestVrf<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [BATTLE_SEED, &battle.load()?.match_id.to_le_bytes()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(seeds = [SECRET_SEED, battle.key().as_ref()], bump = secret.bump)]
    pub secret: Box<Account<'info, Secret>>,
    /// CHECK: validated by the VRF program
    #[account(mut, address = ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct VrfCallbackStore<'info> {
    #[account(mut, seeds = [SECRET_SEED, secret.battle.as_ref()], bump = secret.bump)]
    pub secret: Box<Account<'info, Secret>>,
    #[account(address = secret.battle, seeds = [BATTLE_SEED, &battle.load()?.match_id.to_le_bytes()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
}

#[derive(Accounts)]
pub struct Deal<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [BATTLE_SEED, &battle.load()?.match_id.to_le_bytes()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(mut, seeds = [SECRET_SEED, battle.key().as_ref()], bump = secret.bump)]
    pub secret: Box<Account<'info, Secret>>,
    #[account(mut, seeds = [ARMY_SEED, battle.key().as_ref(), &[0]], bump = army_0.bump)]
    pub army_0: Box<Account<'info, Army>>,
    #[account(mut, seeds = [ARMY_SEED, battle.key().as_ref(), &[1]], bump = army_1.bump)]
    pub army_1: Box<Account<'info, Army>>,
}

#[derive(Accounts)]
pub struct Play<'info> {
    pub player: Signer<'info>,
    #[account(mut, seeds = [BATTLE_SEED, &battle.load()?.match_id.to_le_bytes()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(mut, seeds = [ARMY_SEED, battle.key().as_ref(), &[0]], bump = army_0.bump)]
    pub army_0: Box<Account<'info, Army>>,
    #[account(mut, seeds = [ARMY_SEED, battle.key().as_ref(), &[1]], bump = army_1.bump)]
    pub army_1: Box<Account<'info, Army>>,
    #[account(seeds = [SECRET_SEED, battle.key().as_ref()], bump = secret.bump)]
    pub secret: Box<Account<'info, Secret>>,
}

#[derive(Accounts)]
pub struct StartTwoStep<'info> {
    pub player: Signer<'info>,
    #[account(mut, seeds = [BATTLE_SEED, &battle.load()?.match_id.to_le_bytes()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
}

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [BATTLE_SEED, &battle.load()?.match_id.to_le_bytes()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(mut, seeds = [ARMY_SEED, battle.key().as_ref(), &[0]], bump = army_0.bump)]
    pub army_0: Box<Account<'info, Army>>,
    #[account(mut, seeds = [ARMY_SEED, battle.key().as_ref(), &[1]], bump = army_1.bump)]
    pub army_1: Box<Account<'info, Army>>,
    #[account(seeds = [SECRET_SEED, battle.key().as_ref()], bump = secret.bump)]
    pub secret: Box<Account<'info, Secret>>,
}

#[commit]
#[derive(Accounts)]
pub struct CloseMatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [BATTLE_SEED, &battle.load()?.match_id.to_le_bytes()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(mut, seeds = [SECRET_SEED, battle.key().as_ref()], bump = secret.bump)]
    pub secret: Box<Account<'info, Secret>>,
    #[account(mut, seeds = [ARMY_SEED, battle.key().as_ref(), &[0]], bump = army_0.bump)]
    pub army_0: Box<Account<'info, Army>>,
    #[account(mut, seeds = [ARMY_SEED, battle.key().as_ref(), &[1]], bump = army_1.bump)]
    pub army_1: Box<Account<'info, Army>>,
    /// CHECK: permission PDA of the Battle
    #[account(mut, seeds = [PERMISSION_SEED, battle.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub battle_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the Secret
    #[account(mut, seeds = [PERMISSION_SEED, secret.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub secret_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Army 0
    #[account(mut, seeds = [PERMISSION_SEED, army_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub army_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Army 1
    #[account(mut, seeds = [PERMISSION_SEED, army_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub army_1_permission: UncheckedAccount<'info>,
    /// CHECK: Permission Program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CloseUnstarted<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [BATTLE_SEED, &battle.load()?.match_id.to_le_bytes()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(mut, seeds = [SECRET_SEED, battle.key().as_ref()], bump = secret.bump)]
    pub secret: Box<Account<'info, Secret>>,
    #[account(mut, seeds = [ARMY_SEED, battle.key().as_ref(), &[0]], bump = army_0.bump)]
    pub army_0: Box<Account<'info, Army>>,
    #[account(mut, seeds = [ARMY_SEED, battle.key().as_ref(), &[1]], bump = army_1.bump)]
    pub army_1: Box<Account<'info, Army>>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [BATTLE_SEED, &battle.load()?.match_id.to_le_bytes()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(
        mut,
        address = battle.load()?.tesoro_match,
        seeds = [CORE_MATCH_SEED, &tesoro_match.id.to_le_bytes()],
        bump = tesoro_match.bump,
        seeds::program = tesoro_core::ID
    )]
    pub tesoro_match: Box<Account<'info, MatchState>>,
    #[account(seeds = [CORE_CONFIG_SEED], bump = config.bump, seeds::program = tesoro_core::ID)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: the registered Game authority; signs the CPI with its stored canonical bump.
    #[account(seeds = [AUTHORITY_SEED], bump = battle.load()?.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    pub tesoro_program: Program<'info, tesoro_core::program::TesoroCore>,
}
