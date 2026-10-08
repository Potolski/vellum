pub mod confidential;
pub mod errors;
pub mod state;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::system_program::{create_account, CreateAccount};
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_token_2022::{
    extension::{transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions},
    state::Account as SplTokenAccount,
};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

// Glob, not named: `#[program]` resolves each context's generated
// `__client_accounts_*` module at the crate root, so those must come along too.
pub use confidential::*;
use errors::VellumError;
use state::{claims, flags, Attestation, Policy, Registry, POLICY_REGISTRY_OFFSET, TOKEN_ACCOUNT_OWNER_OFFSET};

declare_id!("7jhdAgapZXFyLW2ARyYsq2Ji5n3bG3EZSieSjMt37mdj");

#[program]
pub mod vellum {
    use super::*;

    /// Create an attestor registry. One registry per attestor authority.
    pub fn init_registry(ctx: Context<InitRegistry>, attestor: Pubkey) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.attestor = attestor;
        registry.bump = ctx.bumps.registry;
        Ok(())
    }

    /// Issue or update a wallet's attestation. Attestor-signed.
    pub fn attest(
        ctx: Context<Attest>,
        subject: Pubkey,
        claims: u32,
        jurisdiction: u16,
        expires_at: i64,
    ) -> Result<()> {
        let attestation = &mut ctx.accounts.attestation;
        attestation.registry = ctx.accounts.registry.key();
        attestation.subject = subject;
        attestation.claims = claims;
        attestation.jurisdiction = jurisdiction;
        attestation.expires_at = expires_at;
        attestation.bump = ctx.bumps.attestation;
        Ok(())
    }

    /// Revoke (close) a wallet's attestation. Attestor-signed.
    pub fn revoke(_ctx: Context<Revoke>, _subject: Pubkey) -> Result<()> {
        Ok(())
    }

    /// Onboard a mint: create its transfer Policy and the ExtraAccountMetaList
    /// that tells Token-2022 which accounts to pass to the hook on every transfer.
    pub fn init_policy(
        ctx: Context<InitPolicy>,
        policy_flags: u32,
        blocked_jurisdictions: [u16; 8],
    ) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        policy.mint = ctx.accounts.mint.key();
        policy.issuer = ctx.accounts.issuer.key();
        policy.registry = ctx.accounts.registry.key();
        policy.flags = policy_flags;
        policy.blocked_jurisdictions = blocked_jurisdictions;
        policy.paused = false;
        policy.bump = ctx.bumps.policy;

        // Extra accounts appended to every transfer, resolved automatically by
        // SPL helpers off-chain and on-chain. Transfer accounts are indices 0-4
        // (source, mint, destination, owner, meta list); extras start at 5.
        let extra_metas = vec![
            // 5: Policy PDA ["policy", mint]
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: b"policy".to_vec() },
                    Seed::AccountKey { index: 1 },
                ],
                false,
                false,
            )?,
            // 6: sender Attestation ["attest", policy.registry, source_token.owner]
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: b"attest".to_vec() },
                    Seed::AccountData {
                        account_index: 5,
                        data_index: POLICY_REGISTRY_OFFSET as u8,
                        length: 32,
                    },
                    Seed::AccountData {
                        account_index: 0,
                        data_index: TOKEN_ACCOUNT_OWNER_OFFSET as u8,
                        length: 32,
                    },
                ],
                false,
                false,
            )?,
            // 7: receiver Attestation ["attest", policy.registry, destination_token.owner]
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: b"attest".to_vec() },
                    Seed::AccountData {
                        account_index: 5,
                        data_index: POLICY_REGISTRY_OFFSET as u8,
                        length: 32,
                    },
                    Seed::AccountData {
                        account_index: 2,
                        data_index: TOKEN_ACCOUNT_OWNER_OFFSET as u8,
                        length: 32,
                    },
                ],
                false,
                false,
            )?,
        ];

        let account_size = ExtraAccountMetaList::size_of(extra_metas.len())? as u64;
        let lamports = Rent::get()?.minimum_balance(account_size as usize);
        let mint_key = ctx.accounts.mint.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"extra-account-metas",
            mint_key.as_ref(),
            &[ctx.bumps.extra_account_meta_list],
        ]];
        create_account(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.issuer.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
            )
            .with_signer(signer_seeds),
            lamports,
            account_size,
            ctx.program_id,
        )?;
        let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &extra_metas)?;
        Ok(())
    }

    /// Update a mint's policy. Issuer-signed.
    pub fn update_policy(
        ctx: Context<UpdatePolicy>,
        policy_flags: u32,
        blocked_jurisdictions: [u16; 8],
        paused: bool,
    ) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        policy.flags = policy_flags;
        policy.blocked_jurisdictions = blocked_jurisdictions;
        policy.paused = paused;
        Ok(())
    }

    // ---- Mode B: confidential mints, enforced per account ----------------

    /// Onboard a *confidential* mint. Creates the Policy only — a
    /// `ConfidentialTransfer` mint cannot carry a `TransferHook`, so there is no
    /// ExtraAccountMetaList and no per-transfer callback. Enforcement happens at
    /// the account level via the freeze gate (see `thaw_if_attested`).
    ///
    /// Requires the Policy PDA to already hold the mint's freeze authority:
    /// without it the gate would be decorative, so we refuse to create a policy
    /// that cannot actually bind.
    pub fn init_confidential_policy(
        ctx: Context<InitConfidentialPolicy>,
        policy_flags: u32,
        blocked_jurisdictions: [u16; 8],
    ) -> Result<()> {
        let (policy_key, policy_bump) = Pubkey::find_program_address(
            &[b"policy", ctx.accounts.mint.key().as_ref()],
            ctx.program_id,
        );
        match ctx.accounts.mint.freeze_authority {
            COption::Some(auth) => {
                require_keys_eq!(auth, policy_key, VellumError::PolicyNotFreezeAuthority)
            }
            COption::None => return err!(VellumError::PolicyNotFreezeAuthority),
        }

        let policy = &mut ctx.accounts.policy;
        policy.mint = ctx.accounts.mint.key();
        policy.issuer = ctx.accounts.issuer.key();
        policy.registry = ctx.accounts.registry.key();
        policy.flags = policy_flags | flags::CONFIDENTIAL;
        policy.blocked_jurisdictions = blocked_jurisdictions;
        policy.paused = false;
        policy.bump = policy_bump;
        Ok(())
    }

    /// Thaw a holder's token account iff its owner is currently eligible.
    /// Permissionless: the outcome is a pure function of registry state.
    pub fn thaw_if_attested(ctx: Context<GateAccount>) -> Result<()> {
        let policy = &ctx.accounts.policy;
        require!(!policy.paused, VellumError::TransfersPaused);

        let att = load_attestation(
            &ctx.accounts.attestation.to_account_info(),
            ctx.program_id,
            &policy.registry,
            &ctx.accounts.token_account.owner,
            Clock::get()?.unix_timestamp,
        )?;
        evaluate_holder(att.as_ref(), policy)?;
        ctx.accounts.thaw()
    }

    /// Approve a token account to hold an encrypted balance. Same eligibility
    /// check as `thaw_if_attested`; separate instruction because this needs the
    /// mint's confidential-transfer authority rather than its freeze authority.
    pub fn approve_confidential_account(ctx: Context<ApproveConfidential>) -> Result<()> {
        let policy = &ctx.accounts.policy;
        require!(!policy.paused, VellumError::TransfersPaused);

        let att = load_attestation(
            &ctx.accounts.attestation.to_account_info(),
            ctx.program_id,
            &policy.registry,
            &ctx.accounts.token_account.owner,
            Clock::get()?.unix_timestamp,
        )?;
        evaluate_holder(att.as_ref(), policy)?;
        ctx.accounts.approve()
    }

    /// Permissionless crank: re-freeze an account whose holder is no longer
    /// eligible (attestation expired, revoked, jurisdiction newly blocked, or
    /// the issuer paused the mint). Errors if the holder is still eligible, so
    /// it cannot be used to freeze a compliant position. The position is frozen,
    /// never seized — the holder's balance is untouched and thaws again the
    /// moment a fresh attestation is issued.
    pub fn refreeze_if_invalid(ctx: Context<GateAccount>) -> Result<()> {
        let policy = &ctx.accounts.policy;
        let att = load_attestation(
            &ctx.accounts.attestation.to_account_info(),
            ctx.program_id,
            &policy.registry,
            &ctx.accounts.token_account.owner,
            Clock::get()?.unix_timestamp,
        )?;
        if !policy.paused && evaluate_holder(att.as_ref(), policy).is_ok() {
            return err!(VellumError::HolderStillEligible);
        }
        ctx.accounts.freeze()
    }

    /// Invoked by Token-2022 on every transfer of a hooked mint.
    pub fn transfer_hook(ctx: Context<TransferHookCtx>, _amount: u64) -> Result<()> {
        let policy = &ctx.accounts.policy;
        require!(!policy.paused, VellumError::TransfersPaused);

        // Reject direct invocation outside a real transfer.
        assert_transferring(&ctx.accounts.source_token.to_account_info())?;
        assert_transferring(&ctx.accounts.destination_token.to_account_info())?;

        let now = Clock::get()?.unix_timestamp;
        let src_att = load_attestation(
            &ctx.accounts.source_attestation,
            ctx.program_id,
            &policy.registry,
            &ctx.accounts.source_token.owner,
            now,
        )?;
        let dst_att = load_attestation(
            &ctx.accounts.destination_attestation,
            ctx.program_id,
            &policy.registry,
            &ctx.accounts.destination_token.owner,
            now,
        )?;

        evaluate_party(src_att.as_ref(), policy, Party::Sender)?;
        evaluate_party(dst_att.as_ref(), policy, Party::Receiver)?;
        Ok(())
    }

    /// Token-2022 invokes the hook with the interface's own instruction
    /// discriminator; unpack it and dispatch to `transfer_hook`.
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data)?;
        match instruction {
            TransferHookInstruction::Execute { amount } => {
                let amount_bytes = amount.to_le_bytes();
                __private::__global::transfer_hook(program_id, accounts, &amount_bytes)
            }
            _ => Err(ProgramError::InvalidInstructionData.into()),
        }
    }
}

