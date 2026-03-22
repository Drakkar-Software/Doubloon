use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct Platform {
    pub authority: Pubkey,
    pub product_count: u64,
    pub frozen: bool,
    pub bump: u8,
}

impl Platform {
    pub const SEED: &'static [u8] = b"platform";
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 1;
}
