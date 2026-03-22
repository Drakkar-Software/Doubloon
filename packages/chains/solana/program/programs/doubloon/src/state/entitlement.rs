use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum EntitlementSource {
    Platform = 0,
    Creator = 1,
    Delegate = 2,
    Apple = 3,
    Google = 4,
    Stripe = 5,
    X402 = 6,
}

#[account]
pub struct Entitlement {
    pub product_id: [u8; 32],
    pub user: Pubkey,
    pub granted_at: i64,
    pub expires_at: i64,
    pub auto_renew: bool,
    pub source: u8,
    pub source_id: String,
    pub active: bool,
    pub revoked_at: i64,
    pub revoked_by: Pubkey,
    pub bump: u8,
}

impl Entitlement {
    pub const SEED: &'static [u8] = b"entitlement";
    pub const MAX_SOURCE_ID_LEN: usize = 128;
    pub const SIZE: usize = 8
        + 32
        + 32
        + 8 + 8
        + 1
        + 1
        + (4 + Self::MAX_SOURCE_ID_LEN)
        + 1
        + 8
        + 32
        + 1;

    pub fn is_valid(&self, now: i64) -> bool {
        self.active && (self.expires_at == 0 || self.expires_at > now)
    }
}
