//! S1 spike: hidden deck, private hole cards and settlement round-trip on a MagicBlock
//! Private Ephemeral Rollup (TEE). No poker rules live here, only the plumbing the real
//! Hold'em program needs.
//!
//! Randomness design: the deck seed is `H(entropy || vrf)` where `entropy` folds in one secret
//! from each Player, submitted inside the TEE, and `vrf` is the MagicBlock VRF output delivered
//! by callback into the private Deck account. Neither value ever appears on the base layer, and
//! the Deck account has a private permission with no readable member.

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

declare_id!("CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE");

pub const MATCH_SEED: &[u8] = b"match";
pub const DECK_SEED: &[u8] = b"deck";
pub const HOLE_SEED: &[u8] = b"hole";

const DECK_SIZE: usize = 52;
const READ_FLAGS: u8 = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;

#[error_code]
pub enum HoldemError {
    #[msg("Signer is not a Player of this Match")]
    NotAPlayer,
    #[msg("Invalid seat")]
    InvalidSeat,
    #[msg("Entropy already contributed for this seat")]
    AlreadyContributed,
    #[msg("Both Players must contribute entropy first")]
    EntropyIncomplete,
    #[msg("Deck already dealt")]
    AlreadyDealt,
    #[msg("Match already settled")]
    AlreadySettled,
    #[msg("Match not settled")]
    NotSettled,
    #[msg("Invalid winner")]
    InvalidWinner,
    #[msg("Arithmetic overflow")]
    Overflow,
}

#[ephemeral]
#[program]
pub mod holdem {
    use super::*;

    /// Base layer. Creates the Match, Deck and both Hole accounts and pre-funds each with the
    /// rent of its ephemeral permission, which the delegated PDA pays on the rollup.
    pub fn create_match(ctx: Context<CreateMatch>, match_id: u64, opponent: Pubkey) -> Result<()> {
        let permission_rent = ephemeral_rollups_sdk::ephemeral_accounts::rent(
            EphemeralPermission::size_of(2) as u32,
        );
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

        let game_match = &mut ctx.accounts.game_match;
        game_match.bump = ctx.bumps.game_match;
        game_match.match_id = match_id;
        game_match.players = [ctx.accounts.creator.key(), opponent];

        let deck = &mut ctx.accounts.deck;
        deck.bump = ctx.bumps.deck;
        deck.game_match = match_key;

        let hole_0 = &mut ctx.accounts.hole_0;
        hole_0.bump = ctx.bumps.hole_0;
        hole_0.game_match = match_key;
        hole_0.player = ctx.accounts.creator.key();

        let hole_1 = &mut ctx.accounts.hole_1;
        hole_1.bump = ctx.bumps.hole_1;
        hole_1.game_match = match_key;
        hole_1.player = opponent;
        Ok(())
    }

    /// Base layer. Delegates all four accounts to the TEE validator.
    pub fn delegate_match(ctx: Context<DelegateMatch>, match_id: u64) -> Result<()> {
        let config = || DelegateConfig {
            validator: ctx.accounts.validator.as_ref().map(|v| v.key()),
            ..Default::default()
        };
        let match_key = ctx.accounts.game_match.key();
        ctx.accounts.delegate_game_match(
            &ctx.accounts.payer,
            &[MATCH_SEED, &match_id.to_le_bytes()],
            config(),
        )?;
        ctx.accounts
            .delegate_deck(&ctx.accounts.payer, &[DECK_SEED, match_key.as_ref()], config())?;
        ctx.accounts.delegate_hole_0(
            &ctx.accounts.payer,
            &[HOLE_SEED, match_key.as_ref(), &[0]],
            config(),
        )?;
        ctx.accounts.delegate_hole_1(
            &ctx.accounts.payer,
            &[HOLE_SEED, match_key.as_ref(), &[1]],
            config(),
        )?;
        Ok(())
    }

