use crate::*;
use anchor_lang::system_program;

/// Which historical bridge record `retire_legacy_account` may close.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum LegacyKind {
    BridgePosition,
    Claim,
    VaultTreasury,
}

/// Exact lengths of the records written before the Yield Fee at cash-out and the 9-decimal units
/// (`BridgePosition` without the Treasury report fields, `Claim` without the fee counters,
/// `VaultTreasury` without the Instant payout fields). The current code cannot read them.
pub const LEGACY_BRIDGE_POSITION_LENGTHS: [usize; 2] = [172, 188];
pub const LEGACY_CLAIM_LENGTHS: [usize; 1] = [129];
pub const LEGACY_VAULT_TREASURY_LENGTHS: [usize; 1] = [77];

/// Closes a historical record by owner, discriminator and exact length only, to the admin. No field
/// is read, so the old layouts are never decoded as the current ones, and a record of the current
/// length (or of another type) is never closable. Devnet state is disposable (founder,
/// 2026-10-25): what the record counted is not preserved.
#[derive(Accounts)]
pub struct RetireLegacyAccount<'info> {
    #[account(mut, address = store.admin @ BridgeError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    /// CHECK: owner, discriminator and exact historical length are checked in the handler.
    #[account(mut)]
    pub account: UncheckedAccount<'info>,
}

impl RetireLegacyAccount<'_> {
    pub fn apply(ctx: &mut Context<RetireLegacyAccount>, kind: LegacyKind) -> Result<()> {
        let (discriminator, lengths): (&[u8], &[usize]) = match kind {
            LegacyKind::BridgePosition => {
                (BridgePosition::DISCRIMINATOR, &LEGACY_BRIDGE_POSITION_LENGTHS)
            },
            LegacyKind::Claim => (Claim::DISCRIMINATOR, &LEGACY_CLAIM_LENGTHS),
            LegacyKind::VaultTreasury => {
                (VaultTreasury::DISCRIMINATOR, &LEGACY_VAULT_TREASURY_LENGTHS)
            },
        };
        let info = ctx.accounts.account.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, BridgeError::InvalidAccount);
        {
            let data = info.try_borrow_data()?;
            require!(
                lengths.contains(&data.len()) && data[..8] == *discriminator,
                BridgeError::InvalidAccount
            );
        }
        let admin = ctx.accounts.admin.to_account_info();
        let total = admin
            .lamports()
            .checked_add(info.lamports())
            .ok_or(BridgeError::AmountOverflow)?;
        **admin.try_borrow_mut_lamports()? = total;
        **info.try_borrow_mut_lamports()? = 0;
        info.assign(&system_program::ID);
        info.resize(0)?;
        Ok(())
    }
}
