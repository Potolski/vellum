//! Mode B: account-level enforcement for confidential mints.
//!
//! Token-2022 refuses to carry `ConfidentialTransfer` and `TransferHook` on the
//! same mint — hooks are handed the plaintext amount, which is exactly what
//! confidential transfers encrypt. Greenlight's policy never needed the amount
//! (it checks identity: KYC, accreditation, jurisdiction, expiry), so the
//! enforcement point moves from the *transfer* to the *account*:
//!
//!   - the mint carries `DefaultAccountState = Frozen`, so accounts are born unusable
//!   - the mint's freeze authority is the `Policy` PDA, so only this program can thaw
//!   - `thaw_if_attested` thaws an account only while its owner holds a valid attestation
//!   - `refreeze_if_invalid` is a permissionless crank that re-freezes once it doesn't
//!
//! This is the shape of sRFC-37 (Token ACL), the Foundation's permissioned-token
//! standard, which exists precisely because hooks aren't always available.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::errors::GreenlightError;
use crate::state::{flags, Policy};

/// Accounts for both gate cranks. Nothing here is issuer-signed: eligibility is
/// read from the registry, so anyone may push an account to its correct state.
#[derive(Accounts)]
pub struct GateAccount<'info> {
    /// Anyone. The gate's outcome is a pure function of on-chain attestation
    /// state, so the caller's identity cannot influence it.
    pub cranker: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, token::mint = mint)]
    pub token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        seeds = [b"policy", mint.key().as_ref()],
        bump = policy.bump,
        constraint = policy.flags & flags::CONFIDENTIAL != 0 @ GreenlightError::NotConfidentialPolicy,
    )]
    pub policy: Account<'info, Policy>,

    /// CHECK: may legitimately not exist (never attested, or revoked). Pinned to
    /// its canonical PDA by the seeds below — without that, a caller could pass
    /// an unrelated empty account to make a valid holder look unattested and
    /// grief-freeze them via `refreeze_if_invalid`.
    #[account(
        seeds = [b"attest", policy.registry.as_ref(), token_account.owner.as_ref()],
        bump,
    )]
    pub attestation: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> GateAccount<'info> {
    /// Signer seeds for the `Policy` PDA, which holds the mint's freeze authority.
    fn policy_seeds(&self) -> [Vec<u8>; 3] {
        [
            b"policy".to_vec(),
            self.mint.key().to_bytes().to_vec(),
            vec![self.policy.bump],
        ]
    }

    fn invoke_as_policy(&self, ix: anchor_lang::solana_program::instruction::Instruction) -> Result<()> {
        let seeds = self.policy_seeds();
        let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
        invoke_signed(
            &ix,
            &[
                self.token_account.to_account_info(),
                self.mint.to_account_info(),
                self.policy.to_account_info(),
                self.token_program.to_account_info(),
            ],
            &[&seed_refs],
        )
        .map_err(Into::into)
    }

    pub fn thaw(&self) -> Result<()> {
        let ix = spl_token_2022::instruction::thaw_account(
            &self.token_program.key(),
            &self.token_account.key(),
            &self.mint.key(),
            &self.policy.key(),
            &[],
        )?;
        self.invoke_as_policy(ix)
    }

    pub fn freeze(&self) -> Result<()> {
        let ix = spl_token_2022::instruction::freeze_account(
            &self.token_program.key(),
            &self.token_account.key(),
            &self.mint.key(),
            &self.policy.key(),
            &[],
        )?;
        self.invoke_as_policy(ix)
    }
}

/// Accounts for approving a token account to hold an encrypted balance.
///
/// Kept separate from `thaw_if_attested` on purpose: approval needs the mint's
/// *confidential transfer* authority, which is a different authority from the
/// freeze authority. Coupling them would make thawing fail whenever an issuer
/// delegated only one of the two. The SDK sends both in one transaction, so the
/// holder still sees a single onboarding step.
#[derive(Accounts)]
pub struct ApproveConfidential<'info> {
    pub cranker: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, token::mint = mint)]
    pub token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        seeds = [b"policy", mint.key().as_ref()],
        bump = policy.bump,
        constraint = policy.flags & flags::CONFIDENTIAL != 0 @ GreenlightError::NotConfidentialPolicy,
    )]
    pub policy: Account<'info, Policy>,

    /// CHECK: see `GateAccount::attestation` — pinned to its canonical PDA.
    #[account(
        seeds = [b"attest", policy.registry.as_ref(), token_account.owner.as_ref()],
        bump,
    )]
    pub attestation: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> ApproveConfidential<'info> {
    pub fn approve(&self) -> Result<()> {
        let ix = spl_token_2022::extension::confidential_transfer::instruction::approve_account(
            &self.token_program.key(),
            &self.token_account.key(),
            &self.mint.key(),
            &self.policy.key(),
            &[],
        )?;
        let mint_key = self.mint.key();
        let seeds: &[&[u8]] = &[b"policy", mint_key.as_ref(), &[self.policy.bump]];
        invoke_signed(
            &ix,
            &[
                self.token_account.to_account_info(),
                self.mint.to_account_info(),
                self.policy.to_account_info(),
                self.token_program.to_account_info(),
            ],
            &[seeds],
        )
        .map_err(Into::into)
    }
}

/// Accounts for onboarding a confidential mint. No `ExtraAccountMetaList`: a
/// `ConfidentialTransfer` mint cannot carry a hook, which is the whole point.
#[derive(Accounts)]
pub struct InitConfidentialPolicy<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub registry: Account<'info, crate::state::Registry>,
    #[account(
        init,
        payer = issuer,
        space = 8 + Policy::INIT_SPACE,
        seeds = [b"policy", mint.key().as_ref()],
        bump
    )]
    pub policy: Account<'info, Policy>,
    pub system_program: Program<'info, System>,
}
