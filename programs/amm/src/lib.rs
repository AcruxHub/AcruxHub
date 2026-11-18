//! AcruxHub AMM: permissionless constant-product pools with LP tokens.
//!
//! One pool per (mint_a, mint_b, fee_bps) with mint_a < mint_b. Reserves are the
//! vault balances. Swaps enforce a minimum output and a slot deadline on chain;
//! front-running protection comes from the client sealing the transaction with
//! Acrux threshold sends, so no proposer can read it before it is ordered.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

pub mod math;

declare_id!("845G7nDPuxfzqbxEnVsrT72XxG5UJMBvunxhEYyAEMjB");

pub const POOL_SEED: &[u8] = b"pool";
pub const VAULT_SEED: &[u8] = b"vault";
pub const LP_SEED: &[u8] = b"lp";
pub const MAX_FEE_BPS: u16 = 1_000;
pub const LP_DECIMALS: u8 = 6;

#[program]
pub mod acruxhub_amm {
    use super::*;

    /// Creates an empty pool for a mint pair and fee tier. Liquidity comes with `add_liquidity`.
    pub fn create_pool(ctx: Context<CreatePool>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, AmmError::InvalidFee);
        let a = &ctx.accounts;
        require!(a.mint_a.key() < a.mint_b.key(), AmmError::MintOrder);
        let pool = &mut ctx.accounts.pool;
        pool.mint_a = ctx.accounts.mint_a.key();
        pool.mint_b = ctx.accounts.mint_b.key();
        pool.vault_a = ctx.accounts.vault_a.key();
        pool.vault_b = ctx.accounts.vault_b.key();
        pool.lp_mint = ctx.accounts.lp_mint.key();
        pool.fee_bps = fee_bps;
        pool.bump = ctx.bumps.pool;
        pool.creator = ctx.accounts.payer.key();
        pool.created_slot = Clock::get()?.slot;
        pool.volume_a = 0;
        pool.volume_b = 0;
        pool.swap_count = 0;
        emit!(PoolCreated {
            pool: pool.key(),
            mint_a: pool.mint_a,
            mint_b: pool.mint_b,
            fee_bps,
            creator: pool.creator,
        });
        Ok(())
    }

    /// Deposits up to `max_a`/`max_b` at the pool ratio and mints LP tokens.
    /// The first deposit sets the price and permanently locks `MIN_LIQUIDITY` LP.
    pub fn add_liquidity(ctx: Context<AddLiquidity>, max_a: u64, max_b: u64, min_lp: u64) -> Result<()> {
        let quote = math::deposit(
            ctx.accounts.vault_a.amount,
            ctx.accounts.vault_b.amount,
            ctx.accounts.lp_mint.supply,
            max_a,
            max_b,
        )?;
        require!(quote.lp >= min_lp && quote.lp > 0, AmmError::Slippage);

        let a = &ctx.accounts;
        for (from, to, amount) in [
            (&a.owner_a, &a.vault_a, quote.amount_a),
            (&a.owner_b, &a.vault_b, quote.amount_b),
        ] {
            token::transfer(
                CpiContext::new(
                    a.token_program.to_account_info(),
                    Transfer { from: from.to_account_info(), to: to.to_account_info(), authority: a.owner.to_account_info() },
                ),
                amount,
            )?;
        }
        let pool = &a.pool;
        let seeds: &[&[u8]] = &[POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &pool.fee_bps.to_le_bytes(), &[pool.bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                MintTo { mint: a.lp_mint.to_account_info(), to: a.owner_lp.to_account_info(), authority: pool.to_account_info() },
                &[seeds],
            ),
            quote.lp,
        )?;
        emit!(LiquidityChanged {
            pool: pool.key(),
            owner: a.owner.key(),
            amount_a: quote.amount_a,
            amount_b: quote.amount_b,
            lp: quote.lp,
            added: true,
        });
        Ok(())
    }

    /// Burns `lp` LP tokens for a pro-rata share of both reserves.
    pub fn remove_liquidity(ctx: Context<RemoveLiquidity>, lp: u64, min_a: u64, min_b: u64) -> Result<()> {
        let a = &ctx.accounts;
        let (out_a, out_b) = math::withdraw(a.vault_a.amount, a.vault_b.amount, a.lp_mint.supply, lp)?;
        require!(out_a >= min_a && out_b >= min_b, AmmError::Slippage);

        token::burn(
            CpiContext::new(
                a.token_program.to_account_info(),
                Burn { mint: a.lp_mint.to_account_info(), from: a.owner_lp.to_account_info(), authority: a.owner.to_account_info() },
            ),
            lp,
        )?;
        let pool = &a.pool;
        let seeds: &[&[u8]] = &[POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &pool.fee_bps.to_le_bytes(), &[pool.bump]];
        for (from, to, amount) in [(&a.vault_a, &a.owner_a, out_a), (&a.vault_b, &a.owner_b, out_b)] {
            token::transfer(
                CpiContext::new_with_signer(
                    a.token_program.to_account_info(),
                    Transfer { from: from.to_account_info(), to: to.to_account_info(), authority: pool.to_account_info() },
                    &[seeds],
                ),
                amount,
            )?;
        }
        emit!(LiquidityChanged { pool: pool.key(), owner: a.owner.key(), amount_a: out_a, amount_b: out_b, lp, added: false });
        Ok(())
    }

    /// Swaps exactly `amount_in`, A to B when `a_to_b`. Fails when the output is under
    /// `min_out` or the current slot is past `deadline_slot`.
    pub fn swap(ctx: Context<Swap>, amount_in: u64, min_out: u64, a_to_b: bool, deadline_slot: u64) -> Result<()> {
        require!(Clock::get()?.slot <= deadline_slot, AmmError::Expired);
        let a = &ctx.accounts;
        let (vault_in, vault_out, user_in, user_out) = if a_to_b {
            (&a.vault_a, &a.vault_b, &a.user_a, &a.user_b)
        } else {
            (&a.vault_b, &a.vault_a, &a.user_b, &a.user_a)
        };
        let out = math::swap_out(amount_in, vault_in.amount, vault_out.amount, a.pool.fee_bps)?;
        require!(out >= min_out, AmmError::Slippage);

        token::transfer(
            CpiContext::new(
                a.token_program.to_account_info(),
                Transfer { from: user_in.to_account_info(), to: vault_in.to_account_info(), authority: a.user.to_account_info() },
            ),
            amount_in,
        )?;
        let pool = &a.pool;
        let seeds: &[&[u8]] = &[POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref(), &pool.fee_bps.to_le_bytes(), &[pool.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                Transfer { from: vault_out.to_account_info(), to: user_out.to_account_info(), authority: pool.to_account_info() },
                &[seeds],
            ),
            out,
        )?;

        let pool_key = pool.key();
        let pool = &mut ctx.accounts.pool;
        if a_to_b {
            pool.volume_a = pool.volume_a.saturating_add(amount_in as u128);
        } else {
            pool.volume_b = pool.volume_b.saturating_add(amount_in as u128);
        }
        pool.swap_count = pool.swap_count.saturating_add(1);
        emit!(Swapped { pool: pool_key, user: ctx.accounts.user.key(), a_to_b, amount_in, amount_out: out });
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub vault_a: Pubkey,
    pub vault_b: Pubkey,
    pub lp_mint: Pubkey,
    pub creator: Pubkey,
    pub fee_bps: u16,
    pub bump: u8,
    pub created_slot: u64,
    pub volume_a: u128,
    pub volume_b: u128,
    pub swap_count: u64,
}

