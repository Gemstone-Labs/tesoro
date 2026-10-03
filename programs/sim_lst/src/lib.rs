//! `sim_lst` — SIMULATED liquid staking token for Tesoro's devnet demo.
//!
//! Nothing here is real staking. The pool mints `simSOL` for deposited devnet SOL and its
//! exchange rate (SOL per simSOL) grows on an accelerated clock. The yield is paid out of an
//! admin-funded reserve held in the vault; withdrawals beyond the vault's balance are refused.
//!
//! Rate: constant. `current_rate` returns the checkpointed `base_rate` (RATE_SCALE = 1e9 fixed
//! point), so deposit and withdraw price at a fixed SOL value per simSOL. Yield does not come from
//! the rate: each Position earns `principal * apy * simulated_time` and the tesoro_core yield
//! authority mints it into the Position's vault with `mint_yield` (see docs/yield-model.md).
//! `apy_bps` and `speedup` stay in the Pool as the yield parameters. Default `speedup` is 4,380
//! (1 simulated month = 1/12 year = 10 real minutes).

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount};

declare_id!("WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F");

pub const RATE_SCALE: u64 = 1_000_000_000;
pub const BPS_DENOMINATOR: u128 = 10_000;
pub const SECONDS_PER_YEAR: u128 = 31_536_000;
pub const DEFAULT_SPEEDUP: u32 = 4_380;
pub const MAX_APY_BPS: u32 = 100_000;
pub const MAX_SPEEDUP: u32 = 1_000_000;
pub const DECIMALS: u8 = 9;

pub const POOL_SEED: &[u8] = b"pool";
pub const MINT_SEED: &[u8] = b"mint";
pub const VAULT_SEED: &[u8] = b"vault";
pub const FAUCET_SEED: &[u8] = b"faucet";
pub const YIELD_SEED: &[u8] = b"yield_config";

#[program]
pub mod sim_lst {
    use super::*;

    /// Creates the pool and the simSOL mint. The admin pays and becomes the pool admin.
    pub fn initialize(
        ctx: Context<Initialize>,
        apy_bps: u32,
        speedup: u32,
        faucet_amount: u64,
        faucet_cooldown: i64,
    ) -> Result<()> {
        validate_params(apy_bps, speedup)?;
        require!(faucet_cooldown >= 0, SimLstError::InvalidParams);
        let pool = &mut ctx.accounts.pool;
        pool.admin = ctx.accounts.admin.key();
        pool.mint = ctx.accounts.mint.key();
        pool.base_rate = RATE_SCALE;
        pool.base_ts = Clock::get()?.unix_timestamp;
        pool.apy_bps = apy_bps;
        pool.speedup = speedup;
        pool.faucet_amount = faucet_amount;
        pool.faucet_cooldown = faucet_cooldown;
        pool.paused = false;
        pool.bump = ctx.bumps.pool;
        pool.mint_bump = ctx.bumps.mint;
        pool.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// Deposits SOL into the vault and mints simSOL at the current rate (rounded down).
    pub fn deposit(ctx: Context<Deposit>, lamports: u64) -> Result<()> {
        let pool = &ctx.accounts.pool;
        require!(!pool.paused, SimLstError::Paused);
        let rate = current_rate(pool, Clock::get()?.unix_timestamp)?;
        let minted = lamports_to_shares(lamports, rate)?;
        require!(minted > 0, SimLstError::ZeroAmount);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            lamports,
        )?;
        mint_shares(
            pool,
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.user_ata,
            &ctx.accounts.pool.to_account_info(),
            minted,
        )
    }

    /// Burns simSOL and pays SOL at the current rate from the vault. Refused if the vault
    /// (deposits plus admin-funded reserve) cannot cover it.
    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        let pool = &ctx.accounts.pool;
        require!(!pool.paused, SimLstError::Paused);
        let rate = current_rate(pool, Clock::get()?.unix_timestamp)?;
        let lamports = shares_to_lamports(shares, rate)?;
        require!(lamports > 0, SimLstError::ZeroAmount);

