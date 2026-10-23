use super::basket::{move_lamports, store_err};
use super::ticket::sponsor_rent;
use crate::error::{BasketError, TesoroError};
use crate::ledger::line_store::LineStore;
use crate::state::*;
use crate::storage::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CreateAccount<'info> {
    /// The wallet the Account belongs to. It signs but pays nothing: a wallet with no SOL can own an
    /// Account whose rent the sponsor covers.
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = TesoroAccount::SPACE,
        seeds = [ACCOUNT_SEED, authority.key().as_ref()],
        bump
    )]
    pub account: Account<'info, TesoroAccount>,
    #[account(
        init,
        payer = payer,
        space = store_len(INITIAL_BASKET_LINES),
        seeds = [BASKET_SEED, account.key().as_ref()],
        bump
    )]
    pub basket: AccountLoader<'info, BasketHead>,
    #[account(
        init,
        payer = payer,
        space = store_len(0),
        seeds = [SPILL_SEED, account.key().as_ref()],
        bump
    )]
    pub spill: AccountLoader<'info, SpillHead>,
    /// CHECK: the Invite gate setting (`["invite_gate"]`); read by hand because it does not exist
    /// until the admin first sets it, and no account means the gate is off. When the gate is on the
    /// Invite key must also sign, passed as the first remaining account.
    #[account(seeds = [INVITE_GATE_SEED], bump)]
    pub invite_gate: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// Pays the rent: the authority itself, or (with `sponsor`) the sponsor's relayer, which is
    /// repaid in the same instruction. Placed after the original accounts so their order is kept.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Option<Account<'info, SponsorState>>,
}

fn require_invite(ctx: &Context<CreateAccount>) -> Result<()> {
    let info = ctx.accounts.invite_gate.to_account_info();
    if info.owner != &crate::ID || info.data_is_empty() {
        return Ok(());
    }
    let gate = InviteGate::try_deserialize(&mut &info.data.borrow()[..])?;
    if !gate.required {
        return Ok(());
    }
    let signed = ctx
        .remaining_accounts
        .first()
        .is_some_and(|k| k.is_signer && *k.key == gate.key);
    require!(signed, TesoroError::InviteRequired);
    Ok(())
}

pub(crate) fn create_account(ctx: Context<CreateAccount>, evm_address: [u8; 20]) -> Result<()> {
    require_invite(&ctx)?;
    // Anyone but the wallet itself pays only through the sponsor, who repays them: the relayer
    // can never be left holding rent that does not come back.
    require!(
        ctx.accounts.sponsor.is_some() || ctx.accounts.payer.key() == ctx.accounts.authority.key(),
        BasketError::PayerNeedsSponsor
    );
    let account = &mut ctx.accounts.account;
    account.bump = ctx.bumps.account;
    account.authority = ctx.accounts.authority.key();
    account.evm_address = evm_address;
    let key = account.key();
    let (basket, spill) = (
        ctx.accounts.basket.to_account_info(),
        ctx.accounts.spill.to_account_info(),
    );
    super::basket::format_stores(&basket, &spill, &key, (ctx.bumps.basket, ctx.bumps.spill))?;
    if let Some(sponsor) = ctx.accounts.sponsor.as_mut() {
        // The lines of the basket can be shrunk away later and their rent goes back to the sponsor
        // (recorded in the store). Everything else (the Account, the headers, the spill's base)
        // stays for good: it is counted in `accounts_spent` against `accounts_cap`.
        let rent = Rent::get()?;
        let account_info = account.to_account_info();
        let total = rent
            .minimum_balance(account_info.data_len())
            .checked_add(rent.minimum_balance(basket.data_len()))
            .and_then(|t| t.checked_add(rent.minimum_balance(spill.data_len())))
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let refundable = rent
            .minimum_balance(store_len(INITIAL_BASKET_LINES))
            .saturating_sub(rent.minimum_balance(store_len(0)));
        let permanent = total
            .checked_sub(refundable)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let payer = ctx.accounts.payer.to_account_info();
        sponsor_rent(sponsor, &payer, 0, refundable)?;
        repay_permanent(sponsor, &payer, permanent, Spend::Account)?;
        let mut data = basket.try_borrow_mut_data()?;
        LineStore::new(&mut data[DISC..])
            .map_err(store_err)?
            .set_sponsored_lamports(refundable);
    }
    Ok(())
}

/// Which cap a permanent sponsored rent counts against.
#[derive(Clone, Copy)]
enum Spend {
    Account,
    Profile,
}

