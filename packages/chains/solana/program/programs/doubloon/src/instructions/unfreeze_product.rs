use anchor_lang::prelude::*;
use crate::state::{Platform, Product};
use crate::errors::DoubloonError;

#[derive(Accounts)]
pub struct UnfreezeProduct<'info> {
    #[account(constraint = signer.key() == platform.authority @ DoubloonError::Unauthorized)]
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

pub fn handler(ctx: Context<UnfreezeProduct>) -> Result<()> {
    ctx.accounts.product.frozen = false;
    ctx.accounts.product.updated_at = Clock::get()?.unix_timestamp;
    Ok(())
}
