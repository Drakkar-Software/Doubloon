use anchor_lang::prelude::*;
use crate::state::{Platform, Product, Entitlement};
use crate::auth::check_creator_or_platform;

#[derive(Accounts)]
pub struct RevokeEntitlement<'info> {
    pub signer: Signer<'info>,

    #[account(seeds = [Platform::SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,

    #[account(
        seeds = [Product::SEED, product.product_id.as_ref()],
        bump = product.bump,
    )]
    pub product: Account<'info, Product>,

    #[account(
        mut,
        seeds = [Entitlement::SEED, product.product_id.as_ref(), entitlement.user.as_ref()],
        bump = entitlement.bump,
    )]
    pub entitlement: Account<'info, Entitlement>,
}

pub fn handler(ctx: Context<RevokeEntitlement>) -> Result<()> {
    // Only platform authority or product creator can revoke (NOT delegates)
    check_creator_or_platform(ctx.accounts.signer.key, &ctx.accounts.platform, &ctx.accounts.product)?;

    let clock = Clock::get()?;
    let entitlement = &mut ctx.accounts.entitlement;
    entitlement.active = false;
    entitlement.revoked_at = clock.unix_timestamp;
    entitlement.revoked_by = ctx.accounts.signer.key();

    Ok(())
}
