use crate::*;

pub const PAYOUT_PENDING: u8 = 0;
pub const PAYOUT_PAID: u8 = 1;
/// The vault refused the payout for good; the Gemas are returned by `refund_prize_payout`.
pub const PAYOUT_REJECTED: u8 = 2;
pub const PAYOUT_REFUNDED: u8 = 3;

/// A holder's prize Redeem on an EVM route (`["payout", eid, vault, id]`): the Gemas are burned on
/// Solana and the shares wait, reserved, until the vault answers. The `PayPrize` message binds the
/// chain, vault, asset, prize Source, recipient, share quantity and this id; the vault keeps one
/// receipt per id, so sending it again can only pay it once.
#[account]
#[derive(InitSpace)]
pub struct PayoutRecord {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub id: u64,
    pub bump: u8,
    pub state: u8,
    /// The holder's Tesoro Account (gets the Gemas back on a rejection).
    pub holder_account: Pubkey,
    pub recipient: [u8; 20],
    pub prize_source: Pubkey,
    pub asset: [u8; 32],
    pub gemas: u64,
    pub shares: u128,
    pub sends: u32,
}

impl PayoutRecord {
    /// Applies the vault's answer. Returns whether the state changed; a repeat, or an answer after
    /// a different one, changes nothing.
    pub fn apply_result(&mut self, status: u8, shares: u128) -> Result<bool> {
        if self.state != PAYOUT_PENDING {
            return Ok(false);
        }
        match status {
            crate::msg_codec::PRIZE_PAID => {
                require!(shares == self.shares, BridgeError::PayoutMismatch);
                self.state = PAYOUT_PAID;
            },
            crate::msg_codec::PRIZE_REJECTED => self.state = PAYOUT_REJECTED,
            _ => return err!(BridgeError::InvalidMessageType),
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::msg_codec::{PRIZE_PAID, PRIZE_REJECTED};

    fn payout() -> PayoutRecord {
        PayoutRecord {
            eid: 1,
            peer_address: [0; 32],
            id: 1,
            bump: 0,
            state: PAYOUT_PENDING,
            holder_account: Pubkey::new_unique(),
            recipient: [1; 20],
            prize_source: Pubkey::new_unique(),
            asset: [2; 32],
            gemas: 10,
            shares: 99,
            sends: 0,
        }
    }

    #[test]
    fn the_first_answer_wins_and_repeats_change_nothing() {
        let mut p = payout();
        assert!(p.apply_result(PRIZE_PAID, 99).unwrap());
        assert!(!p.apply_result(PRIZE_PAID, 99).unwrap(), "duplicate");
        assert!(!p.apply_result(PRIZE_REJECTED, 0).unwrap(), "a contradicting late answer");
        assert_eq!(p.state, PAYOUT_PAID);
    }

    #[test]
    fn a_payment_of_another_quantity_is_refused() {
        let mut p = payout();
        assert!(p.apply_result(PRIZE_PAID, 98).is_err());
        assert_eq!(p.state, PAYOUT_PENDING);
    }

    #[test]
    fn a_rejection_is_final_until_refunded() {
        let mut p = payout();
        assert!(p.apply_result(PRIZE_REJECTED, 0).unwrap());
        assert!(!p.apply_result(PRIZE_PAID, 99).unwrap());
        assert_eq!(p.state, PAYOUT_REJECTED);
    }
}
