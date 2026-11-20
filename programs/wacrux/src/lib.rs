//! Wrapped ACRUX (wACRUX): ACRUX, Acrux's native gas coin, as an SPL token, 1:1.
//!
//! Acrux has no native-mint (wrapped SOL style) account, and SPL programs like the
//! launchpad and Raydium can only hold tokens, so this is that wrapper:
//!   wrap(n):   n ACRUX (lamports) move into the vault, n wACRUX are minted to you.
//!   unwrap(n): n wACRUX are burned, n ACRUX move from the vault back to you.
//! 9 decimals, so 1 wACRUX raw unit = 1 lamport. Nobody can mint without depositing
//! (the mint authority is the vault PDA), there is no freeze authority and no admin,
//! and every unwrap checks the vault still backs every wACRUX in circulation.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount};

declare_id!("8gVj4nV5djhxNdEPFXHepFRhkyheMmHt5CWufQEdUU7u");

pub const VAULT_SEED: &[u8] = b"vault";
pub const MINT_SEED: &[u8] = b"mint";
pub const DECIMALS: u8 = 9;

#[program]
pub mod acruxhub_wacrux {
    use super::*;

    /// One time: creates the vault and the wACRUX mint (anyone can pay for it).
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.vault.bump = ctx.bumps.vault;
        Ok(())
    }

    /// Locks `amount` ACRUX (lamports) in the vault and mints the same in wACRUX.
    pub fn wrap(ctx: Context<Wrap>, amount: u64) -> Result<()> {
        require!(amount > 0, WrapError::ZeroAmount);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer { from: ctx.accounts.user.to_account_info(), to: ctx.accounts.vault.to_account_info() },
            ),
            amount,
        )?;
        let bump = ctx.accounts.vault.bump;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_tokens.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[&[VAULT_SEED, &[bump]]],
            ),
            amount,
        )?;
        emit!(Wrapped { user: ctx.accounts.user.key(), amount });
        Ok(())
    }

    /// Burns `amount` wACRUX and pays the same in ACRUX out of the vault.
    pub fn unwrap(ctx: Context<Unwrap>, amount: u64) -> Result<()> {
        require!(amount > 0, WrapError::ZeroAmount);
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.user_tokens.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;
        // The vault is owned by this program, so it can debit it directly.
        let vault = ctx.accounts.vault.to_account_info();
        let user = ctx.accounts.user.to_account_info();
        **vault.try_borrow_mut_lamports()? = vault.lamports().checked_sub(amount).ok_or(WrapError::Undercollateralized)?;
        **user.try_borrow_mut_lamports()? = user.lamports().checked_add(amount).ok_or(WrapError::Overflow)?;

        // Backing check: what the vault holds above its own rent covers every wACRUX left.
        ctx.accounts.mint.reload()?;
        let rent = Rent::get()?.minimum_balance(vault.data_len());
        require!(vault.lamports().saturating_sub(rent) >= ctx.accounts.mint.supply, WrapError::Undercollateralized);
        emit!(Unwrapped { user: ctx.accounts.user.key(), amount });
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Vault::INIT_SPACE, seeds = [VAULT_SEED], bump)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = payer, seeds = [MINT_SEED], bump, mint::decimals = DECIMALS, mint::authority = vault)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Wrap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    #[account(init_if_needed, payer = user, associated_token::mint = mint, associated_token::authority = user)]
    pub user_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unwrap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = user)]
    pub user_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct Wrapped {
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Unwrapped {
    pub user: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum WrapError {
    #[msg("Amount is zero")]
    ZeroAmount,
    #[msg("The vault would not back every wACRUX")]
    Undercollateralized,
    #[msg("Arithmetic overflow")]
    Overflow,
}
