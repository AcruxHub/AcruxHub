//! AcruxHub Bridge: the same program runs on Solana and on Acrux Net.
//!
//! Outbound: a user locks a native token in custody (or burns a wrapped one) and
//! the program writes a permanent `Outbound` record. Inbound: guardians watching
//! the other chain approve the exact transfer payload; once `threshold` distinct
//! guardians of the current set have approved, anyone can `execute`, which marks
//! (source_chain, nonce) consumed and releases custody (or mints wrapped tokens).
//!
//! Safety rails: approvals are keyed by the payload hash, so a lying guardian can
//! never block or alter an honest payload; each (source_chain, nonce) executes at
//! most once; per-token rolling 24h caps bound the loss from a compromised quorum;
//! any guardian can pause, only the admin unpauses; rotating the guardian set
//! invalidates pending approvals.
//!
//! UNAUDITED. Do not route real value through it until it has been reviewed.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("D3ct55qQUcEp8RBiD6xU5e923yGN6B1SopFMNhQTc3CT");

pub const CONFIG_SEED: &[u8] = b"config";
pub const ROUTE_SEED: &[u8] = b"route";
pub const WRAPPED_SEED: &[u8] = b"wrapped";
pub const CUSTODY_SEED: &[u8] = b"custody";
pub const OUT_SEED: &[u8] = b"out";
pub const APPROVAL_SEED: &[u8] = b"approval";
pub const CONSUMED_SEED: &[u8] = b"consumed";
pub const MAX_GUARDIANS: usize = 16;
pub const CAP_WINDOW_SECONDS: i64 = 86_400;

#[program]
pub mod acruxhub_bridge {
    use super::*;

    /// One-time setup, gated on the upgrade authority.
    pub fn initialize(ctx: Context<Initialize>, chain_id: u16, guardians: Vec<Pubkey>, threshold: u8) -> Result<()> {
        validate_guardians(&guardians, threshold)?;
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.chain_id = chain_id;
        c.guardians = guardians;
        c.threshold = threshold;
        c.guardian_set = 0;
        c.paused = false;
        c.next_nonce = 0;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// Replaces the guardian set. Pending approvals from the old set stop counting.
    pub fn set_guardians(ctx: Context<Admin>, guardians: Vec<Pubkey>, threshold: u8) -> Result<()> {
        validate_guardians(&guardians, threshold)?;
        let c = &mut ctx.accounts.config;
        c.guardians = guardians;
        c.threshold = threshold;
        c.guardian_set += 1;
        emit!(GuardiansChanged { guardian_set: c.guardian_set, threshold });
        Ok(())
    }

    pub fn set_admin(ctx: Context<Admin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.admin = new_admin;
        Ok(())
    }

    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        ctx.accounts.config.paused = false;
        emit!(PauseChanged { paused: false, by: ctx.accounts.admin.key() });
        Ok(())
    }

