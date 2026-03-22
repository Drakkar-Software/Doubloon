use anchor_lang::prelude::*;

#[error_code]
pub enum DoubloonError {
    #[msg("Signer is not authorized for this operation")]
    Unauthorized,

    #[msg("Product is not active")]
    ProductNotActive,

    #[msg("Product is frozen by platform")]
    ProductFrozen,

    #[msg("Platform is frozen")]
    PlatformFrozen,

    #[msg("Delegate is not valid (expired, exhausted, or revoked)")]
    DelegateInvalid,

    #[msg("Product name exceeds maximum length")]
    NameTooLong,

    #[msg("Metadata URI exceeds maximum length")]
    UriTooLong,

    #[msg("Source ID exceeds maximum length")]
    SourceIdTooLong,

    #[msg("Cannot shorten entitlement expiry")]
    CannotShortenExpiry,

    #[msg("Cannot delegate to the product creator")]
    CannotDelegateToCreator,

    #[msg("Entitlement is not active (cannot extend a revoked entitlement; mint instead)")]
    EntitlementNotActive,
}
