//! Heads-up No-Limit Hold'em as a Tesoro Game.
//!
//! One sit-and-go per tesoro_core Match. The Match, a hidden Deck and two hidden Hole accounts are
//! delegated to a MagicBlock Private Ephemeral Rollup (TEE). Both Players fold secrets into the
//! Deck every hand, a VRF output is mixed in inside the rollup, and the Deck sits behind a
//! permission with no readable member. Hole cards are readable only by their Player; board cards
//! and showdown cards become public on the `GameMatch`. When one Player holds every Chip the
//! Match commits back to the base layer, where `finalize` settles the tesoro_core Match by CPI
//! signed by this program's `authority` PDA (the Game authority registered in tesoro_core).
//!
//! Layers: `tesoro_core` open/join on base, then `create_match` + `delegate_match` on base,
//! everything else in the rollup, `close_match` in the rollup, `finalize` on base.

pub mod engine;
pub mod eval;
pub mod state;

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
use tesoro_core::{
    instructions::MatchResult,
    ledger::lifecycle::Stage,
    state::{Config, GameRecord, MatchState, TesoroAccount, ACCOUNT_SEED, CONFIG_SEED, GAME_SEED},
};

pub use state::*;

declare_id!("CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE");

/// Identity of MagicBlock's TEE validator (devnet). Delegation is pinned to it: the validator a
/// delegation names is the only key that can commit state back, so a caller-chosen validator (or
/// none, which the delegation program reads as the public default validator) would let a Player
/// commit a table they won, or leave the Deck outside the TEE.
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

const READ_FLAGS: u8 = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;

#[error_code]
pub enum HoldemError {
    #[msg("Signer is not a Player of this Match")]
    NotAPlayer,
    #[msg("Entropy already contributed for this hand")]
    AlreadyContributed,
    #[msg("Both Players must contribute entropy and the VRF output must arrive first")]
    EntropyIncomplete,
    #[msg("Deck already dealt")]
    AlreadyDealt,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Unknown speed")]
    InvalidSpeed,
    #[msg("Match already started")]
    AlreadyStarted,
    #[msg("Match is not live")]
    NotLive,
    #[msg("Not valid in this phase of the hand")]
    WrongPhase,
    #[msg("It is not your turn")]
    NotYourTurn,
    #[msg("Cannot check facing a bet")]
    CannotCheck,
    #[msg("Nothing to call")]
    NothingToCall,
    #[msg("The opponent is all-in")]
    OpponentAllIn,
    #[msg("Raise below the minimum")]
    RaiseTooSmall,
    #[msg("Not enough chips")]
    NotEnoughChips,
    #[msg("Deadline has not passed")]
    NotTimedOut,
    #[msg("The tesoro_core Match is not an Active Match of this Game")]
    BadTesoroMatch,
    #[msg("The Match is not over")]
    MatchNotOver,
    #[msg("Already settled or refunded in tesoro_core")]
    AlreadyFinalized,
    #[msg("Delegation must name the TEE validator")]
    InvalidValidator,
    #[msg("A permission for this account is missing or is not a real permission")]
    PermissionNotReady,
}

#[ephemeral]
#[program]
pub mod holdem {
    use super::*;