    /// Emergency stop: the admin or any single guardian.
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let who = ctx.accounts.signer.key();
        require!(who == c.admin || c.guardians.contains(&who), BridgeError::Unauthorized);
        c.paused = true;
        emit!(PauseChanged { paused: true, by: who });
        Ok(())
    }

    /// Registers a token native to this chain: outbound locks it in custody.
    pub fn register_native(ctx: Context<RegisterNative>, remote_chain: u16, remote_mint: Pubkey, daily_cap: u64) -> Result<()> {
        let r = &mut ctx.accounts.route;
        r.local_mint = ctx.accounts.mint.key();
        r.native = true;
        r.remote_chain = remote_chain;
        r.remote_mint = remote_mint;
        r.daily_cap = daily_cap;
        r.window_start = 0;
        r.window_used = 0;
        r.bump = ctx.bumps.route;
        Ok(())
    }

    /// Registers the wrapped form of a token native to `remote_chain`. The wrapped
    /// mint is a PDA of this program; its decimals must equal the remote mint's.
    pub fn register_wrapped(ctx: Context<RegisterWrapped>, remote_chain: u16, remote_mint: Pubkey, _decimals: u8, daily_cap: u64) -> Result<()> {
        let r = &mut ctx.accounts.route;
        r.local_mint = ctx.accounts.mint.key();
        r.native = false;
        r.remote_chain = remote_chain;
        r.remote_mint = remote_mint;
        r.daily_cap = daily_cap;
        r.window_start = 0;
        r.window_used = 0;
        r.bump = ctx.bumps.route;
        Ok(())
    }

    pub fn set_cap(ctx: Context<SetCap>, daily_cap: u64) -> Result<()> {
        ctx.accounts.route.daily_cap = daily_cap;
        Ok(())
    }

    /// Locks (native) or burns (wrapped) `amount` and records the transfer for the guardians.
    pub fn send(ctx: Context<Send>, amount: u64, recipient: Pubkey) -> Result<()> {
        require!(amount > 0, BridgeError::ZeroAmount);
        require!(recipient != Pubkey::default(), BridgeError::BadRecipient);
        let c = &ctx.accounts.config;
        require!(!c.paused, BridgeError::Paused);
        let route = &ctx.accounts.route;
        let a = &ctx.accounts;
        if route.native {
            let custody = a.custody.as_ref().ok_or(BridgeError::MissingAccount)?;
            token::transfer(
                CpiContext::new(
                    a.token_program.to_account_info(),
                    Transfer { from: a.user_tokens.to_account_info(), to: custody.to_account_info(), authority: a.user.to_account_info() },
                ),
                amount,
            )?;
        } else {
            token::burn(
                CpiContext::new(
                    a.token_program.to_account_info(),
                    Burn { mint: a.mint.to_account_info(), from: a.user_tokens.to_account_info(), authority: a.user.to_account_info() },
                ),
                amount,
            )?;
        }

        let nonce = c.next_nonce;
        let out = &mut ctx.accounts.outbound;
        out.nonce = nonce;
        out.source_chain = c.chain_id;
        out.dest_chain = route.remote_chain;
        out.dest_mint = route.remote_mint;
        out.sender = ctx.accounts.user.key();
        out.recipient = recipient;
        out.amount = amount;
        out.slot = Clock::get()?.slot;
        out.bump = ctx.bumps.outbound;
        let payload = Payload { source_chain: c.chain_id, nonce, dest_chain: route.remote_chain, dest_mint: route.remote_mint, recipient, amount };
        emit!(Sent { nonce, sender: out.sender, local_mint: route.local_mint, dest_chain: payload.dest_chain, dest_mint: payload.dest_mint, recipient, amount, digest: payload.digest() });
        ctx.accounts.config.next_nonce += 1;
        Ok(())
    }

    /// A guardian approves an inbound payload observed (finalized) on the source chain.
    pub fn approve(ctx: Context<Approve>, payload: Payload) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, BridgeError::Paused);
        require!(payload.dest_chain == c.chain_id, BridgeError::WrongChain);
        require!(payload.source_chain != c.chain_id, BridgeError::WrongChain);
        require!(payload.amount > 0, BridgeError::ZeroAmount);
        let index = c.guardians.iter().position(|g| *g == ctx.accounts.guardian.key()).ok_or(BridgeError::Unauthorized)?;

        let approval = &mut ctx.accounts.approval;
        if approval.digest == [0u8; 32] {
            approval.digest = payload.digest();
            approval.payload = payload.clone();
            approval.guardian_set = c.guardian_set;
            approval.signers = 0;
            approval.bump = ctx.bumps.approval;
        }
        if approval.guardian_set != c.guardian_set {
            // The set rotated since the first approval: start counting again.
            approval.guardian_set = c.guardian_set;
            approval.signers = 0;
        }
        approval.signers |= 1u16 << index;
        emit!(Approved { digest: approval.digest, guardian: ctx.accounts.guardian.key(), count: approval.signers.count_ones() as u8 });
        Ok(())
    }

    /// Anyone: executes an approved payload once, releasing custody or minting wrapped tokens.
    pub fn execute(ctx: Context<Execute>) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, BridgeError::Paused);
        let approval = &ctx.accounts.approval;
        require!(approval.guardian_set == c.guardian_set, BridgeError::StaleApprovals);
        require!(approval.signers.count_ones() as u8 >= c.threshold, BridgeError::NotEnoughApprovals);
        let p = approval.payload.clone();
        let route = &ctx.accounts.route;
        require!(route.local_mint == p.dest_mint && route.remote_chain == p.source_chain, BridgeError::RouteMismatch);
        require!(ctx.accounts.recipient.key() == p.recipient, BridgeError::BadRecipient);

        // Rolling cap.
        let now = Clock::get()?.unix_timestamp;
        let route = &mut ctx.accounts.route;
        if now - route.window_start >= CAP_WINDOW_SECONDS {
            route.window_start = now;
            route.window_used = 0;
        }
        let used = route.window_used.checked_add(p.amount).ok_or(BridgeError::Overflow)?;
        require!(used <= route.daily_cap, BridgeError::CapExceeded);
        route.window_used = used;

        let consumed = &mut ctx.accounts.consumed;
        consumed.digest = approval.digest;
        consumed.slot = Clock::get()?.slot;

        let route = &ctx.accounts.route;
        let mint_key = route.local_mint;
        let seeds: &[&[u8]] = &[ROUTE_SEED, mint_key.as_ref(), &[route.bump]];
        let a = &ctx.accounts;
        if route.native {
            let custody = a.custody.as_ref().ok_or(BridgeError::MissingAccount)?;
            token::transfer(
                CpiContext::new_with_signer(
                    a.token_program.to_account_info(),
                    Transfer { from: custody.to_account_info(), to: a.recipient_tokens.to_account_info(), authority: route.to_account_info() },
                    &[seeds],
                ),
                p.amount,
            )?;
        } else {
            token::mint_to(
                CpiContext::new_with_signer(
                    a.token_program.to_account_info(),
                    MintTo { mint: a.mint.to_account_info(), to: a.recipient_tokens.to_account_info(), authority: route.to_account_info() },
                    &[seeds],
                ),
                p.amount,
            )?;
        }
        emit!(Executed { digest: approval.digest, source_chain: p.source_chain, nonce: p.nonce, recipient: p.recipient, amount: p.amount });
        Ok(())
    }
}

