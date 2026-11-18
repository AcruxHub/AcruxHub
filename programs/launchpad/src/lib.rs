//! AcruxHub Launchpad: fair-launch tokens on a constant-product bonding curve.
//!
//! Every launch mints a fixed supply into the curve and revokes the mint authority.
//! Buyers pay in the quote mint set in the global config (wrapped ACRUX on Acrux
//! Net). When the real quote raised reaches the graduation threshold, anyone can
//! call `graduate`: the raised quote and the matching tokens seed an AcruxHub AMM
//! pool at the curve's final price, the LP tokens are burned (liquidity locked
//! forever) and leftover tokens are burned.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Burn, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};

use acruxhub_amm::program::AcruxhubAmm;

pub mod curve;

declare_id!("3qCdE6gNWinKpPX71JZk8DGe2AYsYaVg6v8WB7N3SKrd");

pub const CONFIG_SEED: &[u8] = b"config";
pub const LAUNCH_SEED: &[u8] = b"launch";
pub const TOKEN_DECIMALS: u8 = 6;
pub const MAX_FEE_BPS: u16 = 500;
/// Fee tier of graduated pools.
pub const GRADUATED_POOL_FEE_BPS: u16 = 30;

#[program]
pub mod acruxhub_launchpad {
    use super::*;