    /// Rollup. Creates the four ephemeral permissions: the Match is visible to both Players,
    /// each Hole account only to its Player, the Deck to nobody.
    pub fn init_permissions(ctx: Context<InitPermissions>) -> Result<()> {
        let players = ctx.accounts.game_match.players;
        let match_key = ctx.accounts.game_match.key();
        let match_id = ctx.accounts.game_match.match_id.to_le_bytes();

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
            &[MATCH_SEED, &match_id, &[ctx.accounts.game_match.bump]],
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
            &[HOLE_SEED, match_key.as_ref(), &[0], &[ctx.accounts.hole_0.bump]],
        )?;
        create_permission(
            &*ctx.accounts,
            &ctx.accounts.hole_1.to_account_info(),
            &ctx.accounts.hole_1_permission,
            EphemeralMembersArgs {
                is_private: true,
                members: vec![player_member(players[1])],
            },
            &[HOLE_SEED, match_key.as_ref(), &[1], &[ctx.accounts.hole_1.bump]],
        )?;
        Ok(())
    }

    /// Rollup. A Player folds a secret into the deck entropy. The secret only ever exists in
    /// this transaction (inside the TEE) and in the private Deck account.
    pub fn contribute_entropy(
        ctx: Context<ContributeEntropy>,
        seat: u8,
        secret: [u8; 32],
    ) -> Result<()> {
        let index = usize::from(seat);
        require!(index < 2, HoldemError::InvalidSeat);
        require_keys_eq!(
            ctx.accounts.player.key(),
            ctx.accounts.game_match.players[index],
            HoldemError::NotAPlayer
        );
        let deck = &mut ctx.accounts.deck;
        require!(!deck.contributed[index], HoldemError::AlreadyContributed);
        deck.entropy = hashv(&[&deck.entropy, &secret, &[seat]]).to_bytes();
        deck.contributed[index] = true;
        Ok(())
    }

    /// Rollup. Requests VRF randomness from the delegated oracle queue; the oracle calls back
    /// into `vrf_callback_shuffle` inside the rollup.
    pub fn request_vrf(ctx: Context<RequestVrf>, client_seed: u8) -> Result<()> {
        require!(
            ctx.accounts.deck.contributed.iter().all(|c| *c),
            HoldemError::EntropyIncomplete
        );
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::VrfCallbackShuffle::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
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

    /// Rollup. VRF callback: the output is written only into the private Deck account.
    pub fn vrf_callback_shuffle(
        ctx: Context<VrfCallbackShuffle>,
        randomness: [u8; 32],
    ) -> Result<()> {
        let deck = &mut ctx.accounts.deck;
        deck.vrf = randomness;
        deck.vrf_seen = true;
        Ok(())
    }

    /// Rollup. Shuffles from `H(entropy || vrf)` and deals two cards to each Hole account.
    pub fn deal(ctx: Context<Deal>) -> Result<()> {
        let deck = &mut ctx.accounts.deck;
        require!(
            deck.contributed.iter().all(|c| *c),
            HoldemError::EntropyIncomplete
        );
        require!(!deck.dealt, HoldemError::AlreadyDealt);

        let seed = hashv(&[&deck.entropy, &deck.vrf]).to_bytes();
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
        deck.next = 4;
        deck.dealt = true;

        ctx.accounts.hole_0.cards = [cards[0], cards[2]];
        ctx.accounts.hole_1.cards = [cards[1], cards[3]];
        ctx.accounts.hole_0.dealt = true;
        ctx.accounts.hole_1.dealt = true;

        ctx.accounts.game_match.vrf_mixed = deck.vrf_seen;
        ctx.accounts.game_match.dealt = true;
        Ok(())
    }

    /// Rollup. Wipes the hidden state, closes its permissions and returns the Deck and Hole
    /// accounts to the base layer so their rent is recoverable.
    pub fn close_hand(ctx: Context<CloseHand>) -> Result<()> {
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
            &[HOLE_SEED, match_key.as_ref(), &[0], &[ctx.accounts.hole_0.bump]],
        )?;
        close_permission(
            &*ctx.accounts,
            &ctx.accounts.hole_1.to_account_info(),
            &ctx.accounts.hole_1_permission,
            &[HOLE_SEED, match_key.as_ref(), &[1], &[ctx.accounts.hole_1.bump]],
        )?;

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[
            ctx.accounts.deck.to_account_info(),
            ctx.accounts.hole_0.to_account_info(),
            ctx.accounts.hole_1.to_account_info(),
        ])
        .build_and_invoke()?;
        Ok(())
    }

    /// Rollup. Records the trivial result and commits + undelegates the Match to the base layer.
    pub fn settle(ctx: Context<Settle>, winner: u8) -> Result<()> {
        require!(winner <= 2, HoldemError::InvalidWinner);
        let game_match = &mut ctx.accounts.game_match;
        require!(!game_match.settled, HoldemError::AlreadySettled);
        game_match.winner = winner;
        game_match.settled = true;
        game_match.exit(&ID)?;

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.game_match.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Base layer. Stand-in for what tesoro_core will do: read the committed result.
    pub fn read_result(ctx: Context<ReadResult>) -> Result<()> {
        let game_match = &ctx.accounts.game_match;
        require!(game_match.settled, HoldemError::NotSettled);
        msg!(
            "match {} settled on base layer: winner={} vrf_mixed={}",
            game_match.match_id,
            game_match.winner,
            game_match.vrf_mixed
        );
        anchor_lang::solana_program::program::set_return_data(&[game_match.winner]);
        Ok(())
    }
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
        return Ok(());
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
impl_permission_accounts!(CloseHand);

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CreateMatch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init, payer = creator, space = 8 + GameMatch::INIT_SPACE,
        seeds = [MATCH_SEED, &match_id.to_le_bytes()], bump
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
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct DelegateMatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Match PDA to delegate
    #[account(mut, del, seeds = [MATCH_SEED, &match_id.to_le_bytes()], bump)]
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
    #[account(mut, seeds = [MATCH_SEED, &game_match.match_id.to_le_bytes()], bump = game_match.bump)]
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
    #[account(seeds = [MATCH_SEED, &game_match.match_id.to_le_bytes()], bump = game_match.bump)]
    pub game_match: Account<'info, GameMatch>,
    #[account(mut, seeds = [DECK_SEED, game_match.key().as_ref()], bump = deck.bump)]
    pub deck: Account<'info, Deck>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestVrf<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [MATCH_SEED, &game_match.match_id.to_le_bytes()], bump = game_match.bump)]
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
    #[account(mut, seeds = [MATCH_SEED, &game_match.match_id.to_le_bytes()], bump = game_match.bump)]
    pub game_match: Account<'info, GameMatch>,
    #[account(mut, seeds = [DECK_SEED, game_match.key().as_ref()], bump = deck.bump)]
    pub deck: Account<'info, Deck>,
    #[account(mut, seeds = [HOLE_SEED, game_match.key().as_ref(), &[0]], bump = hole_0.bump)]
    pub hole_0: Account<'info, Hole>,
    #[account(mut, seeds = [HOLE_SEED, game_match.key().as_ref(), &[1]], bump = hole_1.bump)]
    pub hole_1: Account<'info, Hole>,
}

