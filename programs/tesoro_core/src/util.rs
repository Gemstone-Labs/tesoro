use crate::error::{core_err, TesoroError};
use crate::ledger::{CoreResult, Holding, Payout};
use crate::state::*;
use anchor_lang::prelude::*;

pub fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Loads one Holding of `account` from a remaining account: program-owned, writable, right
/// discriminator, PDA derived from the stored canonical bump.
pub fn load_holding<'info>(
    account: &Pubkey,
    info: &'info AccountInfo<'info>,
) -> Result<Account<'info, HoldingState>> {
    require!(info.is_writable, TesoroError::NotWritable);
    let holding = Account::<HoldingState>::try_from(info)?;
    require_keys_eq!(holding.account, *account, TesoroError::InvalidAccount);
    let expected = Pubkey::create_program_address(
        &[
            HOLDING_SEED,
            account.as_ref(),
            &holding.inner.source,
            &[holding.bump],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(TesoroError::InvalidAccount))?;
    require_keys_eq!(expected, *info.key, TesoroError::InvalidAccount);
    Ok(holding)
}

/// Loads the Holdings of one Account, in the order supplied, rejecting duplicates.
pub fn load_holdings<'info>(
    account: &Pubkey,
    infos: &'info [AccountInfo<'info>],
) -> Result<Vec<Account<'info, HoldingState>>> {
    let mut out = Vec::with_capacity(infos.len());
    for (i, info) in infos.iter().enumerate() {
        require!(
            !infos[..i].iter().any(|o| o.key == info.key),
            TesoroError::DuplicateAccount
        );
        out.push(load_holding(account, info)?);
    }
    Ok(out)
}

/// Runs a ledger operation over Holdings; persists them only when it succeeds.
pub fn with_holdings<'info, R>(
    holdings: &mut [Account<'info, HoldingState>],
    f: impl FnOnce(&mut [Holding]) -> CoreResult<R>,
) -> Result<R> {
    let mut inner: Vec<Holding> = holdings.iter().map(|h| h.inner.clone()).collect();
    let result = f(&mut inner).map_err(core_err)?;
    for (h, updated) in holdings.iter_mut().zip(inner) {
        h.inner = updated;
        h.exit(&crate::ID)?;
    }
    Ok(result)
}

/// Credits settlement payouts. `remaining` holds, per payout in order, the recipient's
/// `TesoroAccount` followed by its Holding of the payout's Source.
pub fn credit_payouts<'info>(
    payouts: &[Payout],
    remaining: &'info [AccountInfo<'info>],
) -> Result<()> {
    require!(
        remaining.len() == payouts.len().saturating_mul(2),
        TesoroError::BadRemainingAccounts
    );
    for (payout, pair) in payouts.iter().zip(remaining.chunks(2)) {
        let (account_info, holding_info) = match pair {
            [a, h] => (a, h),
            _ => return err!(TesoroError::BadRemainingAccounts),
        };
        require!(account_info.is_writable, TesoroError::NotWritable);
        require!(
            account_info.key.to_bytes() == payout.recipient,
            TesoroError::InvalidAccount
        );
        let mut account = Account::<TesoroAccount>::try_from(account_info)?;
        let expected = Pubkey::create_program_address(
            &[ACCOUNT_SEED, account.authority.as_ref(), &[account.bump]],
            &crate::ID,
        )
        .map_err(|_| error!(TesoroError::InvalidAccount))?;
        require_keys_eq!(expected, *account_info.key, TesoroError::InvalidAccount);
        let mut holding = load_holding(account_info.key, holding_info)?;
        require!(
            holding.inner.source == payout.source,
            TesoroError::InvalidAccount
        );
        let acct = &mut account.inner;
        holding
            .inner
            .credit(acct, payout.amount)
            .map_err(core_err)?;
        account.exit(&crate::ID)?;
        holding.exit(&crate::ID)?;
    }
    Ok(())
}
