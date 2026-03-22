use anchor_lang::prelude::*;
use crate::state::{Platform, Product, MintDelegate};
use crate::errors::DoubloonError;
use crate::auth::check_creator_or_platform;

#[derive(Accounts)]
pub struct GrantDelegation<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(seeds = [Platform::SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,

    #[account(
        mut,
        seeds = [Product::SEED, product.product_id.as_ref()],
        bump = product.bump,
        constraint = !product.frozen @ DoubloonError::ProductFrozen,
        constraint = product.active @ DoubloonError::ProductNotActive,
    )]
    pub product: Account<'info, Product>,

    /// CHECK: The delegate wallet. Any pubkey is valid.
    pub delegate_wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = signer,
        space = MintDelegate::SIZE,
        seeds = [MintDelegate::SEED, product.product_id.as_ref(), delegate_wallet.key().as_ref()],
        bump,
    )]
    pub delegate: Account<'info, MintDelegate>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<GrantDelegation>,
    expires_at: i64,
    max_mints: u64,
) -> Result<()> {
    check_creator_or_platform(ctx.accounts.signer.key, &ctx.accounts.platform, &ctx.accounts.product)?;

    require!(
        ctx.accounts.delegate_wallet.key() != ctx.accounts.product.creator,
        DoubloonError::CannotDelegateToCreator
    );

    let clock = Clock::get()?;
    let delegate = &mut ctx.accounts.delegate;
    delegate.product_id = ctx.accounts.product.product_id;
    delegate.delegate = ctx.accounts.delegate_wallet.key();
    delegate.granted_by = ctx.accounts.signer.key();
    delegate.granted_at = clock.unix_timestamp;
    delegate.expires_at = expires_at;
    delegate.max_mints = max_mints;
    delegate.mints_used = 0;
    delegate.active = true;
    delegate.bump = ctx.bumps.delegate;

    ctx.accounts.product.delegate_count = ctx.accounts.product.delegate_count.checked_add(1).unwrap();

    Ok(())
}