    /// Base layer. Binds a new table to an Active tesoro_core Match of this Game and pre-funds
    /// the ephemeral permission rent of each hidden account. Either Player may create it.
    pub fn create_match(ctx: Context<CreateMatch>, speed: u8) -> Result<()> {
        engine::blinds(speed, 1)?;
        let tesoro = &ctx.accounts.tesoro_match;
        require!(
            tesoro.inner.stage() == Stage::Active
                && tesoro.inner.game == ID.to_bytes()
                && tesoro.inner.a.player == ctx.accounts.account_a.key().to_bytes()
                && tesoro
                    .inner
                    .b
                    .as_ref()
                    .is_some_and(|b| b.player == ctx.accounts.account_b.key().to_bytes()),
            HoldemError::BadTesoroMatch
        );
        let players = [
            ctx.accounts.account_a.authority,
            ctx.accounts.account_b.authority,
        ];
        require!(
            players.contains(&ctx.accounts.creator.key()),
            HoldemError::NotAPlayer
        );

        let permission_rent =
            ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(2) as u32);
        let match_key = ctx.accounts.game_match.key();
        for target in [
            ctx.accounts.game_match.to_account_info(),
            ctx.accounts.deck.to_account_info(),
            ctx.accounts.hole_0.to_account_info(),
            ctx.accounts.hole_1.to_account_info(),
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

        // tesoro_core lets anyone refund an Active Match one hour after it started. A table lives
        // in the rollup for longer than that, and a Player who is losing could stall past the hour
        // and refund the Pot mid-Match. Push the refund deadline out; `finalize` refunds a
        // cancelled table through the Game authority, which needs no deadline.
        let authority_bump = [ctx.bumps.authority];
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &authority_bump]];
        tesoro_core::cpi::extend_match_deadline(
            CpiContext::new_with_signer(
                ctx.accounts.tesoro_program.to_account_info(),
                tesoro_core::cpi::accounts::ExtendMatchDeadline {
                    game_authority: ctx.accounts.authority.to_account_info(),
                    match_state: ctx.accounts.tesoro_match.to_account_info(),
                },
                signer_seeds,
            ),
            now.checked_add(TABLE_WINDOW_SECS)
                .ok_or(HoldemError::Overflow)?,
        )?;

        let game_match = &mut ctx.accounts.game_match;
        **game_match = GameMatch {
            bump: ctx.bumps.game_match,
            authority_bump: ctx.bumps.authority,
            tesoro_match: ctx.accounts.tesoro_match.key(),
            players,
            speed,
            start_deadline: now
                .checked_add(START_WINDOW_SECS)
                .ok_or(HoldemError::Overflow)?,
            ..GameMatch::default()
        };

        let deck = &mut ctx.accounts.deck;
        deck.bump = ctx.bumps.deck;
        deck.game_match = match_key;

        let hole_0 = &mut ctx.accounts.hole_0;
        hole_0.bump = ctx.bumps.hole_0;
        hole_0.game_match = match_key;
        hole_0.player = players[0];

        let hole_1 = &mut ctx.accounts.hole_1;
        hole_1.bump = ctx.bumps.hole_1;
        hole_1.game_match = match_key;
        hole_1.player = players[1];
        Ok(())
    }

    /// Base layer. Delegates the table and its hidden accounts to the TEE validator.
    pub fn delegate_match(ctx: Context<DelegateMatch>, tesoro_match: Pubkey) -> Result<()> {
        // Permissionless, so only a table that has not started may be delegated: once it is
        // committed back, delegating it again would leave `finalize` unable to read it.
        {
            let data = ctx.accounts.game_match.try_borrow_data()?;
            let table = GameMatch::try_deserialize(&mut &data[..])?;
            require!(
                table.status == STATUS_CREATED && !table.finalized,
                HoldemError::AlreadyStarted
            );
        }
        let config = || tee_config(&ctx.accounts.validator);
        let match_key = ctx.accounts.game_match.key();
        ctx.accounts.delegate_game_match(
            &ctx.accounts.payer,
            &[MATCH_SEED, tesoro_match.as_ref()],
            config()?,
        )?;
        ctx.accounts.delegate_deck(
            &ctx.accounts.payer,
            &[DECK_SEED, match_key.as_ref()],
            config()?,
        )?;
        ctx.accounts.delegate_hole_0(
            &ctx.accounts.payer,
            &[HOLE_SEED, match_key.as_ref(), &[0]],
            config()?,
        )?;
        ctx.accounts.delegate_hole_1(
            &ctx.accounts.payer,
            &[HOLE_SEED, match_key.as_ref(), &[1]],
            config()?,
        )?;
        Ok(())
    }

    /// Rollup. Creates the four ephemeral permissions (the table is visible to both Players,
    /// each Hole account only to its Player, the Deck to nobody) and starts the Match: equal
    /// Chips, first hand, blinds posted.
    pub fn init_permissions(ctx: Context<InitPermissions>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.game_match.start(now)?;

        let players = ctx.accounts.game_match.players;
        let match_key = ctx.accounts.game_match.key();
        let tesoro_match = ctx.accounts.game_match.tesoro_match;
        let player_member = |pubkey: Pubkey| Member {
            flags: READ_FLAGS,
            pubkey,
        };

        create_permission(
            &*ctx.accounts,
            &ctx.accounts.game_match.to_account_info(),
            &ctx.accounts.match_permission,
            EphemeralMembersArgs {
                is_private: true,
                members: vec![player_member(players[0]), player_member(players[1])],
            },
            &[
                MATCH_SEED,
                tesoro_match.as_ref(),
                &[ctx.accounts.game_match.bump],
            ],
        )?;
        create_permission(
            &*ctx.accounts,
            &ctx.accounts.deck.to_account_info(),
            &ctx.accounts.deck_permission,
            EphemeralMembersArgs {
                is_private: true,
                members: vec![],
            },
            &[DECK_SEED, match_key.as_ref(), &[ctx.accounts.deck.bump]],
        )?;
        create_permission(
            &*ctx.accounts,
            &ctx.accounts.hole_0.to_account_info(),
            &ctx.accounts.hole_0_permission,
            EphemeralMembersArgs {
                is_private: true,
                members: vec![player_member(players[0])],
            },
            &[
                HOLE_SEED,
                match_key.as_ref(),
                &[0],
                &[ctx.accounts.hole_0.bump],
            ],
        )?;
        create_permission(
            &*ctx.accounts,
            &ctx.accounts.hole_1.to_account_info(),
            &ctx.accounts.hole_1_permission,
            EphemeralMembersArgs {
                is_private: true,
                members: vec![player_member(players[1])],
            },
            &[
                HOLE_SEED,
                match_key.as_ref(),
                &[1],
                &[ctx.accounts.hole_1.bump],
            ],
        )?;
        Ok(())
    }

    /// Rollup. A Player folds a fresh secret into this hand's Deck entropy. The secret only ever
    /// exists in this transaction (inside the TEE) and in the private Deck.
    pub fn contribute_entropy(ctx: Context<ContributeEntropy>, secret: [u8; 32]) -> Result<()> {
        let game_match = &ctx.accounts.game_match;
        require!(game_match.status == STATUS_LIVE, HoldemError::NotLive);
        require!(game_match.phase == PHASE_SHUFFLE, HoldemError::WrongPhase);
        let seat = seat_of(game_match, &ctx.accounts.player.key())?;
        let deck = &mut ctx.accounts.deck;
        if deck.hand_no != game_match.hand_no {
            deck.reset_for(game_match.hand_no);
        }
        require!(!deck.contributed[seat], HoldemError::AlreadyContributed);
        deck.entropy = hashv(&[&deck.entropy, &secret, &[seat as u8]]).to_bytes();
        deck.contributed[seat] = true;
        Ok(())
    }

    /// Rollup. Requests VRF randomness from the delegated oracle queue; the oracle calls back
    /// into `vrf_callback_shuffle` inside the rollup. May be repeated until the output arrives.
    pub fn request_vrf(ctx: Context<RequestVrf>, client_seed: u8) -> Result<()> {
        let game_match = &ctx.accounts.game_match;
        let deck = &ctx.accounts.deck;
        require!(game_match.status == STATUS_LIVE, HoldemError::NotLive);
        require!(game_match.phase == PHASE_SHUFFLE, HoldemError::WrongPhase);
        require!(
            deck.hand_no == game_match.hand_no && deck.contributed.iter().all(|c| *c),
            HoldemError::EntropyIncomplete
        );
        require!(!deck.vrf_seen, HoldemError::AlreadyDealt);
        let mut caller_seed = [client_seed; 32];
        caller_seed[..4].copy_from_slice(&game_match.hand_no.to_le_bytes());
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::VrfCallbackShuffle::DISCRIMINATOR.to_vec(),
            caller_seed,
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: ctx.accounts.deck.key(),
                is_signer: false,
                is_writable: true,
            }]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// Rollup. VRF callback: the output is written only into the private Deck.
    pub fn vrf_callback_shuffle(
        ctx: Context<VrfCallbackShuffle>,
        randomness: [u8; 32],
    ) -> Result<()> {
        let deck = &mut ctx.accounts.deck;
        require!(
            deck.contributed.iter().all(|c| *c),
            HoldemError::EntropyIncomplete
        );
        require!(!deck.vrf_seen, HoldemError::AlreadyDealt);
        deck.vrf = randomness;
        deck.vrf_seen = true;
        Ok(())
    }

    /// Rollup. Shuffles from `H(entropy || vrf || hand)`, deals two cards to each Hole account
    /// and opens preflop betting. Anyone may call it once the VRF output is in.
    pub fn deal(ctx: Context<Deal>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let game_match = &mut ctx.accounts.game_match;
        let deck = &mut ctx.accounts.deck;
        require!(game_match.status == STATUS_LIVE, HoldemError::NotLive);
        require!(game_match.phase == PHASE_SHUFFLE, HoldemError::WrongPhase);
        require!(
            deck.hand_no == game_match.hand_no
                && deck.contributed.iter().all(|c| *c)
                && deck.vrf_seen,
            HoldemError::EntropyIncomplete
        );
        require!(!deck.dealt, HoldemError::AlreadyDealt);

        let seed = hashv(&[&deck.entropy, &deck.vrf, &game_match.hand_no.to_le_bytes()]).to_bytes();
        let mut cards = [0u8; DECK_SIZE];
        for (i, card) in cards.iter_mut().enumerate() {
            *card = i as u8;
        }
        for i in (1..DECK_SIZE).rev() {
            let digest = hashv(&[&seed, &(i as u64).to_le_bytes()]).to_bytes();
            let mut word = [0u8; 8];
            word.copy_from_slice(&digest[..8]);
            let bound = (i as u64).checked_add(1).ok_or(HoldemError::Overflow)?;
            let j = (u64::from_le_bytes(word) % bound) as usize;
            cards.swap(i, j);
        }
        deck.cards = cards;
        deck.dealt = true;

        let hand_no = game_match.hand_no;
        let holes = [[cards[0], cards[2]], [cards[1], cards[3]]];
        for (hole, cards) in [&mut ctx.accounts.hole_0, &mut ctx.accounts.hole_1]
            .into_iter()
            .zip(holes)
        {
            hole.cards = cards;
            hole.hand_no = hand_no;
            hole.dealt = true;
        }
        game_match.on_dealt(&cards, &holes, now)
    }

    /// Rollup. A Player acts on their turn.
    pub fn act(ctx: Context<Act>, action: Action) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let seat = seat_of(&ctx.accounts.game_match, &ctx.accounts.player.key())?;
        let holes = [ctx.accounts.hole_0.cards, ctx.accounts.hole_1.cards];
        ctx.accounts
            .game_match
            .act(seat, action, &ctx.accounts.deck.cards, &holes, now)
    }

    /// Rollup, permissionless. Once the current deadline has passed: an idle Player is checked
    /// (or folded when facing a bet); missing entropy cancels hand one (no-show, both entries
    /// refunded) or forfeits a later hand; three missed turns in a row forfeit the Match.
    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let game_match = &mut ctx.accounts.game_match;
        let deck = &ctx.accounts.deck;
        let contributed = if deck.hand_no == game_match.hand_no {
            deck.contributed
        } else {
            [false; 2]
        };
        let holes = [ctx.accounts.hole_0.cards, ctx.accounts.hole_1.cards];
        game_match.timeout(contributed, &deck.cards, &holes, now)
    }

    /// Rollup. After the Match is over (or cancelled): wipes the hidden accounts, closes their
    /// permissions and commits + undelegates everything back to the base layer. Whatever is in
    /// state at commit becomes public, hence the wipe.
    pub fn close_match(ctx: Context<CloseMatch>) -> Result<()> {
        let status = ctx.accounts.game_match.status;
        require!(
            status == STATUS_OVER || status == STATUS_CANCELLED,
            HoldemError::MatchNotOver
        );
        let match_key = ctx.accounts.game_match.key();
        ctx.accounts.deck.cards = [0; DECK_SIZE];
        ctx.accounts.deck.entropy = [0; 32];
        ctx.accounts.deck.vrf = [0; 32];
        ctx.accounts.hole_0.cards = [0; 2];
        ctx.accounts.hole_1.cards = [0; 2];
        ctx.accounts.deck.exit(&ID)?;
        ctx.accounts.hole_0.exit(&ID)?;
        ctx.accounts.hole_1.exit(&ID)?;

        close_permission(
            &*ctx.accounts,
            &ctx.accounts.deck.to_account_info(),
            &ctx.accounts.deck_permission,
            &[DECK_SEED, match_key.as_ref(), &[ctx.accounts.deck.bump]],
        )?;
        close_permission(
            &*ctx.accounts,
            &ctx.accounts.hole_0.to_account_info(),
            &ctx.accounts.hole_0_permission,
            &[
                HOLE_SEED,
                match_key.as_ref(),
                &[0],
                &[ctx.accounts.hole_0.bump],
            ],
        )?;
        close_permission(
            &*ctx.accounts,
            &ctx.accounts.hole_1.to_account_info(),
            &ctx.accounts.hole_1_permission,
            &[
                HOLE_SEED,
                match_key.as_ref(),
                &[1],
                &[ctx.accounts.hole_1.bump],
            ],
        )?;

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[
            ctx.accounts.game_match.to_account_info(),
            ctx.accounts.deck.to_account_info(),
            ctx.accounts.hole_0.to_account_info(),
            ctx.accounts.hole_1.to_account_info(),
        ])
        .build_and_invoke()?;
        Ok(())
    }

    /// Base layer, permissionless. Settles the tesoro_core Match from the committed result by CPI,
    /// signing as this Game's `authority` PDA: the winner takes the Pot minus fees. A cancelled
    /// Match, or one never started before its start deadline, refunds both entries.
    /// This only STARTS the settlement in tesoro_core; the payouts follow in `match_chunk` calls
    /// anyone may make.
    pub fn finalize<'info>(ctx: Context<'_, '_, 'info, 'info, Finalize<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (status, winner, start_deadline, authority_bump) = {
            let m = &ctx.accounts.game_match;
            (m.status, m.winner, m.start_deadline, m.authority_bump)
        };
        require!(
            !ctx.accounts.game_match.finalized,
            HoldemError::AlreadyFinalized
        );

        let bump = [authority_bump];
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &bump]];
        let remaining = ctx.remaining_accounts.to_vec();
        match status {
            STATUS_OVER => {
                let cpi = CpiContext::new_with_signer(
                    ctx.accounts.tesoro_program.to_account_info(),
                    tesoro_core::cpi::accounts::SettleMatch {
                        game_authority: ctx.accounts.authority.to_account_info(),
                        payer: ctx.accounts.caller.to_account_info(),
                        config: ctx.accounts.config.to_account_info(),
                        game_record: ctx.accounts.game_record.to_account_info(),
                        game_program: ctx.accounts.game_program.to_account_info(),
                        program_data: ctx.accounts.program_data.to_account_info(),
                        match_state: ctx.accounts.tesoro_match.to_account_info(),
                        receipt: ctx.accounts.receipt.to_account_info(),
                        system_program: ctx.accounts.system_program.to_account_info(),
                        event_authority: ctx.accounts.event_authority.to_account_info(),
                        program: ctx.accounts.tesoro_program.to_account_info(),
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
            STATUS_CANCELLED | STATUS_CREATED => {
                if status == STATUS_CREATED {
                    require!(now > start_deadline, HoldemError::NotTimedOut);
                }
                let cpi = CpiContext::new_with_signer(
                    ctx.accounts.tesoro_program.to_account_info(),
                    tesoro_core::cpi::accounts::RefundMatch {
                        caller: ctx.accounts.authority.to_account_info(),
                        payer: ctx.accounts.caller.to_account_info(),
                        game_record: ctx.accounts.game_record.to_account_info(),
                        game_program: ctx.accounts.game_program.to_account_info(),
                        program_data: ctx.accounts.program_data.to_account_info(),
                        match_state: ctx.accounts.tesoro_match.to_account_info(),
                        receipt: ctx.accounts.receipt.to_account_info(),
                        opener_protections: None,
                        system_program: ctx.accounts.system_program.to_account_info(),
                        event_authority: ctx.accounts.event_authority.to_account_info(),
                        program: ctx.accounts.tesoro_program.to_account_info(),
                    },
                    signer_seeds,
                )
                .with_remaining_accounts(remaining);
                tesoro_core::cpi::refund_match(cpi)?;
            }
            _ => return err!(HoldemError::MatchNotOver),
        }
        ctx.accounts.game_match.finalized = true;
        Ok(())
    }
}

/// The only delegation config the Game accepts: the TEE validator, and no automatic commits (an
/// automatic commit would publish the hidden accounts to the base layer mid-Match).
fn tee_config(validator: &Option<AccountInfo>) -> Result<DelegateConfig> {
    require!(
        validator.as_ref().is_some_and(|v| v.key() == TEE_VALIDATOR),
        HoldemError::InvalidValidator
    );
    Ok(DelegateConfig {
        validator: Some(TEE_VALIDATOR),
        commit_frequency_ms: u32::MAX,
    })
}

fn seat_of(game_match: &GameMatch, key: &Pubkey) -> Result<usize> {
    game_match
        .players
        .iter()
        .position(|p| p == key)
        .ok_or_else(|| error!(HoldemError::NotAPlayer))
}

/// Every permission CPI is signed by the permissioned PDA itself, which also pays the rent.
fn create_permission<'info, T: PermissionAccounts<'info>>(
    accounts: &T,
    data: &AccountInfo<'info>,
    permission: &UncheckedAccount<'info>,
    args: EphemeralMembersArgs,
    seeds: &[&[u8]],
) -> Result<()> {
    if permission.lamports() > 0 {
        return require_real_permission(
            permission,
            data.key,
            error!(HoldemError::PermissionNotReady),
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
pub struct CreateMatch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [MATCH_SEED, tesoro_match.inner.id.opener.as_ref(), &tesoro_match.inner.id.n.to_le_bytes()],
        bump = tesoro_match.bump,
        seeds::program = tesoro_core::ID
    )]
    pub tesoro_match: Box<Account<'info, MatchState>>,
    #[account(
        seeds = [GAME_SEED, crate::ID.as_ref()],
        bump = game_record.bump,
        seeds::program = tesoro_core::ID
    )]
    pub game_record: Box<Account<'info, GameRecord>>,
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
        init, payer = creator, space = 8 + GameMatch::INIT_SPACE,
        seeds = [MATCH_SEED, tesoro_match.key().as_ref()], bump
    )]
    pub game_match: Account<'info, GameMatch>,
    #[account(
        init, payer = creator, space = 8 + Deck::INIT_SPACE,
        seeds = [DECK_SEED, game_match.key().as_ref()], bump
    )]
    pub deck: Account<'info, Deck>,
    #[account(
        init, payer = creator, space = 8 + Hole::INIT_SPACE,
        seeds = [HOLE_SEED, game_match.key().as_ref(), &[0]], bump
    )]
    pub hole_0: Account<'info, Hole>,
    #[account(
        init, payer = creator, space = 8 + Hole::INIT_SPACE,
        seeds = [HOLE_SEED, game_match.key().as_ref(), &[1]], bump
    )]
    pub hole_1: Account<'info, Hole>,
    pub tesoro_program: Program<'info, tesoro_core::program::TesoroCore>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(tesoro_match: Pubkey)]