enum Party {
    Sender,
    Receiver,
}

/// Deserialize and validate an attestation account. Returns None when the
/// account doesn't exist (wallet never attested) or the attestation expired.
/// Registry/subject mismatches are hard errors: they can only happen if the
/// extra-account resolution was tampered with.
fn load_attestation(
    info: &AccountInfo,
    program_id: &Pubkey,
    expected_registry: &Pubkey,
    expected_subject: &Pubkey,
    now: i64,
) -> Result<Option<Attestation>> {
    if info.owner != program_id || info.data_is_empty() {
        return Ok(None);
    }
    let data = info.try_borrow_data()?;
    let attestation = Attestation::try_deserialize(&mut &data[..])?;
    require_keys_eq!(attestation.registry, *expected_registry, VellumError::WrongRegistry);
    require_keys_eq!(attestation.subject, *expected_subject, VellumError::WrongSubject);
    if attestation.expires_at != 0 && now > attestation.expires_at {
        msg!("vellum: attestation for {} expired", expected_subject);
        return Ok(None);
    }
    Ok(Some(attestation))
}

fn evaluate_party(att: Option<&Attestation>, policy: &Policy, party: Party) -> Result<()> {
    // Compliant venues (AMM pools, lending vaults) pass without KYC — this is
    // what keeps a permissioned token composable with DeFi.
    if policy.flags & flags::ALLOW_VENUES != 0 {
        if let Some(a) = att {
            if a.claims & claims::VENUE != 0 {
                return Ok(());
            }
        }
    }
    match party {
        Party::Sender => {
            if policy.flags & flags::REQUIRE_SENDER_KYC != 0 {
                let a = att.ok_or(error!(VellumError::SenderNotAttested))?;
                require!(a.claims & claims::KYC != 0, VellumError::SenderNotAttested);
            }
        }
        Party::Receiver => {
            if policy.flags & flags::REQUIRE_RECEIVER_KYC != 0 {
                let a = att.ok_or(error!(VellumError::ReceiverNotAttested))?;
                require!(a.claims & claims::KYC != 0, VellumError::ReceiverNotAttested);
            }
            if policy.flags & flags::REQUIRE_RECEIVER_ACCREDITED != 0 {
                let a = att.ok_or(error!(VellumError::ReceiverNotAttested))?;
                require!(
                    a.claims & claims::ACCREDITED != 0,
                    VellumError::AccreditationRequired
                );
            }
            if let Some(a) = att {
                if a.jurisdiction != 0
                    && policy.blocked_jurisdictions.contains(&a.jurisdiction)
                {
                    return err!(VellumError::JurisdictionBlocked);
                }
            }
        }
    }
    Ok(())
}

