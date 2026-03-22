use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::DoubloonError;

pub fn check_mint_authorization(
    signer: &Pubkey,
    platform: &Platform,
    product: &Product,
    delegate: &Option<Account<MintDelegate>>,
    clock: &Clock,
) -> Result<u8> {
    // 1. Platform authority
    if signer == &platform.authority {
        return Ok(EntitlementSource::Platform as u8);
    }

    // 2. Product creator
    if signer == &product.creator {
        return Ok(EntitlementSource::Creator as u8);
    }

    // 3. Delegate
    if let Some(del) = delegate {
        if del.delegate == *signer && del.is_valid(clock.unix_timestamp) {
            return Ok(EntitlementSource::Delegate as u8);
        }
    }

    Err(DoubloonError::Unauthorized.into())
}

pub fn check_creator_or_platform(
    signer: &Pubkey,
    platform: &Platform,
    product: &Product,
) -> Result<()> {
    if signer == &platform.authority || signer == &product.creator {
        Ok(())
    } else {
        Err(DoubloonError::Unauthorized.into())
    }
}
