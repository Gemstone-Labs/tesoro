//! Retiring the money accounts of the world before the yield-by-math reset (ADR 0010, ticket 11).
//!
//! `tesoro_core` is upgraded in place, and the new `PositionState`, `NativeCustody` and `Treasury`
//! are longer than the accounts already on chain, so those can no longer be read. Only this program
//! can close the accounts it owns, so the admin retires them here, once, after the upgrade.
//!
//! Every instruction is admin only (`Config.admin`), pays the rent to the admin, and refuses
//! anything that is not provably of the old world:
//!
//! * Position, custody, Treasury, old Offer: shorter than the current layout (a current one is
//!   never closable). The checks read raw bytes; old layouts are never deserialized as new types.
//! * Source: its Position account is gone or is itself old-sized.
//! * Holding: its Source account is gone. The Holding's Gemas leave the owner's Account totals.
//! * Offer of the current layout: every Source it reserves from is gone.
//! * Request: from before the reset (expiring before `RETIRE_REQUESTS_BEFORE`), past its lifetime
//!   and the window to use an accepted Backing. Requests of the new world are never closable.
//!
//! Order: custodies and Positions, then Sources, then Holdings, then Offers and Requests; the
//! Treasury at any time (its vault and Account stay, `init_treasury` recreates the Treasury).

use crate::error::{core_err, TesoroError};
use crate::ledger::{CoreError, BACKING_TTL_SECS};
use crate::state::*;
use crate::util::now;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::system_program;
use anchor_spl::associated_token::{self, get_associated_token_address, AssociatedToken, Create};
use anchor_spl::token::spl_token::state::Account as SplTokenAccount;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

/// What an old per-Position custody holds up to its vault address:
/// `disc(8) bump vault_bump position(32) owner_authority(32) pool(32) mint(32) vault(32)`.
const CUSTODY_PREFIX: usize = 8 + 2 + 5 * 32;
const CUSTODY_POSITION: usize = 10;
const CUSTODY_OWNER: usize = 42;
const CUSTODY_MINT: usize = 106;
const CUSTODY_VAULT: usize = 138;

/// Requests expiring before 2026-10-20 00:00 UTC were all opened before the reset upgrade.
pub const RETIRE_REQUESTS_BEFORE: i64 = 1_792_454_400;

pub const RETIRED_CUSTODY: u8 = 0;
pub const RETIRED_POSITION: u8 = 1;
pub const RETIRED_SOURCE: u8 = 2;
pub const RETIRED_HOLDING: u8 = 3;
pub const RETIRED_REQUEST: u8 = 4;
pub const RETIRED_OFFER: u8 = 5;
pub const RETIRED_TREASURY: u8 = 6;

/// True when the address holds nothing a program owns: closed, or never created.
fn is_gone(info: &AccountInfo) -> bool {
    info.owner == &system_program::ID && info.data_is_empty()
}

/// True for an account of this program, with this discriminator, shorter than the current layout.
fn is_stale(info: &AccountInfo, discriminator: &[u8], space: usize) -> bool {
    if info.owner != &crate::ID {
        return false;
    }
    match info.try_borrow_data() {
        Ok(data) => data.len() >= 8 && data.len() < space && data[..8] == *discriminator,
        Err(_) => false,
    }
}

/// Moves all lamports to `dest` and hands the account back to the system program, as `close` does.
fn close_to<'info>(info: &AccountInfo<'info>, dest: &AccountInfo<'info>) -> Result<()> {
    let moved = info.lamports();
    let total = dest
        .lamports()
        .checked_add(moved)
        .ok_or(TesoroError::NotOldWorld)?;
    **dest.try_borrow_mut_lamports()? = total;
    **info.try_borrow_mut_lamports()? = 0;
    info.assign(&system_program::ID);
    info.resize(0)?;
    Ok(())
}

fn key_at(data: &[u8], at: usize) -> Pubkey {
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&data[at..at + 32]);
    Pubkey::new_from_array(bytes)
}

// --- Native custody and its vault ----------------------------------------------------------

