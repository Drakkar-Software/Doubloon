use anchor_lang::prelude::*;

pub mod state;
pub mod errors;
pub mod auth;
pub mod instructions;

use instructions::*;

declare_id!("Dub1oon11111111111111111111111111111111111");

#[program]
pub mod doubloon {
    use super::*;

    pub fn initialize_platform(ctx: Context<InitializePlatform>) -> Result<()> {
        instructions::initialize_platform::handler(ctx)
    }

    pub fn transfer_platform_authority(
        ctx: Context<TransferPlatformAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::transfer_platform_authority::handler(ctx, new_authority)
    }

    pub fn register_product(
        ctx: Context<RegisterProduct>,
        product_id: [u8; 32],
        name: String,
        metadata_uri: String,
        default_duration: i64,
    ) -> Result<()> {
        instructions::register_product::handler(ctx, product_id, name, metadata_uri, default_duration)
    }

    pub fn update_product(
        ctx: Context<UpdateProduct>,
        name: Option<String>,
        metadata_uri: Option<String>,
        default_duration: Option<i64>,
    ) -> Result<()> {
        instructions::update_product::handler(ctx, name, metadata_uri, default_duration)
    }

    pub fn deactivate_product(ctx: Context<DeactivateProduct>) -> Result<()> {
        instructions::deactivate_product::handler(ctx)
    }

    pub fn reactivate_product(ctx: Context<ReactivateProduct>) -> Result<()> {
        instructions::reactivate_product::handler(ctx)
    }

    pub fn freeze_product(ctx: Context<FreezeProduct>) -> Result<()> {
        instructions::freeze_product::handler(ctx)
    }

    pub fn unfreeze_product(ctx: Context<UnfreezeProduct>) -> Result<()> {
        instructions::unfreeze_product::handler(ctx)
    }

    pub fn grant_delegation(
        ctx: Context<GrantDelegation>,
        expires_at: i64,
        max_mints: u64,
    ) -> Result<()> {
        instructions::grant_delegation::handler(ctx, expires_at, max_mints)
    }

    pub fn revoke_delegation(ctx: Context<RevokeDelegation>) -> Result<()> {
        instructions::revoke_delegation::handler(ctx)
    }

    pub fn mint_entitlement(
        ctx: Context<MintEntitlement>,
        expires_at: i64,
        source: u8,
        source_id: String,
        auto_renew: bool,
    ) -> Result<()> {
        instructions::mint_entitlement::handler(ctx, expires_at, source, source_id, auto_renew)
    }

    pub fn extend_entitlement(
        ctx: Context<ExtendEntitlement>,
        new_expires_at: i64,
        source: u8,
        source_id: String,
    ) -> Result<()> {
        instructions::extend_entitlement::handler(ctx, new_expires_at, source, source_id)
    }

    pub fn revoke_entitlement(ctx: Context<RevokeEntitlement>) -> Result<()> {
        instructions::revoke_entitlement::handler(ctx)
    }

    pub fn close_entitlement(ctx: Context<CloseEntitlement>) -> Result<()> {
        instructions::close_entitlement::handler(ctx)
    }
}