/// Repays the relayer that fronted rent the sponsor can never get back (a new Account against
/// `accounts_cap`, a new Profile against `profiles_cap`). The caller has checked that the payer is
/// not the wallet itself.
fn repay_permanent<'info>(
    sponsor: &mut Account<'info, SponsorState>,
    payer: &AccountInfo<'info>,
    amount: u64,
    spend: Spend,
) -> Result<()> {
    require!(!sponsor.paused, BasketError::SponsorPaused);
    require_keys_eq!(sponsor.relayer, *payer.key, BasketError::NotSponsorRelayer);
    let (spent, cap, over) = match spend {
        Spend::Account => (
            sponsor.accounts_spent,
            sponsor.accounts_cap,
            BasketError::AccountsSponsorCap,
        ),
        Spend::Profile => (
            sponsor.profiles_spent,
            sponsor.profiles_cap,
            BasketError::ProfilesSponsorCap,
        ),
    };
    if !spent.checked_add(amount).is_some_and(|v| v <= cap) {
        return Err(over.into());
    }
    let sponsor_info = sponsor.to_account_info();
    let keep = Rent::get()?.minimum_balance(sponsor_info.data_len());
    require!(
        sponsor_info.lamports() >= amount && sponsor_info.lamports() - amount >= keep,
        BasketError::SponsorShort
    );
    move_lamports(&sponsor_info, payer, amount)?;
    let counter = match spend {
        Spend::Account => &mut sponsor.accounts_spent,
        Spend::Profile => &mut sponsor.profiles_spent,
    };
    *counter = counter
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    Ok(())
}

/// A payer other than the wallet itself pays only through the sponsor, who repays them.
fn require_payer(payer: &Pubkey, authority: &Pubkey, has_sponsor: bool) -> Result<()> {
    require!(
        has_sponsor || payer == authority,
        BasketError::PayerNeedsSponsor
    );
    Ok(())
}

/// After a Profile was created: the sponsor repays what the relayer fronted for it.
fn repay_profile<'info>(
    fresh: bool,
    sponsor: Option<&mut Account<'info, SponsorState>>,
    payer: &AccountInfo<'info>,
) -> Result<()> {
    if let (true, Some(sponsor)) = (fresh, sponsor) {
        repay_permanent(
            sponsor,
            payer,
            Rent::get()?.minimum_balance(Profile::SPACE),
            Spend::Profile,
        )?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct SetEvmAddress<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, authority.key().as_ref()],
        bump = account.bump
    )]
    pub account: Account<'info, TesoroAccount>,
}

pub(crate) fn set_evm_address(ctx: Context<SetEvmAddress>, evm_address: [u8; 20]) -> Result<()> {
    ctx.accounts.account.evm_address = evm_address;
    Ok(())
}

/// The Account's authority sets its display name and picture. The first call creates the Profile
/// (the authority pays its rent, or the sponsor does); later calls overwrite name and picture and keep the linked names.
#[derive(Accounts)]
pub struct SetProfile<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, authority.key().as_ref()],
        bump = account.bump
    )]
    pub account: Account<'info, TesoroAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = Profile::SPACE,
        seeds = [PROFILE_SEED, account.key().as_ref()],
        bump
    )]
    pub profile: Account<'info, Profile>,
    pub system_program: Program<'info, System>,
    /// Pays the Profile's rent: the authority, or the sponsor's relayer (repaid in the instruction).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Option<Account<'info, SponsorState>>,
}

/// Sets the Profile's identity fields on first use; later calls keep the linked names.
fn touch_profile(profile: &mut Profile, account: Pubkey, bump: u8) {
    if profile.account == Pubkey::default() {
        profile.bump = bump;
        profile.account = account;
        profile.name_len = 0;
        profile.name = [0; PROFILE_NAME_MAX];
        profile.avatar = AvatarChoice::Default;
        profile.name_wallet = Pubkey::default();
        profile.name_evm = [0; 20];
    }
}

