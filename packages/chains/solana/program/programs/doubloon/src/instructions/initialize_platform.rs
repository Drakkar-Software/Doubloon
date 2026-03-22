use anchor_lang::prelude::*;
use crate::state::Platform;

#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Platform::SIZE,
        seeds = [Platform::SEED],
        bump,
    )]
    pub platform: Account<'info, Platform>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializePlatform>) -> Result<()> {
    let platform = &mut ctx.accounts.platform;
    platform.authority = ctx.accounts.authority.key();
    platform.product_count = 0;
    platform.frozen = false;
    platform.bump = ctx.bumps.platform;
    Ok(())
}