        let rent_floor = Rent::get()?.minimum_balance(0);
        let available = ctx
            .accounts
            .vault
            .lamports()
            .checked_sub(rent_floor)
            .ok_or(SimLstError::InsufficientReserve)?;
        require!(lamports <= available, SimLstError::InsufficientReserve);

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.user_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            shares,
        )?;
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, &[pool.vault_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user.to_account_info(),
                },
                &[vault_seeds],
            ),
            lamports,
        )
    }

    /// SIMULATED faucet: mints unbacked simSOL to the caller, once per cooldown window.
    pub fn faucet(ctx: Context<Faucet>) -> Result<()> {
        let pool = &ctx.accounts.pool;
        require!(!pool.paused, SimLstError::Paused);
        require!(pool.faucet_amount > 0, SimLstError::FaucetDisabled);
        let now = Clock::get()?.unix_timestamp;
        let claim = &mut ctx.accounts.claim;
        if claim.count > 0 {
            let next = claim
                .last_claim_ts
                .checked_add(pool.faucet_cooldown)
                .ok_or(SimLstError::MathOverflow)?;
            require!(now >= next, SimLstError::FaucetCooldown);
        }
        claim.user = ctx.accounts.user.key();
        claim.last_claim_ts = now;
        claim.count = claim
            .count
            .checked_add(1)
            .ok_or(SimLstError::MathOverflow)?;
        claim.bump = ctx.bumps.claim;

        mint_shares(
            pool,
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.user_ata,
            &ctx.accounts.pool.to_account_info(),
            pool.faucet_amount,
        )
    }

    /// Returns the current rate (SOL per simSOL, 1e9 fixed point) as return data.
    pub fn get_rate(ctx: Context<GetRate>) -> Result<u64> {
        current_rate(&ctx.accounts.pool, Clock::get()?.unix_timestamp)
    }

    /// Admin: changes the yield parameters (APY and/or speedup). The rate does not move.
    pub fn set_params(
        ctx: Context<AdminOnly>,
        apy_bps: Option<u32>,
        speedup: Option<u32>,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let new_apy = apy_bps.unwrap_or(pool.apy_bps);
        let new_speedup = speedup.unwrap_or(pool.speedup);
        validate_params(new_apy, new_speedup)?;
        pool.apy_bps = new_apy;
        pool.speedup = new_speedup;
        Ok(())
    }

    /// Admin: records the one authority allowed to `mint_yield` (the tesoro_core `["yield"]` PDA).
    pub fn set_yield_authority(ctx: Context<SetYieldAuthority>, authority: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = authority;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Yield authority only: mints `shares` simSOL of simulated yield to `destination`. The
    /// shares are backed by the admin-funded reserve, like the faucet's are not.
    pub fn mint_yield(ctx: Context<MintYield>, shares: u64) -> Result<()> {
        let pool = &ctx.accounts.pool;
        require!(!pool.paused, SimLstError::Paused);
        require!(shares > 0, SimLstError::ZeroAmount);
        mint_shares(
            pool,
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.destination,
            &ctx.accounts.pool.to_account_info(),
            shares,
        )?;
        emit!(YieldMinted {
            destination: ctx.accounts.destination.key(),
            shares,
        });
        Ok(())
    }

    /// Upgrade authority: rotates the pool admin. Gated on the program's upgrade authority so a
    /// compromised admin key cannot call it.
    pub fn set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.pool.admin = new_admin;
        Ok(())
    }

    /// Admin: configures the faucet payout and per-user cooldown (seconds). Amount 0 disables it.
    pub fn set_faucet(ctx: Context<AdminOnly>, amount: u64, cooldown: i64) -> Result<()> {
        require!(cooldown >= 0, SimLstError::InvalidParams);
        let pool = &mut ctx.accounts.pool;
        pool.faucet_amount = amount;
        pool.faucet_cooldown = cooldown;
        Ok(())
    }

    /// Admin: pauses or resumes deposit, withdraw and faucet.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.pool.paused = paused;
        Ok(())
    }

    /// Admin: tops up the reserve that funds the simulated yield.
    pub fn fund_reserve(ctx: Context<FundReserve>, lamports: u64) -> Result<()> {
        require!(lamports > 0, SimLstError::ZeroAmount);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            lamports,
        )
    }
}

/// Current SOL-per-simSOL rate (1e9 fixed point): constant, the checkpointed `base_rate`. Other
/// programs can deserialize [`Pool`] and call this; `now` is kept so callers need not change.
pub fn current_rate(pool: &Pool, _now: i64) -> Result<u64> {
    require!(pool.base_rate > 0, SimLstError::MathOverflow);
    Ok(pool.base_rate)
}

/// Simulated yield of one Position: `principal * apy * elapsed * speedup / (10_000 * year)`, linear
/// and rounded down. The same function sizes what `mint_yield` mints.
pub fn yield_units(principal: u64, apy_bps: u32, elapsed: i64, speedup: u32) -> Result<u64> {
    let elapsed = u128::try_from(elapsed.max(0)).map_err(|_| SimLstError::MathOverflow)?;
    let v = u128::from(principal)
        .checked_mul(u128::from(apy_bps))
        .and_then(|v| v.checked_mul(elapsed))
        .and_then(|v| v.checked_mul(u128::from(speedup)))
        .ok_or(SimLstError::MathOverflow)?
        / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
    Ok(u64::try_from(v).map_err(|_| SimLstError::MathOverflow)?)
}