pub(crate) fn set_profile(
    ctx: Context<SetProfile>,
    name: String,
    avatar: AvatarChoice,
) -> Result<()> {
    let bytes = name.as_bytes();
    require!(
        Profile::name_is_valid(bytes),
        TesoroError::InvalidProfileName
    );
    require!(Profile::avatar_is_valid(avatar), TesoroError::InvalidAvatar);
    require_payer(
        &ctx.accounts.payer.key(),
        &ctx.accounts.authority.key(),
        ctx.accounts.sponsor.is_some(),
    )?;
    let profile = &mut ctx.accounts.profile;
    let fresh = profile.account == Pubkey::default();
    touch_profile(profile, ctx.accounts.account.key(), ctx.bumps.profile);
    // `name_is_valid` bounds the length by PROFILE_NAME_MAX.
    profile.name_len = bytes.len() as u8;
    profile.name = [0; PROFILE_NAME_MAX];
    profile.name[..bytes.len()].copy_from_slice(bytes);
    profile.avatar = avatar;
    let payer = ctx.accounts.payer.to_account_info();
    repay_profile(fresh, ctx.accounts.sponsor.as_mut(), &payer)
}

/// Attaches a Solana wallet whose .sol name should show for this Player. The wallet must sign the
/// same transaction, so nobody can borrow a name they do not control. Without `wallet` the link is cleared.
#[derive(Accounts)]
pub struct SetNameWallet<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, authority.key().as_ref()],
        bump = account.bump
    )]
    pub account: Account<'info, TesoroAccount>,
    #[account(
        init_if_needed,
        payer = authority,
        space = Profile::SPACE,
        seeds = [PROFILE_SEED, account.key().as_ref()],
        bump
    )]
    pub profile: Account<'info, Profile>,
    pub wallet: Option<Signer<'info>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_name_wallet(ctx: Context<SetNameWallet>) -> Result<()> {
    let profile = &mut ctx.accounts.profile;
    touch_profile(profile, ctx.accounts.account.key(), ctx.bumps.profile);
    profile.name_wallet = ctx
        .accounts
        .wallet
        .as_ref()
        .map_or(Pubkey::default(), |w| w.key());
    Ok(())
}

/// Attaches an EVM address whose .eth name should show for this Player. The address must already be
/// linked to this Account in the bridge (`link_evm` checks an EIP-191 signature of the Account key
/// on chain), and that link is verified here. An all-zero address clears it.
#[derive(Accounts)]
pub struct SetNameEvm<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, authority.key().as_ref()],
        bump = account.bump
    )]
    pub account: Account<'info, TesoroAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = Profile::SPACE,
        seeds = [PROFILE_SEED, account.key().as_ref()],
        bump
    )]
    pub profile: Account<'info, Profile>,
    /// CHECK: the bridge's `EvmLink` for `evm_address`; owner, address and contents are verified in the handler.
    pub evm_link: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Option<Account<'info, SponsorState>>,
}

/// Bridge `EvmLink`: discriminator, evm_address, account, authority, bump.
const EVM_LINK_LEN: usize = 8 + 20 + 32 + 32 + 1;

fn evm_link_proves(link: &AccountInfo, evm: &[u8; 20], account: &Pubkey) -> bool {
    if link.owner != &BRIDGE_PROGRAM_ID {
        return false;
    }
    let Ok(data) = link.try_borrow_data() else {
        return false;
    };
    if data.len() != EVM_LINK_LEN || data[8..28] != evm[..] || data[28..60] != account.to_bytes() {
        return false;
    }
    // The bridge stored the canonical bump; checking the address with it avoids a bump search.
    let bump = [data[EVM_LINK_LEN - 1]];
    Pubkey::create_program_address(&[EVM_LINK_SEED, evm, &bump], &BRIDGE_PROGRAM_ID)
        .map(|expected| expected == link.key())
        .unwrap_or(false)
}

pub(crate) fn set_name_evm(ctx: Context<SetNameEvm>, evm_address: [u8; 20]) -> Result<()> {
    let account_key = ctx.accounts.account.key();
    require_payer(
        &ctx.accounts.payer.key(),
        &ctx.accounts.authority.key(),
        ctx.accounts.sponsor.is_some(),
    )?;
    if evm_address != [0; 20] {
        let link = ctx
            .accounts
            .evm_link
            .as_ref()
            .ok_or(TesoroError::EvmNotLinked)?;
        require!(
            evm_link_proves(link.as_ref(), &evm_address, &account_key),
            TesoroError::EvmNotLinked
        );
    }
    let profile = &mut ctx.accounts.profile;
    let fresh = profile.account == Pubkey::default();
    touch_profile(profile, account_key, ctx.bumps.profile);
    profile.name_evm = evm_address;
    let payer = ctx.accounts.payer.to_account_info();
    repay_profile(fresh, ctx.accounts.sponsor.as_mut(), &payer)
}
