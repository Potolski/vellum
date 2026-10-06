use anchor_lang::prelude::*;

/// Claims bitmask values on an [`Attestation`].
pub mod claims {
    /// Wallet passed KYC with the registry's attestor.
    pub const KYC: u32 = 1 << 0;
    /// Wallet is a verified accredited investor.
    pub const ACCREDITED: u32 = 1 << 1;
    /// Wallet is a compliant venue authority (AMM pool, lending vault).
    pub const VENUE: u32 = 1 << 2;
}

/// Policy flags bitmask values on a [`Policy`].
pub mod flags {
    pub const REQUIRE_SENDER_KYC: u32 = 1 << 0;
    pub const REQUIRE_RECEIVER_KYC: u32 = 1 << 1;
    /// Wallets holding a VENUE claim pass without KYC/accreditation checks.
    pub const ALLOW_VENUES: u32 = 1 << 2;
    pub const REQUIRE_RECEIVER_ACCREDITED: u32 = 1 << 3;
    /// Set by `init_confidential_policy`. Marks a policy that is enforced at the
    /// *account* level (freeze gate) rather than per transfer, because the mint
    /// carries `ConfidentialTransfer` and so cannot carry a `TransferHook`.
    pub const CONFIDENTIAL: u32 = 1 << 4;
}

/// An attestor's namespace. One attestor (KYC provider, transfer agent)
/// controls one registry; policies choose which registry they trust.
#[account]
#[derive(InitSpace)]
pub struct Registry {
    /// Admin of the registry (can rotate the attestor key).
    pub authority: Pubkey,
    /// Key allowed to issue and revoke attestations.
    pub attestor: Pubkey,
    pub bump: u8,
}

/// A per-wallet compliance attestation within a registry.
/// PDA seeds: ["attest", registry, subject].
#[account]
#[derive(InitSpace)]
pub struct Attestation {
    pub registry: Pubkey,
    /// The wallet this attestation covers (a token account *owner*).
    pub subject: Pubkey,
    /// Bitmask of `claims::*`.
    pub claims: u32,
    /// ISO 3166-1 numeric country code (840 = US, 276 = DE, ...). 0 = unset.
    pub jurisdiction: u16,
    /// Unix timestamp after which the attestation is invalid. 0 = never expires.
    pub expires_at: i64,
    pub bump: u8,
}

/// Per-mint transfer policy. PDA seeds: ["policy", mint].
///
/// Field order matters: the ExtraAccountMetaList derives attestation PDAs
/// from `registry` at byte offset 8 (discriminator) + 32 (mint) + 32 (issuer) = 72.
#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub mint: Pubkey,
    /// Who can update the policy.
    pub issuer: Pubkey,
    /// Registry whose attestations this policy trusts. MUST stay at offset 72.
    pub registry: Pubkey,
    /// Bitmask of `flags::*`.
    pub flags: u32,
    /// Receiver-side jurisdiction blocklist (ISO 3166-1 numeric, 0 = empty slot).
    pub blocked_jurisdictions: [u16; 8],
    /// Emergency halt: all transfers rejected while true.
    pub paused: bool,
    pub bump: u8,
}

/// Byte offset of `Policy.registry`, used by the account-data seed in the
/// ExtraAccountMetaList. Compile-time checked in lib.rs.
pub const POLICY_REGISTRY_OFFSET: u32 = 8 + 32 + 32;

/// Byte offset of the `owner` field inside an SPL token account.
pub const TOKEN_ACCOUNT_OWNER_OFFSET: u32 = 32;
