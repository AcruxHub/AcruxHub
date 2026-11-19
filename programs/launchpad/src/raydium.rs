//! Raydium CPMM, called by hand-built instructions (no Raydium crate). Account
//! order and layouts mirror sdk/src/raydium.ts, which is checked against
//! Raydium's own SDK.

use crate::LaunchError;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

/// Raydium CPMM program (a plain constant: a second `declare_id!` would become
/// the launchpad IDL's address).
pub const ID: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

/// Receives the pool-creation fee (a wrapped-native token account).
pub const CREATE_POOL_FEE_RECEIVER: Pubkey = pubkey!("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
pub const AUTH_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";
/// sha256("global:initialize")[..8]
pub const INITIALIZE_DISC: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];
/// sha256("account:AmmConfig")[..8]
pub const AMM_CONFIG_DISC: [u8; 8] = [218, 244, 33, 104, 203, 203, 43, 111];
pub const AMM_CONFIG_LEN: usize = 236;

/// Highest trade fee (parts per million) a graduated pool may use: 1%.
pub const MAX_TRADE_FEE_RATE: u64 = 10_000;

/// Sizes of the accounts `initialize` creates and the creator pays rent for.
pub const POOL_STATE_LEN: usize = 637;
pub const MINT_LEN: usize = 82;
pub const TOKEN_ACCOUNT_LEN: usize = 165;
/// 8 + 1 + 2 + 32 + 100 * 40 + 4 * 8
pub const OBSERVATION_LEN: usize = 4075;
/// Extra lamports sent to the graduator; whatever is left is refunded.
pub const FUNDING_MARGIN: u64 = 10_000_000;

/// Checks a fee tier and returns its pool-creation fee in lamports.
pub fn check_amm_config(info: &AccountInfo) -> Result<u64> {
    require_keys_eq!(*info.owner, ID, LaunchError::BadFeeTier);
    let d = info.try_borrow_data()?;
    require!(d.len() == AMM_CONFIG_LEN && d[..8] == AMM_CONFIG_DISC, LaunchError::BadFeeTier);
    require!(d[9] == 0, LaunchError::BadFeeTier); // disable_create_pool
    let u64_at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
    require!(u64_at(12) <= MAX_TRADE_FEE_RATE, LaunchError::BadFeeTier); // trade_fee_rate
    Ok(u64_at(36)) // create_pool_fee
}

/// Rent for everything `initialize` creates: pool, LP mint, two vaults, the
/// creator's LP ATA and the observation account.
pub fn creation_rent(rent: &Rent) -> u64 {
    rent.minimum_balance(POOL_STATE_LEN)
        + rent.minimum_balance(MINT_LEN)
        + 3 * rent.minimum_balance(TOKEN_ACCOUNT_LEN)
        + rent.minimum_balance(OBSERVATION_LEN)
}

pub struct InitializeAccounts<'a, 'info> {
    pub creator: &'a AccountInfo<'info>,
    pub amm_config: &'a AccountInfo<'info>,
    pub authority: &'a AccountInfo<'info>,
    pub pool_state: &'a AccountInfo<'info>,
    pub mint_0: &'a AccountInfo<'info>,
    pub mint_1: &'a AccountInfo<'info>,
    pub lp_mint: &'a AccountInfo<'info>,
    pub creator_token_0: &'a AccountInfo<'info>,
    pub creator_token_1: &'a AccountInfo<'info>,
    pub creator_lp: &'a AccountInfo<'info>,
    pub vault_0: &'a AccountInfo<'info>,
    pub vault_1: &'a AccountInfo<'info>,
    pub create_pool_fee: &'a AccountInfo<'info>,
    pub observation: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub associated_token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub rent: &'a AccountInfo<'info>,
    pub cpmm_program: &'a AccountInfo<'info>,
}

/// CPI `initialize(init_amount_0, init_amount_1, open_time)`. Both tokens use
/// the classic token program.
pub fn initialize(a: &InitializeAccounts, amount_0: u64, amount_1: u64, open_time: u64, signer: &[&[&[u8]]]) -> Result<()> {
    let w = |i: &AccountInfo| AccountMeta::new(*i.key, false);
    let r = |i: &AccountInfo| AccountMeta::new_readonly(*i.key, false);
    let mut data = Vec::with_capacity(32);
    data.extend_from_slice(&INITIALIZE_DISC);
    data.extend_from_slice(&amount_0.to_le_bytes());
    data.extend_from_slice(&amount_1.to_le_bytes());
    data.extend_from_slice(&open_time.to_le_bytes());
    let ix = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(*a.creator.key, true),
            r(a.amm_config),
            r(a.authority),
            w(a.pool_state),
            r(a.mint_0),
            r(a.mint_1),
            w(a.lp_mint),
            w(a.creator_token_0),
            w(a.creator_token_1),
            w(a.creator_lp),
            w(a.vault_0),
            w(a.vault_1),
            w(a.create_pool_fee),
            w(a.observation),
            r(a.token_program), // lp mint's program
            r(a.token_program), // token 0's program
            r(a.token_program), // token 1's program
            r(a.associated_token_program),
            r(a.system_program),
            r(a.rent),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            a.creator.clone(),
            a.amm_config.clone(),
            a.authority.clone(),
            a.pool_state.clone(),
            a.mint_0.clone(),
            a.mint_1.clone(),
            a.lp_mint.clone(),
            a.creator_token_0.clone(),
            a.creator_token_1.clone(),
            a.creator_lp.clone(),
            a.vault_0.clone(),
            a.vault_1.clone(),
            a.create_pool_fee.clone(),
            a.observation.clone(),
            a.token_program.clone(),
            a.associated_token_program.clone(),
            a.system_program.clone(),
            a.rent.clone(),
            a.cpmm_program.clone(),
        ],
        signer,
    )
    .map_err(Into::into)
}