/// Sends the simSOL of an old per-Position vault (`["native_vault", position]`) to the Position
/// owner's simSOL account, closes the vault and the old custody (`["native", position]`). The
/// owner's account is their associated token account, created (admin pays) if it is gone.
#[derive(Accounts)]
pub struct RetireNativeCustody<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: an old per-Position custody, validated from its raw bytes and PDA seeds.
    #[account(mut)]
    pub custody: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: the wallet recorded in the custody as the Position's owner.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: the owner's simSOL associated token account, checked by address and, when present, by content.
    #[account(mut)]
    pub owner_token: UncheckedAccount<'info>,
    #[account(address = SIM_SOL_MINT @ TesoroError::InvalidMint)]
    pub mint: Box<Account<'info, anchor_spl::token::Mint>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn retire_native_custody(ctx: Context<RetireNativeCustody>) -> Result<()> {
    let a = &ctx.accounts;
    let custody = a.custody.to_account_info();
    require!(custody.owner == &crate::ID, TesoroError::NotOldWorld);
    let (position, owner, mint, vault, bump) = {
        let data = custody.try_borrow_data()?;
        require!(
            data.len() >= CUSTODY_PREFIX + 32
                && data.len() != NativeCustody::SPACE
                && data[..8] == *NativeCustody::DISCRIMINATOR,
            TesoroError::NotOldWorld
        );
        (
            key_at(&data, CUSTODY_POSITION),
            key_at(&data, CUSTODY_OWNER),
            key_at(&data, CUSTODY_MINT),
            key_at(&data, CUSTODY_VAULT),
            data[8],
        )
    };
    let (custody_key, canonical) =
        Pubkey::find_program_address(&[NATIVE_SEED, position.as_ref()], &crate::ID);
    require_keys_eq!(custody_key, custody.key(), TesoroError::InvalidAccount);
    require!(canonical == bump, TesoroError::InvalidAccount);
    let (vault_key, _) =
        Pubkey::find_program_address(&[NATIVE_VAULT_SEED, position.as_ref()], &crate::ID);
    require_keys_eq!(vault_key, vault, TesoroError::InvalidAccount);
    require_keys_eq!(a.vault.key(), vault, TesoroError::InvalidAccount);
    require_keys_eq!(mint, SIM_SOL_MINT, TesoroError::InvalidMint);
    require_keys_eq!(a.vault.mint, SIM_SOL_MINT, TesoroError::InvalidMint);
    require_keys_eq!(a.vault.owner, custody_key, TesoroError::InvalidAccount);
    require_keys_eq!(a.owner.key(), owner, TesoroError::InvalidAccount);

    let owner_token = a.owner_token.to_account_info();
    require_keys_eq!(
        owner_token.key(),
        get_associated_token_address(&owner, &SIM_SOL_MINT),
        TesoroError::InvalidAccount
    );
    if is_gone(&owner_token) {
        associated_token::create_idempotent(CpiContext::new(
            a.associated_token_program.to_account_info(),
            Create {
                payer: a.admin.to_account_info(),
                associated_token: owner_token.clone(),
                authority: a.owner.to_account_info(),
                mint: a.mint.to_account_info(),
                system_program: a.system_program.to_account_info(),
                token_program: a.token_program.to_account_info(),
            },
        ))?;
    }
    require_keys_eq!(*owner_token.owner, token::ID, TesoroError::InvalidAccount);
    let destination = SplTokenAccount::unpack(&owner_token.try_borrow_data()?)?;
    require_keys_eq!(destination.mint, SIM_SOL_MINT, TesoroError::InvalidMint);
    require_keys_eq!(destination.owner, owner, TesoroError::InvalidAccount);

    let amount = a.vault.amount;
    let seeds: &[&[u8]] = &[NATIVE_SEED, position.as_ref(), &[bump]];
    if amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                Transfer {
                    from: a.vault.to_account_info(),
                    to: owner_token.clone(),
                    authority: custody.clone(),
                },
                &[seeds],
            ),
            amount,
        )?;
    }
    token::close_account(CpiContext::new_with_signer(
        a.token_program.to_account_info(),
        CloseAccount {
            account: a.vault.to_account_info(),
            destination: a.admin.to_account_info(),
            authority: custody.clone(),
        },
        &[seeds],
    ))?;
    close_to(&custody, &a.admin.to_account_info())?;
    emit!(OldAccountRetired {
        kind: RETIRED_CUSTODY,
        account: custody_key,
        amount,
    });
    Ok(())
}

// --- Position -------------------------------------------------------------------------------

/// Closes a Position shorter than the current layout. Its custody (if any) is retired apart, and
/// does not need the Position.
#[derive(Accounts)]
pub struct RetirePosition<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: validated as an old-sized `PositionState` from its raw bytes.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
}

pub(crate) fn retire_position(ctx: Context<RetirePosition>) -> Result<()> {
    let position = ctx.accounts.position.to_account_info();
    require!(
        is_stale(
            &position,
            PositionState::DISCRIMINATOR,
            PositionState::SPACE
        ),
        TesoroError::NotOldWorld
    );
    close_to(&position, &ctx.accounts.admin.to_account_info())?;
    emit!(OldAccountRetired {
        kind: RETIRED_POSITION,
        account: position.key(),
        amount: 0,
    });
    Ok(())
}

// --- Source and Holding ---------------------------------------------------------------------

/// Closes a Source whose Position is gone or old-sized.
#[derive(Accounts)]
pub struct RetireSource<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, close = admin)]
    pub source: Account<'info, SourceState>,
    /// CHECK: must be the Source's Position address; gone or old-sized.
    pub position: UncheckedAccount<'info>,
}

pub(crate) fn retire_source(ctx: Context<RetireSource>) -> Result<()> {
    let a = &ctx.accounts;
    let position = a.position.to_account_info();
    require_keys_eq!(
        position.key(),
        Pubkey::new_from_array(a.source.inner.position),
        TesoroError::InvalidAccount
    );
    require!(
        is_gone(&position)
            || is_stale(
                &position,
                PositionState::DISCRIMINATOR,
                PositionState::SPACE
            ),
        TesoroError::NotOldWorld
    );
    emit!(OldAccountRetired {
        kind: RETIRED_SOURCE,
        account: a.source.key(),
        amount: 0,
    });
    Ok(())
}

