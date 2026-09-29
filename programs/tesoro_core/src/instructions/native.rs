//! Solana-native Positions: the Principal is real simSOL (`sim_lst`) held in a vault that only this
//! program controls, and yield is read from the pool's rate instead of being reported by the oracle.
//!
//! Custody model (see `ledger::native` for the arithmetic). The vault of a Position (a token
//! account PDA, authority = its `NativeCustody`) holds the shares deposited at open. Shares leave
//! only by:
//!
//! * `redeem`: shares worth the redeemed accrued yield at the current rate go to the holder;
//! * `unlock` / `sweep_native_surplus`: everything beyond `ceil((Principal + owed yield) / rate)`
//!   (Principal is released only once Debt is zero; the owed yield of holders who have not redeemed
//!   yet stays in the vault, valued at the current rate, so a later redeem is always covered).
//!
//! Every payout ends by re-checking that the vault covers Principal (while Locked) plus the applied
//! but unredeemed yield. The oracle can never open, credit yield to, or unlock a native Position.

use crate::error::{core_err, TesoroError};
use crate::instructions::position::{chain_byte, issue_advance};
use crate::ledger::{self, native, CoreError, SourceChain};
use crate::state::*;
use crate::util::now;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use sim_lst::Pool;

/// A Solana Position backed by simSOL custody rather than by an oracle fact.
pub fn is_native(position: &ledger::Position) -> bool {
    position.source_chain == SourceChain::Solana && position.source_asset == SIM_SOL_MINT.to_bytes()
}

/// Position ids of native Positions are derived from their owner and a nonce so nobody else can
/// occupy an owner's id, and one owner can hold several.
pub fn native_position_id(owner_authority: &Pubkey, nonce: u64) -> [u8; 32] {
    hashv(&[b"native", owner_authority.as_ref(), &nonce.to_le_bytes()]).to_bytes()
}

// --- Price -----------------------------------------------------------------------------------

/// The oracle authority publishes the SOL/USD issuance price. Devnet stand-in for Pyth: the
/// feed account is the seam, `take_native_advance` only reads it.
#[derive(Accounts)]
pub struct SetPrice<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.oracle_authority == oracle.key() @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = oracle,
        space = PriceFeed::SPACE,
        seeds = [PRICE_SEED, SIM_SOL_MINT.as_ref()],
        bump
    )]
    pub price_feed: Account<'info, PriceFeed>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_price(ctx: Context<SetPrice>, price_micro_usd: u64) -> Result<()> {
    require!(price_micro_usd > 0, TesoroError::StalePrice);
    let feed = &mut ctx.accounts.price_feed;
    feed.bump = ctx.bumps.price_feed;
    feed.asset = SIM_SOL_MINT;
    feed.price_micro_usd = price_micro_usd;
    feed.updated_ts = now()?;
    emit!(PriceSet {
        asset: SIM_SOL_MINT,
        price_micro_usd,
    });
    Ok(())
}

// --- Open ------------------------------------------------------------------------------------