fn validate_guardians(guardians: &[Pubkey], threshold: u8) -> Result<()> {
    require!(!guardians.is_empty() && guardians.len() <= MAX_GUARDIANS, BridgeError::BadGuardians);
    require!(threshold as usize > guardians.len() / 2 && threshold as usize <= guardians.len(), BridgeError::BadGuardians);
    for (i, g) in guardians.iter().enumerate() {
        require!(!guardians[..i].contains(g), BridgeError::BadGuardians);
    }
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct Payload {
    pub source_chain: u16,
    pub nonce: u64,
    pub dest_chain: u16,
    pub dest_mint: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
}

impl Payload {
    pub fn digest(&self) -> [u8; 32] {
        hashv(&[
            b"acruxhub-bridge-v1",
            &self.source_chain.to_le_bytes(),
            &self.nonce.to_le_bytes(),
            &self.dest_chain.to_le_bytes(),
            self.dest_mint.as_ref(),
            self.recipient.as_ref(),
            &self.amount.to_le_bytes(),
        ])
        .to_bytes()
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub chain_id: u16,
    #[max_len(MAX_GUARDIANS)]
    pub guardians: Vec<Pubkey>,
    pub threshold: u8,
    pub guardian_set: u32,
    pub paused: bool,
    pub next_nonce: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Route {
    pub local_mint: Pubkey,
    pub native: bool,
    pub remote_chain: u16,
    pub remote_mint: Pubkey,
    pub daily_cap: u64,
    pub window_start: i64,
    pub window_used: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Outbound {
    pub nonce: u64,
    pub source_chain: u16,
    pub dest_chain: u16,
    pub dest_mint: Pubkey,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub slot: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Approval {
    pub digest: [u8; 32],
    pub payload: Payload,
    pub guardian_set: u32,
    pub signers: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Consumed {
    pub digest: [u8; 32],
    pub slot: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ BridgeError::Unauthorized)]
    pub program: Program<'info, crate::program::AcruxhubBridge>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ BridgeError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BridgeError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct RegisterNative<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BridgeError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(init, payer = admin, space = 8 + Route::INIT_SPACE, seeds = [ROUTE_SEED, mint.key().as_ref()], bump)]
    pub route: Box<Account<'info, Route>>,
    #[account(init, payer = admin, seeds = [CUSTODY_SEED, mint.key().as_ref()], bump, token::mint = mint, token::authority = route)]
    pub custody: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(remote_chain: u16, remote_mint: Pubkey, decimals: u8)]
pub struct RegisterWrapped<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BridgeError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init, payer = admin, seeds = [WRAPPED_SEED, &remote_chain.to_le_bytes(), remote_mint.as_ref()], bump,
        mint::decimals = decimals, mint::authority = route
    )]
    pub mint: Box<Account<'info, Mint>>,
    #[account(init, payer = admin, space = 8 + Route::INIT_SPACE, seeds = [ROUTE_SEED, mint.key().as_ref()], bump)]
    pub route: Box<Account<'info, Route>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetCap<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BridgeError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub route: Account<'info, Route>,
}

#[derive(Accounts)]
pub struct Send<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [ROUTE_SEED, mint.key().as_ref()], bump = route.bump)]
    pub route: Box<Account<'info, Route>>,
    #[account(mut, address = route.local_mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = user)]
    pub user_tokens: Box<Account<'info, TokenAccount>>,
    /// Required for native routes.
    #[account(mut, seeds = [CUSTODY_SEED, mint.key().as_ref()], bump)]
    pub custody: Option<Box<Account<'info, TokenAccount>>>,
    #[account(init, payer = user, space = 8 + Outbound::INIT_SPACE, seeds = [OUT_SEED, &config.next_nonce.to_le_bytes()], bump)]
    pub outbound: Box<Account<'info, Outbound>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(payload: Payload)]
