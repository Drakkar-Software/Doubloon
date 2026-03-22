use anchor_lang::prelude::*;
use crate::state::{Platform, Product};
use crate::errors::DoubloonError;
use crate::auth::check_creator_or_platform;

#[derive(Accounts)]
pub struct UpdateProduct<'info> {
    pub signer: Signer<'info>,

    #[account(
        seeds = [Platform::SEED],
        bump = platform.bump,
    )]
    pub platform: Account<'info, Platform>,

    #[account(
        mut,
        seeds = [Product::SEED, product.product_id.as_ref()],
        bump = product.bump,
        constraint = !product.frozen @ DoubloonError::ProductFrozen,
    )]
    pub product: Account<'info, Product>,
}

pub fn handler(
    ctx: Context<UpdateProduct>,
    name: Option<String>,
    metadata_uri: Option<String>,
    default_duration: Option<i64>,
) -> Result<()> {
    check_creator_or_platform(
        ctx.accounts.signer.key,
        &ctx.accounts.platform,
        &ctx.accounts.product,
    )?;

    let product = &mut ctx.accounts.product;

    if let Some(n) = name {
        require!(n.len() <= Product::MAX_NAME_LEN, DoubloonError::NameTooLong);
        product.name = n;
    }
    if let Some(uri) = metadata_uri {
        require!(uri.len() <= Product::MAX_URI_LEN, DoubloonError::UriTooLong);
        product.metadata_uri = uri;
    }
    if let Some(dur) = default_duration {
        product.default_duration = dur;
    }

    product.updated_at = Clock::get()?.unix_timestamp;
    Ok(())
}