/// The owner deposits simSOL into the Position's vault. Principal is recorded in SOL at the
/// current sim_lst rate. No oracle involved.
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct OpenNativePosition<'info> {
    #[account(mut)]
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    /// The canonical sim_lst Pool: owned by the sim_lst program and at its `["pool"]` PDA.
    #[account(
        seeds = [sim_lst::POOL_SEED],
        seeds::program = sim_lst::ID,
        bump = pool.bump,
        constraint = pool.mint == SIM_SOL_MINT @ TesoroError::InvalidPool
    )]
    pub pool: Account<'info, Pool>,
    #[account(address = pool.mint @ TesoroError::InvalidMint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = owner_authority
    )]
    pub owner_token: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = owner_authority,
        space = PositionState::SPACE,
        seeds = [
            POSITION_SEED,
            &[chain_byte(SourceChain::Solana)],
            native_position_id(&owner_authority.key(), nonce).as_ref()
        ],
        bump
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        init,
        payer = owner_authority,
        space = NativeCustody::SPACE,
        seeds = [NATIVE_SEED, position.key().as_ref()],
        bump
    )]
    pub custody: Account<'info, NativeCustody>,
    #[account(
        init,
        payer = owner_authority,
        seeds = [NATIVE_VAULT_SEED, position.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = custody
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn open_native_position(
    mut ctx: Context<OpenNativePosition>,
    nonce: u64,
    lst_amount: u64,
) -> Result<()> {
    let a = &mut ctx.accounts;
    if lst_amount == 0 {
        return Err(core_err(CoreError::ZeroAmount));
    }
    let rate = sim_lst::current_rate(&a.pool, now()?)?;
    let principal = native::shares_value(lst_amount, rate).map_err(core_err)?;
    let rate_bps = u16::try_from(a.pool.apy_bps).map_err(|_| error!(TesoroError::InvalidPool))?;

    token::transfer(
        CpiContext::new(
            a.token_program.to_account_info(),
            Transfer {
                from: a.owner_token.to_account_info(),
                to: a.vault.to_account_info(),
                authority: a.owner_authority.to_account_info(),
            },
        ),
        lst_amount,
    )?;
    a.vault.reload()?;
    require_eq!(a.vault.amount, lst_amount, TesoroError::InvalidAccount);

    let position_key = a.position.key();
    a.position.bump = ctx.bumps.position;
    a.position.position_id = native_position_id(&a.owner_authority.key(), nonce);
    a.position.inner = ledger::Position::new(
        a.owner_account.key().to_bytes(),
        SourceChain::Solana,
        SIM_SOL_MINT.to_bytes(),
        a.mint.decimals,
        principal,
        rate_bps,
    )
    .map_err(core_err)?;

    a.custody.bump = ctx.bumps.custody;
    a.custody.vault_bump = ctx.bumps.vault;
    a.custody.position = position_key;
    a.custody.owner_authority = a.owner_authority.key();
    a.custody.pool = a.pool.key();
    a.custody.mint = a.mint.key();
    a.custody.vault = a.vault.key();
    a.custody.rate_at_open = rate;
    a.custody.deposited_shares = lst_amount;
    a.custody.redeemed_units = 0;

    emit!(NativePositionOpened {
        position: position_key,
        owner: a.owner_account.key(),
        shares: lst_amount,
        rate,
        principal_sol: principal,
    });
    Ok(())
}

// --- Advance ---------------------------------------------------------------------------------

/// An Advance against a native Position priced by the on-chain `PriceFeed`: the owner signs alone.
#[derive(Accounts)]
pub struct TakeNativeAdvance<'info> {
    #[account(mut)]
    pub owner_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized,
        constraint = is_native(&position.inner) @ TesoroError::NotNativePosition
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        seeds = [PRICE_SEED, SIM_SOL_MINT.as_ref()],
        bump = price_feed.bump,
        constraint = price_feed.asset.to_bytes() == position.inner.source_asset @ TesoroError::InvalidAccount
    )]
    pub price_feed: Account<'info, PriceFeed>,
    #[account(
        init,
        payer = owner_authority,
        space = SourceState::SPACE,
        seeds = [SOURCE_SEED, position.key().as_ref(), &position.inner.advances.to_le_bytes()],
        bump
    )]
    pub source: Account<'info, SourceState>,
    #[account(
        init,
        payer = owner_authority,
        space = HoldingState::SPACE,
        seeds = [HOLDING_SEED, owner_account.key().as_ref(), source.key().as_ref()],
        bump
    )]
    pub holding: Account<'info, HoldingState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn take_native_advance(
    mut ctx: Context<TakeNativeAdvance>,
    horizon_months: u8,
) -> Result<()> {
    let a = &mut ctx.accounts;
    let age = now()?
        .checked_sub(a.price_feed.updated_ts)
        .ok_or(TesoroError::StalePrice)?;
    require!(
        a.price_feed.price_micro_usd > 0 && (0..=MAX_PRICE_AGE_SECS).contains(&age),
        TesoroError::StalePrice
    );
    issue_advance(
        &mut a.position,
        &mut a.source,
        &mut a.holding,
        &mut a.owner_account,
        ctx.bumps.source,
        ctx.bumps.holding,
        horizon_months,
        a.price_feed.price_micro_usd,
    )
}

// --- Yield crank -----------------------------------------------------------------------------