pub struct Approve<'info> {
    #[account(mut)]
    pub guardian: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed, payer = guardian, space = 8 + Approval::INIT_SPACE,
        seeds = [APPROVAL_SEED, &payload.digest()], bump
    )]
    pub approval: Box<Account<'info, Approval>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [APPROVAL_SEED, &approval.digest], bump = approval.bump)]
    pub approval: Box<Account<'info, Approval>>,
    /// Exists once per (source_chain, nonce): a second execute of any payload for it fails here.
    #[account(
        init, payer = payer, space = 8 + Consumed::INIT_SPACE,
        seeds = [CONSUMED_SEED, &approval.payload.source_chain.to_le_bytes(), &approval.payload.nonce.to_le_bytes()], bump
    )]
    pub consumed: Box<Account<'info, Consumed>>,
    #[account(mut, seeds = [ROUTE_SEED, mint.key().as_ref()], bump = route.bump)]
    pub route: Box<Account<'info, Route>>,
    #[account(mut, address = route.local_mint)]
    pub mint: Box<Account<'info, Mint>>,
    /// Required for native routes.
    #[account(mut, seeds = [CUSTODY_SEED, mint.key().as_ref()], bump)]
    pub custody: Option<Box<Account<'info, TokenAccount>>>,
    /// CHECK: must equal the payload's recipient (checked in the handler).
    pub recipient: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = payer, associated_token::mint = mint, associated_token::authority = recipient)]
    pub recipient_tokens: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct Sent {
    pub nonce: u64,
    pub sender: Pubkey,
    pub local_mint: Pubkey,
    pub dest_chain: u16,
    pub dest_mint: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub digest: [u8; 32],
}

#[event]
pub struct Approved {
    pub digest: [u8; 32],
    pub guardian: Pubkey,
    pub count: u8,
}

#[event]
pub struct Executed {
    pub digest: [u8; 32],
    pub source_chain: u16,
    pub nonce: u64,
    pub recipient: Pubkey,
    pub amount: u64,
}

#[event]
pub struct GuardiansChanged {
    pub guardian_set: u32,
    pub threshold: u8,
}

#[event]
pub struct PauseChanged {
    pub paused: bool,
    pub by: Pubkey,
}

#[error_code]
pub enum BridgeError {
    #[msg("Signer is not authorized")]
    Unauthorized,
    #[msg("Guardians must be unique, 1-16, with a strict-majority threshold")]
    BadGuardians,
    #[msg("Bridge is paused")]
    Paused,
    #[msg("Amount is zero")]
    ZeroAmount,
    #[msg("Recipient is invalid or does not match the payload")]
    BadRecipient,
    #[msg("Payload is not for this chain")]
    WrongChain,
    #[msg("Approvals are from a previous guardian set")]
    StaleApprovals,
    #[msg("Not enough guardian approvals")]
    NotEnoughApprovals,
    #[msg("Route does not match the payload")]
    RouteMismatch,
    #[msg("Daily cap exceeded for this token")]
    CapExceeded,
    #[msg("A required account is missing")]
    MissingAccount,
    #[msg("Arithmetic overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    #[test]
    fn guardian_rules() {
        assert!(validate_guardians(&[key(1), key(2), key(3)], 2).is_ok());
        assert!(validate_guardians(&[key(1), key(2), key(3)], 1).is_err(), "minority threshold");
        assert!(validate_guardians(&[key(1), key(2)], 1).is_err(), "half is not a majority");
        assert!(validate_guardians(&[key(1), key(1), key(3)], 2).is_err(), "duplicates");
        assert!(validate_guardians(&[key(1)], 2).is_err());
        assert!(validate_guardians(&[], 0).is_err());
    }

    #[test]
    fn digest_binds_every_field() {
        let p = Payload { source_chain: 1, nonce: 7, dest_chain: 2, dest_mint: key(9), recipient: key(8), amount: 100 };
        let d = p.digest();
        let variants = [
            Payload { source_chain: 3, ..p.clone() },
            Payload { nonce: 8, ..p.clone() },
            Payload { dest_chain: 4, ..p.clone() },
            Payload { dest_mint: key(1), ..p.clone() },
            Payload { recipient: key(1), ..p.clone() },
            Payload { amount: 101, ..p.clone() },
        ];
        for v in variants {
            assert_ne!(v.digest(), d);
        }
    }
}