/// Account-level eligibility, for confidential mints.
///
/// One token account both sends and receives, and there is no per-transfer
/// callback to re-check at either moment — so to *hold* the asset a wallet must
/// satisfy the union of the policy's sender and receiver constraints. That is
/// strictly stricter than Mode A for any single transfer, which is the right
/// direction to err for a security.
fn evaluate_holder(att: Option<&Attestation>, policy: &Policy) -> Result<()> {
    // Compliant venues pass without KYC, same as Mode A.
    if policy.flags & flags::ALLOW_VENUES != 0 {
        if let Some(a) = att {
            if a.claims & claims::VENUE != 0 {
                return Ok(());
            }
        }
    }
    if policy.flags & (flags::REQUIRE_SENDER_KYC | flags::REQUIRE_RECEIVER_KYC) != 0 {
        let a = att.ok_or(error!(VellumError::HolderNotAttested))?;
        require!(a.claims & claims::KYC != 0, VellumError::HolderNotAttested);
    }
    if policy.flags & flags::REQUIRE_RECEIVER_ACCREDITED != 0 {
        let a = att.ok_or(error!(VellumError::HolderNotAttested))?;
        require!(
            a.claims & claims::ACCREDITED != 0,
            VellumError::AccreditationRequired
        );
    }
    if let Some(a) = att {
        if a.jurisdiction != 0 && policy.blocked_jurisdictions.contains(&a.jurisdiction) {
            return err!(VellumError::JurisdictionBlocked);
        }
    }
    Ok(())
}

