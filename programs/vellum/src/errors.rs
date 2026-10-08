use anchor_lang::prelude::*;

#[error_code]
pub enum VellumError {
    #[msg("Transfers of this token are paused by the issuer")]
    TransfersPaused,
    #[msg("Sender wallet has no valid attestation for this token's registry")]
    SenderNotAttested,
    #[msg("Receiver wallet has no valid attestation for this token's registry")]
    ReceiverNotAttested,
    #[msg("Attestation has expired")]
    AttestationExpired,
    #[msg("Receiver jurisdiction is blocked by the token's policy")]
    JurisdictionBlocked,
    #[msg("Receiver must hold an ACCREDITED claim")]
    AccreditationRequired,
    #[msg("Attestation does not belong to the policy's registry")]
    WrongRegistry,
    #[msg("Attestation subject does not match the token account owner")]
    WrongSubject,
    #[msg("Hook invoked outside of an active Token-2022 transfer")]
    NotTransferring,
    #[msg("Signer is not the registry's attestor")]
    UnauthorizedAttestor,
    #[msg("Signer is not the policy's issuer")]
    UnauthorizedIssuer,
    #[msg("Holder wallet has no valid attestation for this token's registry")]
    HolderNotAttested,
    #[msg("Holder is still eligible; nothing to re-freeze")]
    HolderStillEligible,
    #[msg("Policy does not govern a confidential mint")]
    NotConfidentialPolicy,
    #[msg("Policy PDA must hold the mint's freeze authority for the gate to bind")]
    PolicyNotFreezeAuthority,
}