/// Anyone can call. Cumulative accrued yield comes from the vault's shares and the pool's rate,
/// and is applied like the oracle's `YieldAccrued`: Debt is repaid first, the rest is free yield.
#[derive(Accounts)]
pub struct AccrueNativeYield<'info> {
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        seeds = [NATIVE_SEED, position.key().as_ref()],
        bump = custody.bump,
        constraint = custody.position == position.key() @ TesoroError::InvalidAccount
    )]
    pub custody: Account<'info, NativeCustody>,
    #[account(address = custody.vault @ TesoroError::InvalidAccount)]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = custody.pool @ TesoroError::InvalidPool)]
    pub pool: Account<'info, Pool>,
    /// The Position's open Advance, when it has one.
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Option<Account<'info, SourceState>>,
}

pub(crate) fn accrue_native_yield(mut ctx: Context<AccrueNativeYield>) -> Result<()> {
    let a = &mut ctx.accounts;
    let rate = sim_lst::current_rate(&a.pool, now()?)?;
    let cumulative = native::accrued_yield(
        a.vault.amount,
        rate,
        a.custody.redeemed_units,
        a.position.inner.principal,
    )
    .map_err(core_err)?;
    if cumulative <= a.position.inner.cumulative_yield {
        return Ok(());
    }
    let seq = a
        .position
        .inner
        .last_seq
        .checked_add(1)
        .ok_or(TesoroError::InvalidAccount)?;
    let position_key = a.position.key();
    let source = a.source.as_mut().map(|s| &mut s.inner);
    a.position
        .inner
        .apply_yield(source, seq, cumulative)
        .map_err(core_err)?;
    emit!(YieldApplied {
        position: position_key,
        seq,
        cumulative,
        debt_gemas: a.source.as_ref().map_or(0, |s| s.inner.debt()),
    });
    Ok(())
}

// --- Payouts ---------------------------------------------------------------------------------

/// The accounts a payout needs, loaded from `remaining_accounts` for the legacy `redeem` and
/// `unlock` instructions (whose fixed accounts cannot change): `[custody, vault, destination,
/// pool, token_program]`.
pub(crate) struct Custody<'info> {
    pub custody: Account<'info, NativeCustody>,
    pub vault: Account<'info, TokenAccount>,
    pub destination: Account<'info, TokenAccount>,
    pub pool: Account<'info, Pool>,
    pub token_program: AccountInfo<'info>,
}

pub(crate) fn load_custody<'info>(
    remaining: &'info [AccountInfo<'info>],
    position: &Pubkey,
    wallet: &Pubkey,
) -> Result<Custody<'info>> {
    let [custody_info, vault_info, dest_info, pool_info, token_program] = remaining else {
        return err!(TesoroError::BadRemainingAccounts);
    };
    require!(
        custody_info.is_writable && vault_info.is_writable && dest_info.is_writable,
        TesoroError::NotWritable
    );
    let custody = Account::<NativeCustody>::try_from(custody_info)?;
    let expected = Pubkey::create_program_address(
        &[NATIVE_SEED, position.as_ref(), &[custody.bump]],
        &crate::ID,
    )
    .map_err(|_| error!(TesoroError::InvalidAccount))?;
    require_keys_eq!(expected, *custody_info.key, TesoroError::InvalidAccount);
    require_keys_eq!(custody.position, *position, TesoroError::InvalidAccount);
    require_keys_eq!(*vault_info.key, custody.vault, TesoroError::InvalidAccount);
    let vault = Account::<TokenAccount>::try_from(vault_info)?;
    let destination = Account::<TokenAccount>::try_from(dest_info)?;
    require_keys_neq!(vault.key(), destination.key(), TesoroError::InvalidAccount);
    require_keys_eq!(destination.mint, custody.mint, TesoroError::InvalidMint);
    require_keys_eq!(destination.owner, *wallet, TesoroError::InvalidAccount);
    require_keys_eq!(*pool_info.key, custody.pool, TesoroError::InvalidPool);
    let pool = Account::<Pool>::try_from(pool_info)?;
    require_keys_eq!(*token_program.key, token::ID, TesoroError::InvalidAccount);
    Ok(Custody {
        custody,
        vault,
        destination,
        pool,
        token_program: token_program.clone(),
    })
}

fn pay_shares<'info>(c: &Custody<'info>, shares: u64) -> Result<()> {
    let seeds: &[&[u8]] = &[NATIVE_SEED, c.custody.position.as_ref(), &[c.custody.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            c.token_program.clone(),
            Transfer {
                from: c.vault.to_account_info(),
                to: c.destination.to_account_info(),
                authority: c.custody.to_account_info(),
            },
            &[seeds],
        ),
        shares,
    )
}

