use anchor_lang::prelude::*;

#[account]
pub struct Product {
    pub creator: Pubkey,
    pub product_id: [u8; 32],
    pub name: String,
    pub metadata_uri: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub active: bool,
    pub frozen: bool,
    pub entitlement_count: u64,
    pub delegate_count: u16,
    pub default_duration: i64,
    pub bump: u8,
}

impl Product {
    pub const SEED: &'static [u8] = b"product";
    pub const MAX_NAME_LEN: usize = 64;
    pub const MAX_URI_LEN: usize = 200;
    pub const SIZE: usize = 8
        + 32
        + 32
        + (4 + Self::MAX_NAME_LEN)
        + (4 + Self::MAX_URI_LEN)
        + 8 + 8
        + 1 + 1
        + 8
        + 2
        + 8
        + 1;
}