/// Closes a Holding whose Source is gone and takes its Gemas out of the Account's totals (the
/// Account keeps mirroring the sum of its Holdings).
#[derive(Accounts)]
pub struct RetireHolding<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, close = admin)]
    pub holding: Account<'info, HoldingState>,
    /// CHECK: must be the Holding's Source address; gone.
    pub source: UncheckedAccount<'info>,
    #[account(mut)]
    pub account: Account<'info, TesoroAccount>,
}

pub(crate) fn retire_holding(mut ctx: Context<RetireHolding>) -> Result<()> {
    let a = &mut ctx.accounts;
    require_keys_eq!(
        a.source.key(),
        Pubkey::new_from_array(a.holding.inner.source),
        TesoroError::InvalidAccount
    );
    require!(
        is_gone(&a.source.to_account_info()),
        TesoroError::NotOldWorld
    );
    require_keys_eq!(
        a.account.key(),
        a.holding.account,
        TesoroError::InvalidAccount
    );
    let amount = a.holding.inner.amount;
    let reserved = a.holding.inner.reserved;
    let totals = &mut a.account.inner;
    let (total, held_reserved) = if a.holding.inner.is_own {
        (&mut totals.own_total, &mut totals.own_reserved)
    } else {
        (&mut totals.won_total, &mut totals.won_reserved)
    };
    *total = total
        .checked_sub(amount)
        .ok_or_else(|| core_err(CoreError::Math))?;
    *held_reserved = held_reserved
        .checked_sub(reserved)
        .ok_or_else(|| core_err(CoreError::Math))?;
    emit!(OldAccountRetired {
        kind: RETIRED_HOLDING,
        account: a.holding.key(),
        amount,
    });
    Ok(())
}

// --- Request and Offer ----------------------------------------------------------------------

/// Closes a Request from before the reset that is dead in every status: past its lifetime plus
/// the window an accepted Backing has to be used.
#[derive(Accounts)]
pub struct RetireRequest<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, close = admin)]
    pub request: Account<'info, RequestState>,
}

pub(crate) fn retire_request(ctx: Context<RetireRequest>) -> Result<()> {
    let expires_at = ctx.accounts.request.inner.expires_at;
    require!(
        expires_at < RETIRE_REQUESTS_BEFORE,
        TesoroError::NotOldWorld
    );
    let dead_after = expires_at
        .checked_add(BACKING_TTL_SECS)
        .ok_or_else(|| core_err(CoreError::Math))?;
    require!(now()? > dead_after, TesoroError::NotOldWorld);
    emit!(OldAccountRetired {
        kind: RETIRED_REQUEST,
        account: ctx.accounts.request.key(),
        amount: 0,
    });
    Ok(())
}

/// Closes an Offer of the retired world: shorter than the current layout, or the longer one that
/// carried reserved lines. It holds no money of its own: the reservation lived in the Holdings.
#[derive(Accounts)]
pub struct RetireOffer<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: validated as an `OfferState` from its raw bytes.
    #[account(mut)]
    pub offer: UncheckedAccount<'info>,
}

pub(crate) fn retire_offer<'info>(
    ctx: Context<'_, '_, 'info, 'info, RetireOffer<'info>>,
) -> Result<()> {
    let offer = ctx.accounts.offer.to_account_info();
    // Every earlier Offer layout had another length (shorter, or longer with reserved lines).
    let other_layout = offer.owner == &crate::ID
        && offer.try_borrow_data().is_ok_and(|d| {
            d.len() >= 8 && d.len() != OfferState::SPACE && d[..8] == *OfferState::DISCRIMINATOR
        });
    require!(other_layout, TesoroError::NotOldWorld);
    close_to(&offer, &ctx.accounts.admin.to_account_info())?;
    emit!(OldAccountRetired {
        kind: RETIRED_OFFER,
        account: offer.key(),
        amount: 0,
    });
    Ok(())
}

// --- Treasury -------------------------------------------------------------------------------

/// Closes the Treasury while it still has the old, shorter layout. Its simSOL vault and its
/// Account keep their addresses and balances; `init_treasury` then creates the new Treasury.
#[derive(Accounts)]
pub struct RetireTreasury<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: the Treasury PDA, validated as an old-sized `Treasury` from its raw bytes.
    #[account(mut, seeds = [TREASURY_SEED], bump)]
    pub treasury: UncheckedAccount<'info>,
}

pub(crate) fn retire_treasury(ctx: Context<RetireTreasury>) -> Result<()> {
    let treasury = ctx.accounts.treasury.to_account_info();
    require!(
        is_stale(&treasury, Treasury::DISCRIMINATOR, Treasury::SPACE),
        TesoroError::NotOldWorld
    );
    close_to(&treasury, &ctx.accounts.admin.to_account_info())?;
    emit!(OldAccountRetired {
        kind: RETIRED_TREASURY,
        account: treasury.key(),
        amount: 0,
    });
    Ok(())
}