/// Pays a redeeming Gema holder `units` SOL of accrued yield, in simSOL at the current rate.
/// Never reduces below what Principal and the other holders' unredeemed yield need.
pub(crate) fn pay_redeem<'info>(
    position: &PositionState,
    position_key: &Pubkey,
    holder_authority: &Pubkey,
    units: u64,
    remaining: &'info [AccountInfo<'info>],
) -> Result<()> {
    let mut c = load_custody(remaining, position_key, holder_authority)?;
    let rate = sim_lst::current_rate(&c.pool, now()?)?;
    let shares = native::shares_for_units_floor(units, rate).map_err(core_err)?;
    if shares == 0 {
        return Err(core_err(CoreError::ZeroShares));
    }
    if c.vault.amount < shares {
        return Err(core_err(CoreError::VaultShortfall));
    }
    c.custody.redeemed_units = c
        .custody
        .redeemed_units
        .checked_add(units)
        .ok_or(TesoroError::InvalidAccount)?;
    pay_shares(&c, shares)?;
    c.vault.reload()?;
    native::check_cover(
        c.vault.amount,
        &position.inner,
        c.custody.redeemed_units,
        rate,
    )
    .map_err(core_err)?;
    c.custody.exit(&crate::ID)?;
    emit!(NativePayout {
        position: *position_key,
        to: c.destination.key(),
        shares,
        sol_units: units,
        kind: 0,
    });
    Ok(())
}

/// Returns to the owner everything the vault holds beyond the yield still owed to holders.
/// The Position must already be Unlocked (Debt zero).
pub(crate) fn release_surplus<'info>(
    position: &PositionState,
    position_key: &Pubkey,
    owner_authority: &Pubkey,
    remaining: &'info [AccountInfo<'info>],
    kind: u8,
) -> Result<()> {
    let mut c = load_custody(remaining, position_key, owner_authority)?;
    require_keys_eq!(
        c.custody.owner_authority,
        *owner_authority,
        TesoroError::Unauthorized
    );
    release(&mut c, position, position_key, kind)
}

pub(crate) fn release<'info>(
    c: &mut Custody<'info>,
    position: &PositionState,
    position_key: &Pubkey,
    kind: u8,
) -> Result<()> {
    let rate = sim_lst::current_rate(&c.pool, now()?)?;
    let surplus = native::surplus_shares(
        c.vault.amount,
        &position.inner,
        c.custody.redeemed_units,
        rate,
    )
    .map_err(core_err)?;
    if surplus > 0 {
        pay_shares(c, surplus)?;
        c.vault.reload()?;
    }
    native::check_cover(
        c.vault.amount,
        &position.inner,
        c.custody.redeemed_units,
        rate,
    )
    .map_err(core_err)?;
    emit!(NativePayout {
        position: *position_key,
        to: c.destination.key(),
        shares: surplus,
        sol_units: native::shares_value(surplus, rate).map_err(core_err)?,
        kind,
    });
    Ok(())
}

/// After Unlock the owner can reclaim whatever the vault holds beyond the yield still owed
/// (the owed part is valued at the current rate, so the reserve set at unlock shrinks as the
/// rate grows and holders redeem).
#[derive(Accounts)]
pub struct SweepNativeSurplus<'info> {
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        seeds = [NATIVE_SEED, position.key().as_ref()],
        bump = custody.bump,
        constraint = custody.position == position.key() @ TesoroError::InvalidAccount,
        constraint = custody.owner_authority == owner_authority.key() @ TesoroError::Unauthorized
    )]
    pub custody: Account<'info, NativeCustody>,
    #[account(mut, address = custody.vault @ TesoroError::InvalidAccount)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = custody.mint,
        token::authority = owner_authority
    )]
    pub owner_token: Account<'info, TokenAccount>,
    #[account(address = custody.pool @ TesoroError::InvalidPool)]
    pub pool: Account<'info, Pool>,
    pub token_program: Program<'info, Token>,
}

pub(crate) fn sweep_native_surplus(ctx: Context<SweepNativeSurplus>) -> Result<()> {
    let a = &ctx.accounts;
    let mut c = Custody {
        custody: a.custody.clone(),
        vault: a.vault.clone(),
        destination: a.owner_token.clone(),
        pool: a.pool.clone(),
        token_program: a.token_program.to_account_info(),
    };
    release(&mut c, &a.position, &a.position.key(), 2)
}