pub struct DelegateMatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Match PDA to delegate
    #[account(mut, del, seeds = [MATCH_SEED, tesoro_match.as_ref()], bump)]
    pub game_match: AccountInfo<'info>,
    /// CHECK: Deck PDA to delegate
    #[account(mut, del, seeds = [DECK_SEED, game_match.key().as_ref()], bump)]
    pub deck: AccountInfo<'info>,
    /// CHECK: Hole PDA (seat 0) to delegate
    #[account(mut, del, seeds = [HOLE_SEED, game_match.key().as_ref(), &[0]], bump)]
    pub hole_0: AccountInfo<'info>,
    /// CHECK: Hole PDA (seat 1) to delegate
    #[account(mut, del, seeds = [HOLE_SEED, game_match.key().as_ref(), &[1]], bump)]
    pub hole_1: AccountInfo<'info>,
    /// CHECK: TEE validator identity, checked by the delegation program
    pub validator: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
pub struct InitPermissions<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [MATCH_SEED, game_match.tesoro_match.as_ref()], bump = game_match.bump)]
    pub game_match: Account<'info, GameMatch>,
    #[account(mut, seeds = [DECK_SEED, game_match.key().as_ref()], bump = deck.bump)]
    pub deck: Account<'info, Deck>,
    #[account(mut, seeds = [HOLE_SEED, game_match.key().as_ref(), &[0]], bump = hole_0.bump)]
    pub hole_0: Account<'info, Hole>,
    #[account(mut, seeds = [HOLE_SEED, game_match.key().as_ref(), &[1]], bump = hole_1.bump)]
    pub hole_1: Account<'info, Hole>,
    /// CHECK: permission PDA of the Match, verified by the permission program
    #[account(mut, seeds = [PERMISSION_SEED, game_match.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub match_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the Deck
    #[account(mut, seeds = [PERMISSION_SEED, deck.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub deck_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Hole 0
    #[account(mut, seeds = [PERMISSION_SEED, hole_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hole_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Hole 1
    #[account(mut, seeds = [PERMISSION_SEED, hole_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hole_1_permission: UncheckedAccount<'info>,
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
    #[account(seeds = [MATCH_SEED, game_match.tesoro_match.as_ref()], bump = game_match.bump)]
    pub game_match: Account<'info, GameMatch>,
    #[account(mut, seeds = [DECK_SEED, game_match.key().as_ref()], bump = deck.bump)]
    pub deck: Account<'info, Deck>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestVrf<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [MATCH_SEED, game_match.tesoro_match.as_ref()], bump = game_match.bump)]
    pub game_match: Account<'info, GameMatch>,
    #[account(seeds = [DECK_SEED, game_match.key().as_ref()], bump = deck.bump)]
    pub deck: Account<'info, Deck>,
    /// CHECK: validated by the VRF program
    #[account(mut, address = ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct VrfCallbackShuffle<'info> {
    #[account(mut, seeds = [DECK_SEED, deck.game_match.as_ref()], bump = deck.bump)]
    pub deck: Account<'info, Deck>,
}

