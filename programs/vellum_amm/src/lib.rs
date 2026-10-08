//! Minimal constant-product AMM for Token-2022 mints with transfer hooks.
//!
//! This is the "integration shim" half of Vellum: it proves that a
//! permissioned (transfer-hooked) equity token composes with a DeFi venue.
//! The entire integration cost for a venue is:
//!   1. move tokens with `spl_token_2022::onchain::invoke_transfer_checked`
//!      (which auto-resolves and forwards the hook's extra accounts), and
//!   2. get the pool authority attested as a VENUE in the Vellum registry.
//! Compliance still travels through the pool: an unattested wallet's swap
//! fails on the outbound leg inside the token program.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};

declare_id!("A3qAMaYo4zHfZev9aEm6Gvx8Z6KTxsauRpk6jhd6nYyF");

const FEE_NUMERATOR: u128 = 997; // 30 bps swap fee
const FEE_DENOMINATOR: u128 = 1000;

#[program]
pub mod vellum_amm {
    use super::*;

    /// Create a two-sided pool. Vault token accounts (ATAs owned by the pool
    /// authority PDA) must exist before calling.
    pub fn init_pool(ctx: Context<InitPool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.mint_a = ctx.accounts.mint_a.key();
        pool.mint_b = ctx.accounts.mint_b.key();
        pool.vault_a = ctx.accounts.vault_a.key();
        pool.vault_b = ctx.accounts.vault_b.key();
        pool.bump = ctx.bumps.pool;
        pool.authority_bump = ctx.bumps.pool_authority;
        Ok(())
    }

    /// Naive liquidity deposit (no LP tokens — demo pool).
    pub fn add_liquidity<'info>(
        ctx: Context<'_, '_, 'info, 'info, AddLiquidity<'info>>,
        amount_a: u64,
        amount_b: u64,
    ) -> Result<()> {
        transfer_with_hook(
            &ctx.accounts.token_program.key(),
            ctx.accounts.user_ata_a.to_account_info(),
            ctx.accounts.mint_a.to_account_info(),
            ctx.accounts.vault_a.to_account_info(),
            ctx.accounts.user.to_account_info(),
            ctx.remaining_accounts,
            amount_a,
            ctx.accounts.mint_a.decimals,
            &[],
        )?;
        transfer_with_hook(
            &ctx.accounts.token_program.key(),
            ctx.accounts.user_ata_b.to_account_info(),
            ctx.accounts.mint_b.to_account_info(),
            ctx.accounts.vault_b.to_account_info(),
            ctx.accounts.user.to_account_info(),
            ctx.remaining_accounts,
            amount_b,
            ctx.accounts.mint_b.decimals,
            &[],
        )?;
        Ok(())
    }

    /// Constant-product swap: `amount_in` of `mint_in` for at least
    /// `min_amount_out` of `mint_out`. Both transfer legs run through the
    /// token program, so transfer hooks fire on both — this is where an
    /// unattested trader gets rejected even though the pool itself is fine.
    pub fn swap<'info>(
        ctx: Context<'_, '_, 'info, 'info, Swap<'info>>,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        let pool = &ctx.accounts.pool;
        // Validate the in/out orientation against the pool's configuration.
        let valid_orientation = (ctx.accounts.vault_in.key() == pool.vault_a
            && ctx.accounts.vault_out.key() == pool.vault_b)
            || (ctx.accounts.vault_in.key() == pool.vault_b
                && ctx.accounts.vault_out.key() == pool.vault_a);
        require!(valid_orientation, AmmError::InvalidVaults);

        let reserve_in = ctx.accounts.vault_in.amount as u128;
        let reserve_out = ctx.accounts.vault_out.amount as u128;
        require!(reserve_in > 0 && reserve_out > 0, AmmError::EmptyPool);

        let amount_in_after_fee = (amount_in as u128) * FEE_NUMERATOR / FEE_DENOMINATOR;
        let amount_out = (reserve_out * amount_in_after_fee)
            / (reserve_in + amount_in_after_fee);
        let amount_out: u64 = amount_out.try_into().map_err(|_| AmmError::MathOverflow)?;
        require!(amount_out >= min_amount_out, AmmError::SlippageExceeded);
        require!(amount_out > 0, AmmError::ZeroOutput);

        // In-leg: user -> vault. Hook sees sender = user, receiver = pool
        // authority (VENUE).
        transfer_with_hook(
            &ctx.accounts.token_program.key(),
            ctx.accounts.user_ata_in.to_account_info(),
            ctx.accounts.mint_in.to_account_info(),
            ctx.accounts.vault_in.to_account_info(),
            ctx.accounts.user.to_account_info(),
            ctx.remaining_accounts,
            amount_in,
            ctx.accounts.mint_in.decimals,
            &[],
        )?;

        // Out-leg: vault -> user, signed by the pool authority PDA. Hook sees
        // sender = pool authority (VENUE), receiver = user — an unattested
        // user fails HERE, inside Token-2022, not in any venue-specific code.
        let pool_key = pool.key();
        let signer_seeds: &[&[&[u8]]] =
            &[&[b"pool-authority", pool_key.as_ref(), &[pool.authority_bump]]];
        transfer_with_hook(
            &ctx.accounts.token_program.key(),
            ctx.accounts.vault_out.to_account_info(),
            ctx.accounts.mint_out.to_account_info(),
            ctx.accounts.user_ata_out.to_account_info(),
            ctx.accounts.pool_authority.to_account_info(),
            ctx.remaining_accounts,
            amount_out,
            ctx.accounts.mint_out.decimals,
            signer_seeds,
        )?;
        Ok(())
    }
}