pub fn lamports_to_shares(lamports: u64, rate: u64) -> Result<u64> {
    require!(rate > 0, SimLstError::MathOverflow);
    let v = u128::from(lamports)
        .checked_mul(u128::from(RATE_SCALE))
        .ok_or(SimLstError::MathOverflow)?
        / u128::from(rate);
    Ok(u64::try_from(v).map_err(|_| SimLstError::MathOverflow)?)
}

pub fn shares_to_lamports(shares: u64, rate: u64) -> Result<u64> {
    let v = u128::from(shares)
        .checked_mul(u128::from(rate))
        .ok_or(SimLstError::MathOverflow)?
        / u128::from(RATE_SCALE);
    Ok(u64::try_from(v).map_err(|_| SimLstError::MathOverflow)?)
}

fn validate_params(apy_bps: u32, speedup: u32) -> Result<()> {
    require!(apy_bps <= MAX_APY_BPS, SimLstError::InvalidParams);
    require!(
        (1..=MAX_SPEEDUP).contains(&speedup),
        SimLstError::InvalidParams
    );
    Ok(())
}

fn mint_shares<'info>(
    pool: &Pool,
    token_program: &Program<'info, Token>,
    mint: &Account<'info, Mint>,
    to: &Account<'info, TokenAccount>,
    pool_info: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[POOL_SEED, &[pool.bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            MintTo {
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: pool_info.clone(),
            },
            &[seeds],
        ),
        amount,
    )
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub admin: Pubkey,
    pub mint: Pubkey,
    /// Rate at `base_ts`, 1e9 fixed point (SOL per simSOL).
    pub base_rate: u64,
    pub base_ts: i64,
    pub apy_bps: u32,
    /// Yield-clock multiplier; 4,320 = 1 month of yield per 10 minutes.
    pub speedup: u32,
    pub faucet_amount: u64,
    pub faucet_cooldown: i64,
    pub paused: bool,
    pub bump: u8,
    pub mint_bump: u8,
    pub vault_bump: u8,
}

/// The authority allowed to mint simulated yield.
#[account]
#[derive(InitSpace)]
pub struct YieldConfig {
    pub authority: Pubkey,
    pub bump: u8,
}

#[event]
pub struct YieldMinted {
    pub destination: Pubkey,
    pub shares: u64,
}

#[account]
#[derive(InitSpace)]
pub struct FaucetClaim {
    pub user: Pubkey,
    pub last_claim_ts: i64,
    pub count: u32,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED],
        bump
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        init,
        payer = admin,
        seeds = [MINT_SEED],
        bump,
        mint::decimals = DECIMALS,
        mint::authority = pool,
    )]
    pub mint: Account<'info, Mint>,
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, address = pool.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
    )]
    pub user_ata: Account<'info, TokenAccount>,
    #[account(mut, seeds = [VAULT_SEED], bump = pool.vault_bump)]
    pub vault: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, address = pool.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = user,
    )]
    pub user_ata: Account<'info, TokenAccount>,
    #[account(mut, seeds = [VAULT_SEED], bump = pool.vault_bump)]
    pub vault: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Faucet<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, address = pool.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
    )]
    pub user_ata: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + FaucetClaim::INIT_SPACE,
        seeds = [FAUCET_SEED, user.key().as_ref()],
        bump
    )]
    pub claim: Account<'info, FaucetClaim>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetYieldAuthority<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin @ SimLstError::Unauthorized)]
    pub pool: Account<'info, Pool>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + YieldConfig::INIT_SPACE,
        seeds = [YIELD_SEED],
        bump
    )]
    pub config: Account<'info, YieldConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintYield<'info> {
    #[account(address = config.authority @ SimLstError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [YIELD_SEED], bump = config.bump)]
    pub config: Account<'info, YieldConfig>,
    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, address = pool.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct GetRate<'info> {
    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin @ SimLstError::Unauthorized)]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct SetAdmin<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ SimLstError::Unauthorized
    )]
    pub program: Program<'info, crate::program::SimLst>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key())
        @ SimLstError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
}

#[derive(Accounts)]
pub struct FundReserve<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin @ SimLstError::Unauthorized)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [VAULT_SEED], bump = pool.vault_bump)]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum SimLstError {
    #[msg("Not the pool admin")]
    Unauthorized,
    #[msg("Pool is paused")]
    Paused,
    #[msg("Amount is zero")]
    ZeroAmount,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("Simulated reserve cannot cover this withdrawal")]
    InsufficientReserve,
    #[msg("Faucet is disabled")]
    FaucetDisabled,
    #[msg("Faucet cooldown has not elapsed")]
    FaucetCooldown,
}