/// Token-2022 sets a `transferring` flag on both token accounts for the
/// duration of a transfer; require it so the hook can't be invoked directly.
fn assert_transferring(token_account: &AccountInfo) -> Result<()> {
    let data = token_account.try_borrow_data()?;
    let state = StateWithExtensions::<SplTokenAccount>::unpack(&data)?;
    let ext = state
        .get_extension::<TransferHookAccount>()
        .map_err(|_| error!(VellumError::NotTransferring))?;
    require!(bool::from(ext.transferring), VellumError::NotTransferring);
    Ok(())
}

#[derive(Accounts)]
pub struct InitRegistry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Registry::INIT_SPACE,
        seeds = [b"registry", authority.key().as_ref()],
        bump
    )]
    pub registry: Account<'info, Registry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(subject: Pubkey)]
pub struct Attest<'info> {
    #[account(mut)]
    pub attestor: Signer<'info>,
    #[account(constraint = registry.attestor == attestor.key() @ VellumError::UnauthorizedAttestor)]
    pub registry: Account<'info, Registry>,
    #[account(
        init_if_needed,
        payer = attestor,
        space = 8 + Attestation::INIT_SPACE,
        seeds = [b"attest", registry.key().as_ref(), subject.as_ref()],
        bump
    )]
    pub attestation: Account<'info, Attestation>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(subject: Pubkey)]
pub struct Revoke<'info> {
    #[account(mut)]
    pub attestor: Signer<'info>,
    #[account(constraint = registry.attestor == attestor.key() @ VellumError::UnauthorizedAttestor)]
    pub registry: Account<'info, Registry>,
    #[account(
        mut,
        close = attestor,
        seeds = [b"attest", registry.key().as_ref(), subject.as_ref()],
        bump = attestation.bump
    )]
    pub attestation: Account<'info, Attestation>,
}

#[derive(Accounts)]
pub struct InitPolicy<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub registry: Account<'info, Registry>,
    #[account(
        init,
        payer = issuer,
        space = 8 + Policy::INIT_SPACE,
        seeds = [b"policy", mint.key().as_ref()],
        bump
    )]
    pub policy: Account<'info, Policy>,
    /// CHECK: created and initialized as an ExtraAccountMetaList in the handler
    #[account(mut, seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    pub issuer: Signer<'info>,
    #[account(mut, has_one = issuer @ VellumError::UnauthorizedIssuer)]
    pub policy: Account<'info, Policy>,
}

/// Account order is fixed by the transfer hook interface: the first five are
/// set by Token-2022, the rest must match the ExtraAccountMetaList.
#[derive(Accounts)]
pub struct TransferHookCtx<'info> {
    #[account(token::mint = mint)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: source token account authority (owner or delegate)
    pub owner: UncheckedAccount<'info>,
    /// CHECK: ExtraAccountMetaList PDA, validated by Token-2022
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(seeds = [b"policy", mint.key().as_ref()], bump = policy.bump)]
    pub policy: Account<'info, Policy>,
    /// CHECK: may not exist (unattested wallet); validated in the handler
    pub source_attestation: UncheckedAccount<'info>,
    /// CHECK: may not exist (unattested wallet); validated in the handler
    pub destination_attestation: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AnchorSerialize;

    /// The ExtraAccountMetaList derives attestation PDAs from the registry
    /// pubkey at POLICY_REGISTRY_OFFSET inside the Policy account. If the
    /// Policy field order changes, transfers break — pin it here.
    #[test]
    fn policy_registry_offset_is_stable() {
        let registry = Pubkey::new_unique();
        let policy = Policy {
            mint: Pubkey::new_unique(),
            issuer: Pubkey::new_unique(),
            registry,
            flags: 0,
            blocked_jurisdictions: [0; 8],
            paused: false,
            bump: 0,
        };
        let serialized = policy.try_to_vec().unwrap();
        // POLICY_REGISTRY_OFFSET includes the 8-byte account discriminator,
        // which try_to_vec does not emit.
        let offset = POLICY_REGISTRY_OFFSET as usize - 8;
        assert_eq!(&serialized[offset..offset + 32], registry.as_ref());
    }
}