    /// One-time setup, gated on the program's upgrade authority so nobody can
    /// front-run the configuration after deploy.
    pub fn initialize(ctx: Context<Initialize>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.quote_mint = ctx.accounts.quote_mint.key();
        config.params = params;
        config.launch_count = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Changes curve parameters for future launches. Existing launches keep theirs.
    pub fn update_config(ctx: Context<UpdateConfig>, params: ConfigParams, new_admin: Pubkey) -> Result<()> {
        params.validate()?;
        let config = &mut ctx.accounts.config;
        config.params = params;
        config.admin = new_admin;
        Ok(())
    }

    /// Creates a token and its curve. The creator gets nothing up front; buying is
    /// the only way to hold the token, on the same terms for everyone.
    pub fn create_launch(ctx: Context<CreateLaunch>, name: String, symbol: String, uri: String) -> Result<()> {
        require!(!name.is_empty() && name.len() <= 32, LaunchError::BadMetadata);
        require!(!symbol.is_empty() && symbol.len() <= 10, LaunchError::BadMetadata);
        require!(uri.len() <= 200, LaunchError::BadMetadata);
        let config = &mut ctx.accounts.config;
        let p = config.params.clone();
        let index = config.launch_count;
        config.launch_count += 1;

        let mint_key = ctx.accounts.mint.key();
        let launch = &mut ctx.accounts.launch;
        launch.creator = ctx.accounts.creator.key();
        launch.mint = mint_key;
        launch.curve_tokens = ctx.accounts.curve_tokens.key();
        launch.curve_quote = ctx.accounts.curve_quote.key();
        launch.pool = Pubkey::default();
        launch.index = index;
        launch.virtual_quote = p.virtual_quote;
        launch.virtual_tokens = p.virtual_tokens;
        launch.real_quote = 0;
        launch.real_tokens = p.curve_supply;
        launch.graduation_quote = p.graduation_quote;
        launch.fee_bps = p.fee_bps;
        launch.fee_recipient = p.fee_recipient;
        launch.complete = false;
        launch.graduated = false;
        launch.created_slot = Clock::get()?.slot;
        launch.bump = ctx.bumps.launch;
        launch.name = name.clone();
        launch.symbol = symbol.clone();
        launch.uri = uri;

        let seeds: &[&[u8]] = &[LAUNCH_SEED, mint_key.as_ref(), &[launch.bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.curve_tokens.to_account_info(),
                    authority: ctx.accounts.launch.to_account_info(),
                },
                &[seeds],
            ),
            p.total_supply,
        )?;
        // Fixed supply: nobody can ever mint again.
        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.launch.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
                &[seeds],
            ),
            AuthorityType::MintTokens,
            None,
        )?;
        emit!(LaunchCreated { launch: ctx.accounts.launch.key(), mint: mint_key, creator: ctx.accounts.creator.key(), name, symbol, index });
        Ok(())
    }

    /// Spends up to `quote_in` (fee included) for at least `min_tokens_out`. The buy
    /// that crosses the graduation threshold is clipped and pays only for what it gets.
    pub fn buy(ctx: Context<Trade>, quote_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(!ctx.accounts.launch.complete, LaunchError::Complete);
        let q = curve::buy(&ctx.accounts.launch.state(), quote_in)?;
        require!(q.tokens_out >= min_tokens_out && q.tokens_out > 0, LaunchError::Slippage);

        let a = &ctx.accounts;
        transfer_user(a, &a.user_quote, &a.curve_quote, q.quote_to_curve)?;
        if q.fee > 0 {
            transfer_user(a, &a.user_quote, &a.fee_quote, q.fee)?;
        }
        transfer_curve(a, &a.curve_tokens, &a.user_tokens, q.tokens_out)?;

        let user = ctx.accounts.user.key();
        let launch = &mut ctx.accounts.launch;
        launch.apply(&q.next);
        emit!(Traded {
            launch: launch.key(),
            user,
            buy: true,
            quote: q.quote_to_curve + q.fee,
            tokens: q.tokens_out,
            virtual_quote: launch.virtual_quote,
            virtual_tokens: launch.virtual_tokens,
        });
        if launch.real_quote >= launch.graduation_quote {
            launch.complete = true;
            emit!(LaunchComplete { launch: launch.key(), mint: launch.mint, real_quote: launch.real_quote });
        }
        Ok(())
    }

    /// Sells exactly `tokens_in` for at least `min_quote_out` (after the fee).
    pub fn sell(ctx: Context<Trade>, tokens_in: u64, min_quote_out: u64) -> Result<()> {
        require!(!ctx.accounts.launch.complete, LaunchError::Complete);
        let q = curve::sell(&ctx.accounts.launch.state(), tokens_in)?;
        require!(q.quote_to_user >= min_quote_out && q.quote_to_user > 0, LaunchError::Slippage);

        let a = &ctx.accounts;
        transfer_user(a, &a.user_tokens, &a.curve_tokens, tokens_in)?;
        transfer_curve(a, &a.curve_quote, &a.user_quote, q.quote_to_user)?;
        if q.fee > 0 {
            transfer_curve(a, &a.curve_quote, &a.fee_quote, q.fee)?;
        }

        let user = ctx.accounts.user.key();
        let launch = &mut ctx.accounts.launch;
        launch.apply(&q.next);
        emit!(Traded {
            launch: launch.key(),
            user,
            buy: false,
            quote: q.quote_to_user,
            tokens: tokens_in,
            virtual_quote: launch.virtual_quote,
            virtual_tokens: launch.virtual_tokens,
        });
        Ok(())
    }

    /// Permissionless once the curve is complete: creates the AMM pool at the
    /// curve's final price, deposits, burns the LP tokens and the leftover tokens.
    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        let launch = &ctx.accounts.launch;
        require!(launch.complete && !launch.graduated, LaunchError::NotComplete);

        let quote_amount = launch.real_quote;
        let held = ctx.accounts.curve_tokens.amount;
        let token_amount = curve::tokens_for_pool(&launch.state(), quote_amount)?.min(held);
        let burn_excess = held - token_amount;

        let mint_key = launch.mint;
        let bump = launch.bump;
        let seeds: &[&[u8]] = &[LAUNCH_SEED, mint_key.as_ref(), &[bump]];
        let signer = &[seeds];
        let a = &ctx.accounts;
        let token_is_a = a.token_mint.key() < a.quote_mint.key();
        let (mint_a, mint_b) = if token_is_a { (a.token_mint.to_account_info(), a.quote_mint.to_account_info()) } else { (a.quote_mint.to_account_info(), a.token_mint.to_account_info()) };
        let (src_a, src_b) = if token_is_a { (a.curve_tokens.to_account_info(), a.curve_quote.to_account_info()) } else { (a.curve_quote.to_account_info(), a.curve_tokens.to_account_info()) };
        let (amount_a, amount_b) = if token_is_a { (token_amount, quote_amount) } else { (quote_amount, token_amount) };

        acruxhub_amm::cpi::create_pool(
            CpiContext::new(
                a.amm_program.to_account_info(),
                acruxhub_amm::cpi::accounts::CreatePool {
                    payer: a.payer.to_account_info(),
                    mint_a: mint_a.clone(),
                    mint_b: mint_b.clone(),
                    pool: a.pool.to_account_info(),
                    vault_a: a.vault_a.to_account_info(),
                    vault_b: a.vault_b.to_account_info(),
                    lp_mint: a.lp_mint.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                    system_program: a.system_program.to_account_info(),
                    rent: a.rent.to_account_info(),
                },
            ),
            GRADUATED_POOL_FEE_BPS,
        )?;
        acruxhub_amm::cpi::add_liquidity(
            CpiContext::new_with_signer(
                a.amm_program.to_account_info(),
                acruxhub_amm::cpi::accounts::AddLiquidity {
                    payer: a.payer.to_account_info(),
                    owner: a.launch.to_account_info(),
                    pool: a.pool.to_account_info(),
                    mint_a,
                    mint_b,
                    vault_a: a.vault_a.to_account_info(),
                    vault_b: a.vault_b.to_account_info(),
                    lp_mint: a.lp_mint.to_account_info(),
                    owner_a: src_a,
                    owner_b: src_b,
                    owner_lp: a.launch_lp.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                    associated_token_program: a.associated_token_program.to_account_info(),
                    system_program: a.system_program.to_account_info(),
                },
                signer,
            ),
            amount_a,
            amount_b,
            1,
        )?;

        // Lock the liquidity: burn every LP token the launch received.
        let lp = {
            let data = a.launch_lp.try_borrow_data()?;
            TokenAccount::try_deserialize(&mut &data[..])?.amount
        };
        token::burn(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                Burn { mint: a.lp_mint.to_account_info(), from: a.launch_lp.to_account_info(), authority: a.launch.to_account_info() },
                signer,
            ),
            lp,
        )?;
        if burn_excess > 0 {
            token::burn(
                CpiContext::new_with_signer(
                    a.token_program.to_account_info(),
                    Burn { mint: a.token_mint.to_account_info(), from: a.curve_tokens.to_account_info(), authority: a.launch.to_account_info() },
                    signer,
                ),
                burn_excess,
            )?;
        }

        let pool_key = ctx.accounts.pool.key();
        let launch = &mut ctx.accounts.launch;
        launch.graduated = true;
        launch.pool = pool_key;
        emit!(Graduated { launch: launch.key(), mint: mint_key, pool: pool_key, tokens: token_amount, quote: quote_amount, lp_burned: lp, tokens_burned: burn_excess });
        Ok(())
    }
}