#[derive(Accounts)]
#[instruction(fee_bps: u16)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint_a: Box<Account<'info, Mint>>,
    pub mint_b: Box<Account<'info, Mint>>,
    #[account(
        init, payer = payer, space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, mint_a.key().as_ref(), mint_b.key().as_ref(), &fee_bps.to_le_bytes()], bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init, payer = payer, seeds = [VAULT_SEED, pool.key().as_ref(), mint_a.key().as_ref()], bump,
        token::mint = mint_a, token::authority = pool
    )]
    pub vault_a: Box<Account<'info, TokenAccount>>,
    #[account(
        init, payer = payer, seeds = [VAULT_SEED, pool.key().as_ref(), mint_b.key().as_ref()], bump,
        token::mint = mint_b, token::authority = pool
    )]
    pub vault_b: Box<Account<'info, TokenAccount>>,
    #[account(
        init, payer = payer, seeds = [LP_SEED, pool.key().as_ref()], bump,
        mint::decimals = LP_DECIMALS, mint::authority = pool
    )]
    pub lp_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    /// Pays for the LP token account when it is missing.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Owns the source token accounts and receives the LP tokens.
    pub owner: Signer<'info>,
    #[account(has_one = vault_a, has_one = vault_b, has_one = lp_mint, has_one = mint_a, has_one = mint_b)]
    pub pool: Box<Account<'info, Pool>>,
    pub mint_a: Box<Account<'info, Mint>>,
    pub mint_b: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub vault_a: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_b: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub lp_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = mint_a, token::authority = owner)]
    pub owner_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = mint_b, token::authority = owner)]
    pub owner_b: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = payer, associated_token::mint = lp_mint, associated_token::authority = owner)]
    pub owner_lp: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = vault_a, has_one = vault_b, has_one = lp_mint)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut)]
    pub vault_a: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_b: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub lp_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = pool.mint_a, token::authority = owner)]
    pub owner_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = pool.mint_b, token::authority = owner)]
    pub owner_b: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = lp_mint, token::authority = owner)]
    pub owner_lp: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, has_one = vault_a, has_one = vault_b, has_one = mint_a, has_one = mint_b)]
    pub pool: Box<Account<'info, Pool>>,
    pub mint_a: Box<Account<'info, Mint>>,
    pub mint_b: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub vault_a: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_b: Box<Account<'info, TokenAccount>>,
    /// The user's token accounts; the output side is created when missing so a swap is one instruction.
    #[account(init_if_needed, payer = user, associated_token::mint = mint_a, associated_token::authority = user)]
    pub user_a: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = user, associated_token::mint = mint_b, associated_token::authority = user)]
    pub user_b: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub fee_bps: u16,
    pub creator: Pubkey,
}

#[event]
pub struct LiquidityChanged {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp: u64,
    pub added: bool,
}

#[event]
pub struct Swapped {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub a_to_b: bool,
    pub amount_in: u64,
    pub amount_out: u64,
}

#[error_code]
pub enum AmmError {
    #[msg("Fee is above the maximum")]
    InvalidFee,
    #[msg("mint_a must sort before mint_b")]
    MintOrder,
    #[msg("Output is under the minimum")]
    Slippage,
    #[msg("The deadline slot has passed")]
    Expired,
    #[msg("Amount is zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Pool has no liquidity")]
    EmptyPool,
    #[msg("First deposit is below the locked minimum")]
    InsufficientInitialLiquidity,
}
