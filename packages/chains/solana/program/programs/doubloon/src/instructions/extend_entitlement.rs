use anchor_lang::prelude::*;
use crate::state::{Platform, Product, MintDelegate, Entitlement};
use crate::errors::DoubloonError;
use crate::auth::check_mint_authorization;

#[derive(Accounts)]
#[instruction(new_expires_at: i64, source: u8, source_id: String)]
pub struct ExtendEntitlement<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [Platform::SEED],
        bump = platform.bump,
        constraint = !platform.frozen @ DoubloonError::PlatformFrozen,
    )]
    pub platform: Account<'info, Platform>,

    #[account(
        seeds = [Product::SEED, product.product_id.as_ref()],
        bump = product.bump,
        constraint = product.active @ DoubloonError::ProductNotActive,
        constraint = !product.frozen @ DoubloonError::ProductFrozen,
    )]
    pub product: Account<'info, Product>,

    #[account(
        mut,
        seeds = [Entitlement::SEED, product.product_id.as_ref(), entitlement.user.as_ref()],
        bump = entitlement.bump,
        constraint = entitlement.active @ DoubloonError::EntitlementNotActive,
    )]
    pub entitlement: Account<'info, Entitlement>,

    #[account(
        mut,
        seeds = [MintDelegate::SEED, product.product_id.as_ref(), signer.key().as_ref()],
        bump = delegate.bump,
    )]
    pub delegate: Option<Account<'info, MintDelegate>>,
}

pub fn handler(
    ctx: Context<ExtendEntitlement>,
    new_expires_at: i64,
    source: u8,
    source_id: String,
) -> Result<()> {
    require!(source_id.len() <= Entitlement::MAX_SOURCE_ID_LEN, DoubloonError::SourceIdTooLong);

    let clock = Clock::get()?;
    check_mint_authorization(
        ctx.accounts.signer.key,
        &ctx.accounts.platform,
        &ctx.accounts.product,
        &ctx.accounts.delegate,
        &clock,
    )?;

    let entitlement = &mut ctx.accounts.entitlement;

    // Cannot shorten expiry (unless going to lifetime)
    if new_expires_at != 0 && entitlement.expires_at != 0 && new_expires_at < entitlement.expires_at {
        return Err(DoubloonError::CannotShortenExpiry.into());
    }

    // Lifetime always wins; otherwise take the later date
    if new_expires_at == 0 {
        entitlement.expires_at = 0;
    } else if entitlement.expires_at == 0 {
        // Already lifetime, don't change
    } else {
        entitlement.expires_at = std::cmp::max(entitlement.expires_at, new_expires_at);
    }

    entitlement.source = source;
    entitlement.source_id = source_id;

    Ok(())
}
