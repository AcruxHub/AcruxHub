//! AcruxHub token locks: lock any SPL token until a date, provably.
//!
//! lock(id, amount, unlock_ts): moves `amount` into a vault owned by the lock's PDA.
//! Nothing can move it out before `unlock_ts`: not the owner, not us. There is no
//! admin and no early release.
//! extend(new_unlock_ts): the owner may push the date LATER, never earlier.
//! unlock(): after the date, the owner gets everything back and the accounts close.
//!
//! Anyone can read a lock (owner, mint, amount, dates) to check a team's tokens are
//! really locked; the site lists them on each coin.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("12Bt6QsAA2Xh2Zo6fzUoeuYqsstpvPfZSeUbt3mwMBzh");

pub const LOCK_SEED: &[u8] = b"lock";
/// Longest lock: 10 years, so a typo in the date can't lock tokens for centuries.
pub const MAX_LOCK_SECS: i64 = 10 * 365 * 24 * 60 * 60;

#[program]
pub mod acruxhub_locker {
    use super::*;

    /// Locks `amount` of the mint until `unlock_ts` (unix seconds). `id` lets one
    /// owner hold several locks of the same token.
    pub fn lock(ctx: Context<Lock>, id: u64, amount: u64, unlock_ts: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(amount > 0, LockError::ZeroAmount);
        require!(unlock_ts > now, LockError::UnlockInPast);
        require!(unlock_ts - now <= MAX_LOCK_SECS, LockError::TooLong);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer { from: ctx.accounts.owner_tokens.to_account_info(), to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.owner.to_account_info() },
            ),
            amount,
        )?;
        let l = &mut ctx.accounts.lock;
        l.owner = ctx.accounts.owner.key();
        l.mint = ctx.accounts.mint.key();
        l.id = id;
        l.amount = amount;
        l.locked_at = now;
        l.unlock_ts = unlock_ts;
        l.bump = ctx.bumps.lock;
        emit!(Locked { lock: l.key(), owner: l.owner, mint: l.mint, amount, unlock_ts });
        Ok(())
    }

    /// Pushes the unlock date later. Never earlier.
    pub fn extend(ctx: Context<Extend>, new_unlock_ts: i64) -> Result<()> {
        let l = &mut ctx.accounts.lock;
        require!(new_unlock_ts > l.unlock_ts, LockError::NotLater);
        require!(new_unlock_ts - Clock::get()?.unix_timestamp <= MAX_LOCK_SECS, LockError::TooLong);
        l.unlock_ts = new_unlock_ts;
        emit!(Extended { lock: l.key(), unlock_ts: new_unlock_ts });
        Ok(())
    }

    /// After the date: everything back to the owner; the vault and lock close.
    pub fn unlock(ctx: Context<Unlock>) -> Result<()> {
        let l = &ctx.accounts.lock;
        require!(Clock::get()?.unix_timestamp >= l.unlock_ts, LockError::StillLocked);
        let id = l.id.to_le_bytes();
        let seeds: &[&[u8]] = &[LOCK_SEED, l.owner.as_ref(), l.mint.as_ref(), &id, &[l.bump]];
        let amount = ctx.accounts.vault.amount;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer { from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.owner_tokens.to_account_info(), authority: ctx.accounts.lock.to_account_info() },
                &[seeds],
            ),
            amount,
        )?;
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount { account: ctx.accounts.vault.to_account_info(), destination: ctx.accounts.owner.to_account_info(), authority: ctx.accounts.lock.to_account_info() },
            &[seeds],
        ))?;
        emit!(Unlocked { lock: ctx.accounts.lock.key(), amount });
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct TokenLock {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub id: u64,
    pub amount: u64,
    pub locked_at: i64,
    pub unlock_ts: i64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Lock<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = owner, space = 8 + TokenLock::INIT_SPACE, seeds = [LOCK_SEED, owner.key().as_ref(), mint.key().as_ref(), &id.to_le_bytes()], bump)]
    pub lock: Account<'info, TokenLock>,
    #[account(init, payer = owner, associated_token::mint = mint, associated_token::authority = lock)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Extend<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ LockError::NotOwner)]
    pub lock: Account<'info, TokenLock>,
}

#[derive(Accounts)]
pub struct Unlock<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ LockError::NotOwner, has_one = mint, close = owner)]
    pub lock: Account<'info, TokenLock>,
    pub mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = lock)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = owner, associated_token::mint = mint, associated_token::authority = owner)]
    pub owner_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct Locked {
    pub lock: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub unlock_ts: i64,
}

#[event]
pub struct Extended {
    pub lock: Pubkey,
    pub unlock_ts: i64,
}

#[event]
pub struct Unlocked {
    pub lock: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum LockError {
    #[msg("Amount is zero")]
    ZeroAmount,
    #[msg("The unlock date must be in the future")]
    UnlockInPast,
    #[msg("Locks are limited to 10 years")]
    TooLong,
    #[msg("A lock can only be extended to a later date")]
    NotLater,
    #[msg("Still locked")]
    StillLocked,
    #[msg("Only the lock's owner can do that")]
    NotOwner,
}
