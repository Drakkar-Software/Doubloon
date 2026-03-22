use anchor_lang::prelude::*;
use crate::state::{Platform, Entitlement};
use crate::errors::DoubloonError;

#[derive(Accounts)]
pub struct CloseEntitlement<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(seeds = [Platform::SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,

    #[account(
        mut,
        close = signer,
        seeds = [Entitlement::SEED, entitlement.product_id.as_ref(), entitlement.user.as_ref()],
        bump = entitlement.bump,
        constraint = !entitlement.active || (entitlement.expires_at != 0 && entitlement.expires_at <= Clock::get()?.unix_timestamp)
            @ DoubloonError::EntitlementNotActive,
        constraint = signer.key() == platform.authority || signer.key() == entitlement.user
            @ DoubloonError::Unauthorized,
    )]
    pub entitlement: Account<'info, Entitlement>,
}

pub fn handler(_ctx: Context<CloseEntitlement>) -> Result<()> {
    // Account is closed by the `close = signer` constraint. Rent returned to signer.
    Ok(())
}