#[commit]
#[derive(Accounts)]
pub struct CloseHand<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [MATCH_SEED, &game_match.match_id.to_le_bytes()], bump = game_match.bump)]
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

#[commit]
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [MATCH_SEED, &game_match.match_id.to_le_bytes()], bump = game_match.bump,
        constraint = game_match.players.contains(&payer.key()) @ HoldemError::NotAPlayer
    )]
    pub game_match: Account<'info, GameMatch>,
}

#[derive(Accounts)]
pub struct ReadResult<'info> {
    #[account(seeds = [MATCH_SEED, &game_match.match_id.to_le_bytes()], bump = game_match.bump)]
    pub game_match: Account<'info, GameMatch>,
}

#[account]
#[derive(InitSpace)]
pub struct GameMatch {
    pub bump: u8,
    pub match_id: u64,
    pub players: [Pubkey; 2],
    pub dealt: bool,
    pub vrf_mixed: bool,
    pub settled: bool,
    /// 0 = player 0, 1 = player 1, 2 = draw
    pub winner: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Deck {
    pub bump: u8,
    pub game_match: Pubkey,
    pub entropy: [u8; 32],
    pub contributed: [bool; 2],
    pub vrf_seen: bool,
    pub vrf: [u8; 32],
    pub dealt: bool,
    pub next: u8,
    pub cards: [u8; DECK_SIZE],
}

#[account]
#[derive(InitSpace)]
pub struct Hole {
    pub bump: u8,
    pub game_match: Pubkey,
    pub player: Pubkey,
    pub dealt: bool,
    pub cards: [u8; 2],
}
