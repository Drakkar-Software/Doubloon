use anchor_lang::prelude::*;

#[account]
pub struct MintDelegate {
    pub product_id: [u8; 32],
    pub delegate: Pubkey,
    pub granted_by: Pubkey,
    pub granted_at: i64,
    pub expires_at: i64,
    pub max_mints: u64,
    pub mints_used: u64,
    pub active: bool,
    pub bump: u8,
}

impl MintDelegate {
    pub const SEED: &'static [u8] = b"delegate";
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1;

    pub fn is_valid(&self, now: i64) -> bool {
        self.active
            && (self.expires_at == 0 || self.expires_at > now)
            && (self.max_mints == 0 || self.mints_used < self.max_mints)
    }
}
