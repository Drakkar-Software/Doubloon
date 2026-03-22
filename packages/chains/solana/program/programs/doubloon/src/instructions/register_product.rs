use anchor_lang::prelude::*;
use crate::state::{Platform, Product};
use crate::errors::DoubloonError;

#[derive(Accounts)]
#[instruction(product_id: [u8; 32])]
pub struct RegisterProduct<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [Platform::SEED],
        bump = platform.bump,
        constraint = !platform.frozen @ DoubloonError::PlatformFrozen,
    )]
    pub platform: Account<'info, Platform>,

    #[account(
        init,
        payer = creator,
        space = Product::SIZE,
        seeds = [Product::SEED, product_id.as_ref()],
        bump,
    )]
    pub product: Account<'info, Product>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterProduct>,
    product_id: [u8; 32],
    name: String,
    metadata_uri: String,
    default_duration: i64,
) -> Result<()> {
    require!(name.len() <= Product::MAX_NAME_LEN, DoubloonError::NameTooLong);
    require!(metadata_uri.len() <= Product::MAX_URI_LEN, DoubloonError::UriTooLong);

    let clock = Clock::get()?;
    let product = &mut ctx.accounts.product;
    product.creator = ctx.accounts.creator.key();
    product.product_id = product_id;
    product.name = name;
    product.metadata_uri = metadata_uri;
    product.created_at = clock.unix_timestamp;
    product.updated_at = clock.unix_timestamp;
    product.active = true;
    product.frozen = false;
    product.entitlement_count = 0;
    product.delegate_count = 0;
    product.default_duration = default_duration;
    product.bump = ctx.bumps.product;

    let platform = &mut ctx.accounts.platform;
    platform.product_count = platform.product_count.checked_add(1).unwrap();

    Ok(())
}
