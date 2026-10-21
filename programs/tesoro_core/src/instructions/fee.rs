//! Cash-in of the covered Platform and Studio fees (spec "Coverage counters", stories 37 and 38).
//!
//! A Source keeps one counter line for each fee class in its book account. Yield pays them before
//! the Source's holders (Platform, Studio, Leaderboard), and their ready part is cashed in by
//! anyone, to the recipient's wallet, as the staking-token shares it was worth when it landed (the
//! same rule as every Redeem, so a slash is carried by the recipient like by any holder).
//!
//! * `cash_in_fee(class)`: native and stake Sources, paid on Solana to the recipient's token account.
//! * `cash_in_fee_from_source(class, min_units)`: EVM Sources. Signed by the chain's registered
//!   source authority (the bridge), which pays the recipient on that chain: Solana debits the
//!   counter and records the units owed in `Source::redeemed_units` (and in `FeeCashedIn`), the
//!   same seam as `redeem_from_source`.
//! * `set_tesoro_studio`: the admin names the Account that receives the Studio Fee of Tesoro's own
//!   Games. A Source has one Studio counter for all of them, so its recipient is a setting; Studio
//!   Fees of listed outside studios are fee lines in their baskets and never come here.
//!
//! The Leaderboard counter is never paid to a wallet: on Solana `harvest` moves it into the prize
//! escrow; on an EVM route the bridge passes class 2 to `cash_in_fee_from_source`, which debits
//! it the same way (the Pool's Account stands in as the recipient) and the bridge moves the units
//! into the vault's escrow.
//! Prize Sources have no book, no counters and no `SourceState`, so they cannot be named.

use crate::books::OnchainBooks;
use crate::error::{core_err, TesoroError};
use crate::instructions::economy::*;
use crate::instructions::position::chain_byte;
use crate::ledger::draw::SourceBooks;
use crate::ledger::line_store::{CLASS_LEADERBOARD, CLASS_PLATFORM, CLASS_STUDIO};
use crate::ledger::{self, CoreError, SourceChain};
use crate::state::*;
use anchor_lang::prelude::*;

#[event]
pub struct FeeCashedIn {
    pub source: Pubkey,
    /// 0 Platform, 1 Studio.
    pub class: u8,
    /// The recipient's Tesoro Account.
    pub recipient: Pubkey,
    pub gemas: u64,
    pub shares: u64,
    /// What the shares were worth in the Source asset's units when paid (the bridge pays this
    /// on the source chain).
    pub units: u64,
}

/// Admin: the Account that receives the Studio Fee counters of Tesoro's own Games.
#[derive(Accounts)]
pub struct SetTesoroStudio<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [ECONOMY_SEED], bump = economy.bump)]
    pub economy: Account<'info, EconomyConfig>,
    #[account(
        seeds = [ACCOUNT_SEED, recipient_account.authority.as_ref()],
        bump = recipient_account.bump
    )]
    pub recipient_account: Account<'info, TesoroAccount>,
}

pub(crate) fn set_tesoro_studio(ctx: Context<SetTesoroStudio>) -> Result<()> {
    let a = ctx.accounts;
    // Like a listed Game's recipient: never the Pool or the Treasury.
    let r = a.recipient_account.authority;
    require!(
        r != reserved(TREASURY_SEED) && r != reserved(LEADERBOARD_SEED),
        TesoroError::StudioRecipientReserved
    );
    a.economy.tesoro_studio = a.recipient_account.key();
    Ok(())
}

fn reserved(seed: &[u8]) -> Pubkey {
    Pubkey::find_program_address(&[seed], &crate::ID).0
}

/// The recipient a fee class pays: Platform from Config, Studio from the economy settings.
fn fee_recipient(config: &Config, economy: &EconomyConfig, class: u8) -> Result<Pubkey> {
    match class {
        CLASS_PLATFORM => Ok(config.platform_recipient),
        CLASS_STUDIO => Ok(economy.tesoro_studio),
        CLASS_LEADERBOARD => Ok(config.pool_account),
        _ => err!(TesoroError::InvalidAccount),
    }
}

struct Cashed {
    gemas: u64,
    shares: u64,
    units: u64,
}

/// Brings the Source up to date, redeems the counter's ready Gemas and books the shares as paid.
/// The caller flushes the books and pays out.
#[allow(clippy::too_many_arguments)]
fn cash_in_counter<'a, 'info>(
    books: &mut OnchainBooks<'a, 'info>,
    kind: &mut KindCtx<'info>,
    position: &mut Account<PositionState>,
    source: &mut Account<SourceState>,
    source_key: &Pubkey,
    class: u8,
    min_units: u64,
) -> Result<Cashed> {
    let rates = kind.rates(&position.inner)?;
    sync_in_books(books, position, source, source_key, &rates)?;
    let mut counter = books
        .counter(&source_key.to_bytes(), class)
        .ok_or_else(|| core_err(CoreError::ZeroAmount))?;
    let out = {
        let (book, ck) = books
            .book_with_history(&source_key.to_bytes())
            .map_err(draw_err)?;
        let k = book.redeemable(&counter).map_err(book_err)?;
        if k == 0 {
            return Err(core_err(CoreError::ZeroAmount));
        }
        book.redeem(&mut counter, k, &*ck).map_err(book_err)?
    };
    require!(
        books.set_counter(&source_key.to_bytes(), class, &counter),
        TesoroError::InvalidAccount
    );
    if out.shares == 0 {
        return Err(core_err(CoreError::ZeroShares));
    }
    let shares = u64::try_from(out.shares).map_err(|_| core_err(CoreError::Math))?;
    let tag = kind.custody_kind();
    ledger::economy::debit_paid_shares(&mut position.inner, tag, kind.route_mut(), shares)
        .map_err(core_err)?;
    let units = u64::try_from(
        rates
            .rate
            .units_for_shares(u128::from(shares))
            .map_err(core_err)?,
    )
    .map_err(|_| core_err(CoreError::Math))?;
    require!(units >= min_units, TesoroError::InvalidAccount);
    source.inner.redeemed = source
        .inner
        .redeemed
        .checked_add(out.gemas)
        .ok_or_else(|| core_err(CoreError::Math))?;
    source.inner.redeemed_units = source
        .inner
        .redeemed_units
        .checked_add(units)
        .ok_or_else(|| core_err(CoreError::Math))?;
    Ok(Cashed {
        gemas: out.gemas,
        shares,
        units,
    })
}