#[derive(Accounts)]
pub struct Deal<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [MATCH_SEED, game_match.tesoro_match.as_ref()], bump = game_match.bump)]
    pub game_match: Account<'info, GameMatch>,
    #[account(mut, seeds = [DECK_SEED, game_match.key().as_ref()], bump = deck.bump)]
    pub deck: Account<'info, Deck>,
    #[account(mut, seeds = [HOLE_SEED, game_match.key().as_ref(), &[0]], bump = hole_0.bump)]
    pub hole_0: Account<'info, Hole>,
    #[account(mut, seeds = [HOLE_SEED, game_match.key().as_ref(), &[1]], bump = hole_1.bump)]
    pub hole_1: Account<'info, Hole>,
}

#[derive(Accounts)]
pub struct Act<'info> {
    pub player: Signer<'info>,
    #[account(mut, seeds = [MATCH_SEED, game_match.tesoro_match.as_ref()], bump = game_match.bump)]
    pub game_match: Account<'info, GameMatch>,
    #[account(seeds = [DECK_SEED, game_match.key().as_ref()], bump = deck.bump)]
    pub deck: Account<'info, Deck>,
    #[account(seeds = [HOLE_SEED, game_match.key().as_ref(), &[0]], bump = hole_0.bump)]
    pub hole_0: Account<'info, Hole>,
    #[account(seeds = [HOLE_SEED, game_match.key().as_ref(), &[1]], bump = hole_1.bump)]
    pub hole_1: Account<'info, Hole>,
}

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [MATCH_SEED, game_match.tesoro_match.as_ref()], bump = game_match.bump)]
    pub game_match: Account<'info, GameMatch>,
    #[account(seeds = [DECK_SEED, game_match.key().as_ref()], bump = deck.bump)]
    pub deck: Account<'info, Deck>,
    #[account(seeds = [HOLE_SEED, game_match.key().as_ref(), &[0]], bump = hole_0.bump)]
    pub hole_0: Account<'info, Hole>,
    #[account(seeds = [HOLE_SEED, game_match.key().as_ref(), &[1]], bump = hole_1.bump)]
    pub hole_1: Account<'info, Hole>,
}

