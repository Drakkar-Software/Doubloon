use anchor_lang::prelude::*;
use crate::state::{Platform, Product, MintDelegate, Entitlement};
use crate::errors::DoubloonError;
use crate::auth::check_mint_authorization;

#[derive(Accounts)]
#[instruction(expires_at: i64, source: u8, source_id: String, auto_renew: bool)]
pub struct MintEntitlement<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [Platform::SEED],
        bump = platform.bump,
        constraint = !platform.frozen @ DoubloonError::PlatformFrozen,
    )]
    pub platform: Account<'info, Platform>,

    #[account(
        mut,
        seeds = [Product::SEED, product.product_id.as_ref()],
        bump = product.bump,
        constraint = product.active @ DoubloonError::ProductNotActive,
        constraint = !product.frozen @ DoubloonError::ProductFrozen,
    )]
    pub product: Account<'info, Product>,

    #[account(
        init_if_needed,
        payer = signer,
        space = Entitlement::SIZE,
        seeds = [Entitlement::SEED, product.product_id.as_ref(), user.key().as_ref()],
        bump,
    )]
    pub entitlement: Account<'info, Entitlement>,

    /// CHECK: The user's wallet address. Any pubkey is valid.
    pub user: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [MintDelegate::SEED, product.product_id.as_ref(), signer.key().as_ref()],
        bump = delegate.bump,
    )]
    pub delegate: Option<Account<'info, MintDelegate>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<MintEntitlement>,
    expires_at: i64,
    source: u8,
    source_id: String,
    auto_renew: bool,
) -> Result<()> {
    require!(source_id.len() <= Entitlement::MAX_SOURCE_ID_LEN, DoubloonError::SourceIdTooLong);

    let clock = Clock::get()?;

    // Authorization check
    let _auth_source = check_mint_authorization(
        ctx.accounts.signer.key,
        &ctx.accounts.platform,
        &ctx.accounts.product,
        &ctx.accounts.delegate,
        &clock,
    )?;

    // Increment delegate mints_used if applicable
    if let Some(delegate) = &mut ctx.accounts.delegate {
        if delegate.delegate == *ctx.accounts.signer.key {
            delegate.mints_used = delegate.mints_used.checked_add(1).unwrap();
        }
    }

    let entitlement = &mut ctx.accounts.entitlement;

    if entitlement.granted_at == 0 {
        // Case 1: New entitlement (PDA just created by init_if_needed)
        entitlement.product_id = ctx.accounts.product.product_id;
        entitlement.user = ctx.accounts.user.key();
        entitlement.granted_at = clock.unix_timestamp;
        entitlement.expires_at = expires_at;
        entitlement.auto_renew = auto_renew;
        entitlement.source = source;
        entitlement.source_id = source_id;
        entitlement.active = true;
        entitlement.revoked_at = 0;
        entitlement.revoked_by = Pubkey::default();
        entitlement.bump = ctx.bumps.entitlement;

        ctx.accounts.product.entitlement_count = ctx.accounts.product.entitlement_count.checked_add(1).unwrap();
    } else if entitlement.active {
        // Case 2: Existing active entitlement — extend expires_at (take the later date)
        if expires_at == 0 || (entitlement.expires_at != 0 && expires_at > entitlement.expires_at) {
            entitlement.expires_at = expires_at;
        }
        // If new is 0 (lifetime), it always wins
        if expires_at == 0 {
            entitlement.expires_at = 0;
        }
        entitlement.auto_renew = auto_renew;
        entitlement.source = source;
        entitlement.source_id = source_id;
    } else {
        // Case 3: Revoked entitlement — reactivate
        entitlement.active = true;
        entitlement.expires_at = expires_at;
        entitlement.auto_renew = auto_renew;
        entitlement.source = source;
        entitlement.source_id = source_id;
        entitlement.revoked_at = 0;
        entitlement.revoked_by = Pubkey::default();
    }

    Ok(())
}