/// Anyone cashes in the covered Platform or Studio fee of a native or stake Source. Remaining
/// accounts: the kind's accounts paying to the recipient's wallet, then the Source's book and
/// pages.
#[derive(Accounts)]
pub struct CashInFee<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [ECONOMY_SEED], bump = economy.bump)]
    pub economy: Account<'info, EconomyConfig>,
    #[account(
        seeds = [ACCOUNT_SEED, recipient_account.authority.as_ref()],
        bump = recipient_account.bump
    )]
    pub recipient_account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Account<'info, SourceState>,
}

pub(crate) fn cash_in_fee<'info>(
    ctx: Context<'_, '_, 'info, 'info, CashInFee<'info>>,
    class: u8,
) -> Result<()> {
    // EVM Sources pay on their own chain, which only the bridge can record.
    require!(
        ctx.accounts.position.inner.source_chain == SourceChain::Solana,
        TesoroError::BridgedSource
    );
    // The Leaderboard counter goes to the prize escrow (`harvest`), never to a wallet.
    require!(class != CLASS_LEADERBOARD, TesoroError::InvalidAccount);
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let want = fee_recipient(&a.config, &a.economy, class)?;
    require_keys_eq!(a.recipient_account.key(), want, TesoroError::Unauthorized);
    let wallet = a.recipient_account.authority;
    let (mut kind, rest) = KindCtx::load(&a.position.inner, remaining, PayTo::Wallet(&wallet))?;
    let mut books = OnchainBooks::load(rest)?;
    let source_key = a.source.key();
    let out = cash_in_counter(
        &mut books,
        &mut kind,
        &mut a.position,
        &mut a.source,
        &source_key,
        class,
        0,
    )?;
    books.flush()?;
    kind.pay_shares(&a.position.key(), out.shares, 6)?;
    kind.exit()?;
    emit!(FeeCashedIn {
        source: source_key,
        class,
        recipient: a.recipient_account.key(),
        gemas: out.gemas,
        shares: out.shares,
        units: out.units,
    });
    Ok(())
}

/// The EVM twin of `cash_in_fee`, signed by the registered source authority of the Position's
/// chain. The recipient must have linked an EVM address. Refuses a cash-in worth less than
/// `min_units` (the bridge's batch minimum), leaving the counter untouched. Remaining accounts:
/// the Source's book and pages.
#[derive(Accounts)]
pub struct CashInFeeFromSource<'info> {
    pub source_signer: Signer<'info>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[chain_byte(position.inner.source_chain)]],
        bump = source_authority.bump,
        constraint = source_authority.chain == position.inner.source_chain
            && source_authority.authority == source_signer.key() @ TesoroError::Unauthorized
    )]
    pub source_authority: Account<'info, SourceAuthority>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [ECONOMY_SEED], bump = economy.bump)]
    pub economy: Account<'info, EconomyConfig>,
    #[account(
        seeds = [ACCOUNT_SEED, recipient_account.authority.as_ref()],
        bump = recipient_account.bump
    )]
    pub recipient_account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Account<'info, SourceState>,
}

pub(crate) fn cash_in_fee_from_source<'info>(
    ctx: Context<'_, '_, 'info, 'info, CashInFeeFromSource<'info>>,
    class: u8,
    min_units: u64,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let want = fee_recipient(&a.config, &a.economy, class)?;
    require_keys_eq!(a.recipient_account.key(), want, TesoroError::Unauthorized);
    // Platform and Studio are paid to their recipient's EVM address; the Leaderboard counter
    // (class 2, recipient = the Pool's Account) goes to the vault's prize escrow instead.
    require!(
        class == CLASS_LEADERBOARD || a.recipient_account.evm_address != [0u8; 20],
        TesoroError::EvmNotLinked
    );
    let mut kind = KindCtx::Reported;
    let mut books = OnchainBooks::load(remaining)?;
    let source_key = a.source.key();
    let out = cash_in_counter(
        &mut books,
        &mut kind,
        &mut a.position,
        &mut a.source,
        &source_key,
        class,
        min_units,
    )?;
    books.flush()?;
    emit!(FeeCashedIn {
        source: source_key,
        class,
        recipient: a.recipient_account.key(),
        gemas: out.gemas,
        shares: out.shares,
        units: out.units,
    });
    Ok(())
}
