use anchor_lang::prelude::*;
use crate::state::{Platform, Product};
use crate::auth::check_creator_or_platform;

#[derive(Accounts)]
pub struct ReactivateProduct<'info> {
    pub signer: Signer<'info>,

    #[account(seeds = [Platform::SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,

    #[account(
        mut,
        seeds = [Product::SEED, product.product_id.as_ref()],
        bump = product.bump,
    )]
    pub product: Account<'info, Product>,
}

pub fn handler(ctx: Context<ReactivateProduct>) -> Result<()> {
    check_creator_or_platform(ctx.accounts.signer.key, &ctx.accounts.platform, &ctx.accounts.product)?;
    ctx.accounts.product.active = true;
    ctx.accounts.product.updated_at = Clock::get()?.unix_timestamp;
    Ok(())
}