fn transfer_user<'info>(a: &Trade<'info>, from: &Account<'info, TokenAccount>, to: &Account<'info, TokenAccount>, amount: u64) -> Result<()> {
    token::transfer(
        CpiContext::new(
            a.token_program.to_account_info(),
            Transfer { from: from.to_account_info(), to: to.to_account_info(), authority: a.user.to_account_info() },
        ),
        amount,
    )
}

fn transfer_curve<'info>(a: &Trade<'info>, from: &Account<'info, TokenAccount>, to: &Account<'info, TokenAccount>, amount: u64) -> Result<()> {
    let mint = a.launch.mint;
    let seeds: &[&[u8]] = &[LAUNCH_SEED, mint.as_ref(), &[a.launch.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            Transfer { from: from.to_account_info(), to: to.to_account_info(), authority: a.launch.to_account_info() },
            &[seeds],
        ),
        amount,
    )
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, Debug)]
pub struct ConfigParams {
    pub fee_bps: u16,
    pub fee_recipient: Pubkey,
    pub total_supply: u64,
    /// Tokens sellable through the curve; the rest are reserved for the pool.
    pub curve_supply: u64,
    pub virtual_quote: u64,
    pub virtual_tokens: u64,
    pub graduation_quote: u64,
}

impl ConfigParams {
    pub fn validate(&self) -> Result<()> {
        require!(self.fee_bps <= MAX_FEE_BPS, LaunchError::BadConfig);
        require!(self.curve_supply > 0 && self.curve_supply < self.total_supply, LaunchError::BadConfig);
        require!(self.virtual_tokens >= self.curve_supply, LaunchError::BadConfig);
        require!(self.virtual_quote > 0 && self.graduation_quote > 0, LaunchError::BadConfig);
        curve::check_params(self.virtual_quote, self.virtual_tokens, self.curve_supply, self.total_supply, self.graduation_quote)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub quote_mint: Pubkey,
    pub params: ConfigParams,
    pub launch_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Launch {
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub curve_tokens: Pubkey,
    pub curve_quote: Pubkey,
    pub pool: Pubkey,
    pub fee_recipient: Pubkey,
    pub index: u64,
    pub virtual_quote: u64,
    pub virtual_tokens: u64,
    pub real_quote: u64,
    pub real_tokens: u64,
    pub graduation_quote: u64,
    pub fee_bps: u16,
    pub complete: bool,
    pub graduated: bool,
    pub created_slot: u64,
    pub bump: u8,
    #[max_len(32)]
    pub name: String,
    #[max_len(10)]
    pub symbol: String,
    #[max_len(200)]
    pub uri: String,
}

impl Launch {
    pub fn state(&self) -> curve::CurveState {
        curve::CurveState {
            virtual_quote: self.virtual_quote,
            virtual_tokens: self.virtual_tokens,
            real_quote: self.real_quote,
            real_tokens: self.real_tokens,
            graduation_quote: self.graduation_quote,
            fee_bps: self.fee_bps,
        }
    }
    fn apply(&mut self, s: &curve::CurveState) {
        self.virtual_quote = s.virtual_quote;
        self.virtual_tokens = s.virtual_tokens;
        self.real_quote = s.real_quote;
        self.real_tokens = s.real_tokens;
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    pub quote_mint: Account<'info, Mint>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ LaunchError::Unauthorized)]
    pub program: Program<'info, crate::program::AcruxhubLaunchpad>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ LaunchError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ LaunchError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct CreateLaunch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// A fresh keypair the client generates, so every launch has its own address.
    #[account(init, payer = creator, mint::decimals = TOKEN_DECIMALS, mint::authority = launch)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, space = 8 + Launch::INIT_SPACE, seeds = [LAUNCH_SEED, mint.key().as_ref()], bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(init, payer = creator, associated_token::mint = mint, associated_token::authority = launch)]
    pub curve_tokens: Box<Account<'info, TokenAccount>>,
    #[account(address = config.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, associated_token::mint = quote_mint, associated_token::authority = launch)]
    pub curve_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump, has_one = curve_tokens, has_one = curve_quote)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(address = launch.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(address = config.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub curve_tokens: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub curve_quote: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = user, associated_token::mint = mint, associated_token::authority = user)]
    pub user_tokens: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = user)]
    pub user_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = launch.fee_recipient)]
    pub fee_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Graduate<'info> {
    /// Anyone: pays rent for the pool accounts.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump, has_one = curve_tokens, has_one = curve_quote)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(mut, address = launch.mint)]
    pub token_mint: Box<Account<'info, Mint>>,
    #[account(address = config.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub curve_tokens: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub curve_quote: Box<Account<'info, TokenAccount>>,
    /// CHECK: created by the AMM, which checks its seeds.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: created by the AMM, which checks its seeds.
    #[account(mut)]
    pub vault_a: UncheckedAccount<'info>,
    /// CHECK: created by the AMM, which checks its seeds.
    #[account(mut)]
    pub vault_b: UncheckedAccount<'info>,
    /// CHECK: created by the AMM, which checks its seeds.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: the launch's LP associated token account; the AMM creates and checks it.
    #[account(mut)]
    pub launch_lp: UncheckedAccount<'info>,
    pub amm_program: Program<'info, AcruxhubAmm>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[event]
pub struct LaunchCreated {
    pub launch: Pubkey,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub name: String,
    pub symbol: String,
    pub index: u64,
}

#[event]
pub struct Traded {
    pub launch: Pubkey,
    pub user: Pubkey,
    pub buy: bool,
    pub quote: u64,
    pub tokens: u64,
    pub virtual_quote: u64,
    pub virtual_tokens: u64,
}

#[event]
pub struct LaunchComplete {
    pub launch: Pubkey,
    pub mint: Pubkey,
    pub real_quote: u64,
}

#[event]
pub struct Graduated {
    pub launch: Pubkey,
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub tokens: u64,
    pub quote: u64,
    pub lp_burned: u64,
    pub tokens_burned: u64,
}

#[error_code]
pub enum LaunchError {
    #[msg("Name 1-32, symbol 1-10, uri up to 200 characters")]
    BadMetadata,
    #[msg("Invalid configuration")]
    BadConfig,
    #[msg("Signer is not authorized")]
    Unauthorized,
    #[msg("The curve is complete; trade on the pool")]
    Complete,
    #[msg("The curve is not complete or already graduated")]
    NotComplete,
    #[msg("Output is under the minimum")]
    Slippage,
    #[msg("Amount is zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
}
