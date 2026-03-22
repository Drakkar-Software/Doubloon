use anchor_lang::prelude::*;
use crate::state::{Platform, Product, MintDelegate};
use crate::auth::check_creator_or_platform;

#[derive(Accounts)]
pub struct RevokeDelegation<'info> {
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
        seeds = [MintDelegate::SEED, product.product_id.as_ref(), delegate.delegate.as_ref()],
        bump = delegate.bump,
    )]
    pub delegate: Account<'info, MintDelegate>,
}

pub fn handler(ctx: Context<RevokeDelegation>) -> Result<()> {
    check_creator_or_platform(ctx.accounts.signer.key, &ctx.accounts.platform, &ctx.accounts.product)?;
    ctx.accounts.delegate.active = false;
    Ok(())
}