/// The one-line venue integration: Token-2022's on-chain helper resolves the
/// hook's ExtraAccountMetaList from `additional_accounts` and forwards
/// everything the hook needs. Mints without a hook pass through unchanged.
#[allow(clippy::too_many_arguments)]
fn transfer_with_hook<'info>(
    token_program_id: &Pubkey,
    source: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    additional_accounts: &[AccountInfo<'info>],
    amount: u64,
    decimals: u8,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    spl_token_2022::onchain::invoke_transfer_checked(
        token_program_id,
        source,
        mint,
        destination,
        authority,
        additional_accounts,
        amount,
        decimals,
        seeds,
    )
    .map_err(Into::into)
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub vault_a: Pubkey,
    pub vault_b: Pubkey,
    pub bump: u8,
    pub authority_bump: u8,
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint_a: InterfaceAccount<'info, Mint>,
    pub mint_b: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool", mint_a.key().as_ref(), mint_b.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    /// CHECK: PDA that owns the vaults; receives a VENUE attestation
    #[account(seeds = [b"pool-authority", pool.key().as_ref()], bump)]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(token::mint = mint_a, token::authority = pool_authority)]
    pub vault_a: InterfaceAccount<'info, TokenAccount>,
    #[account(token::mint = mint_b, token::authority = pool_authority)]
    pub vault_b: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(has_one = vault_a, has_one = vault_b)]
    pub pool: Account<'info, Pool>,
    pub mint_a: InterfaceAccount<'info, Mint>,
    pub mint_b: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint_a)]
    pub user_ata_a: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint_b)]
    pub user_ata_b: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub vault_a: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub vault_b: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Token-2022 program
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    pub pool: Account<'info, Pool>,
    /// CHECK: PDA vault owner, validated by seeds
    #[account(seeds = [b"pool-authority", pool.key().as_ref()], bump = pool.authority_bump)]
    pub pool_authority: UncheckedAccount<'info>,
    pub mint_in: InterfaceAccount<'info, Mint>,
    pub mint_out: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint_in)]
    pub user_ata_in: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint_out)]
    pub user_ata_out: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint_in, token::authority = pool_authority)]
    pub vault_in: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint_out, token::authority = pool_authority)]
    pub vault_out: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Token-2022 program
    pub token_program: UncheckedAccount<'info>,
}

#[error_code]
pub enum AmmError {
    #[msg("Vault accounts do not match the pool")]
    InvalidVaults,
    #[msg("Pool has no liquidity")]
    EmptyPool,
    #[msg("Output below minimum")]
    SlippageExceeded,
    #[msg("Zero output amount")]
    ZeroOutput,
    #[msg("Math overflow")]
    MathOverflow,
}