#[commit]
#[derive(Accounts)]
pub struct CloseMatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [MATCH_SEED, game_match.tesoro_match.as_ref()], bump = game_match.bump)]
    pub game_match: Account<'info, GameMatch>,
    #[account(mut, seeds = [DECK_SEED, game_match.key().as_ref()], bump = deck.bump)]
    pub deck: Account<'info, Deck>,
    #[account(mut, seeds = [HOLE_SEED, game_match.key().as_ref(), &[0]], bump = hole_0.bump)]
    pub hole_0: Account<'info, Hole>,
    #[account(mut, seeds = [HOLE_SEED, game_match.key().as_ref(), &[1]], bump = hole_1.bump)]
    pub hole_1: Account<'info, Hole>,
    /// CHECK: permission PDA of the Deck
    #[account(mut, seeds = [PERMISSION_SEED, deck.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub deck_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Hole 0
    #[account(mut, seeds = [PERMISSION_SEED, hole_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hole_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Hole 1
    #[account(mut, seeds = [PERMISSION_SEED, hole_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hole_1_permission: UncheckedAccount<'info>,
    /// CHECK: Permission Program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    /// Pays the settlement receipt's rent in tesoro_core.
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [MATCH_SEED, game_match.tesoro_match.as_ref()], bump = game_match.bump)]
    pub game_match: Account<'info, GameMatch>,
    #[account(
        mut,
        address = game_match.tesoro_match,
        seeds = [MATCH_SEED, tesoro_match.inner.id.opener.as_ref(), &tesoro_match.inner.id.n.to_le_bytes()],
        bump = tesoro_match.bump,
        seeds::program = tesoro_core::ID
    )]
    pub tesoro_match: Box<Account<'info, MatchState>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, seeds::program = tesoro_core::ID)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [GAME_SEED, crate::ID.as_ref()],
        bump = game_record.bump,
        seeds::program = tesoro_core::ID
    )]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: the registered Game authority; signs the CPI with its stored canonical bump.
    #[account(seeds = [AUTHORITY_SEED], bump = game_match.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: this Game's own program account (tesoro_core reads its deploy slot).
    #[account(address = crate::ID)]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: this program's ProgramData, checked by tesoro_core.
    pub program_data: UncheckedAccount<'info>,
    /// CHECK: the settlement receipt, created by tesoro_core at `["settled", match]`.
    #[account(
        mut,
        seeds = [b"settled", tesoro_match.key().as_ref()],
        bump,
        seeds::program = tesoro_core::ID
    )]
    pub receipt: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: tesoro_core's event authority PDA.
    #[account(seeds = [b"__event_authority"], bump, seeds::program = tesoro_core::ID)]
    pub event_authority: UncheckedAccount<'info>,
    pub tesoro_program: Program<'info, tesoro_core::program::TesoroCore>,
}
