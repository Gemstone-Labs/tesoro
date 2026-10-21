use crate::*;

/// Solana's mirror of one vault's prize escrow and the counters that give its batches and
/// payouts route-scoped ids (`["route", eid, vault]`).
///
/// The escrow's figures only ever come from the vault: `escrow_shares` / `escrow_units` are the
/// vault's cumulative inflow into its prize escrow (shares, and the Source asset's units each
/// share was worth when it arrived), taken from Yield Reports and batch acknowledgements. Prize
/// Gemas are issued only for confirmed inflow that has none yet, so they never exceed what the
/// vault holds for them:
///
/// ```text
/// issued_shares <= escrow_shares
/// issued_shares == outstanding prize-Source shares + pending_payout_shares + paid_payout_shares
/// ```
#[account]
#[derive(InitSpace)]
pub struct VaultRoute {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub bump: u8,
    /// The vault's Source asset as core knows it (`source_asset` of its Positions); keys the price.
    pub asset: [u8; 32],
    /// Off until the treasury slashing fix is accepted (spec): no Leaderboard batch, no issuance.
    pub escrow_enabled: bool,
    /// Smallest total a batch needs to be sealed, in the Source asset's units (0 = no minimum).
    pub min_batch_units: u64,
    /// The last batch id handed out (ids start at 1).
    pub last_batch_id: u64,
    /// The last payout id handed out (ids start at 1).
    pub last_payout_id: u64,
    pub escrow_shares: u128,
    pub escrow_units: u128,
    pub issued_shares: u128,
    pub issued_units: u128,
    /// Last Season whose prize was issued on this route (0 = none). Strictly increasing.
    pub last_funded_season: u32,
    /// Shares of payouts that were burned on Solana and wait for the vault's acknowledgement.
    pub pending_payout_shares: u128,
    pub paid_payout_shares: u128,
}

impl VaultRoute {
    /// Takes the vault's escrow figures when they are newer than the ones held. Both counters only
    /// grow, so a larger `shares` is the later snapshot and carries the matching `units`; an older
    /// or repeated one changes nothing.
    pub fn note_escrow(&mut self, shares: u128, units: u128) {
        if shares > self.escrow_shares {
            self.escrow_shares = shares;
            self.escrow_units = units.max(self.escrow_units);
        }
    }

    /// Confirmed escrow inflow that no prize Source covers yet: `(shares, units)`.
    pub fn unissued(&self) -> (u128, u128) {
        (
            self.escrow_shares.saturating_sub(self.issued_shares),
            self.escrow_units.saturating_sub(self.issued_units),
        )
    }

    pub fn issue(&mut self, season: u32, shares: u128, units: u128) -> Result<()> {
        require!(season > self.last_funded_season, BridgeError::SeasonAlreadyFunded);
        let (open_shares, open_units) = self.unissued();
        require!(shares > 0 && shares <= open_shares, BridgeError::NothingToIssue);
        require!(units <= open_units, BridgeError::NothingToIssue);
        self.issued_shares =
            self.issued_shares.checked_add(shares).ok_or(BridgeError::AmountOverflow)?;
        self.issued_units =
            self.issued_units.checked_add(units).ok_or(BridgeError::AmountOverflow)?;
        self.last_funded_season = season;
        Ok(())
    }

    pub fn begin_payout(&mut self, shares: u128) -> Result<()> {
        self.pending_payout_shares = self
            .pending_payout_shares
            .checked_add(shares)
            .ok_or(BridgeError::AmountOverflow)?;
        Ok(())
    }

    /// The vault paid: the shares leave the escrow.
    pub fn finish_payout(&mut self, shares: u128) -> Result<()> {
        self.pending_payout_shares = self
            .pending_payout_shares
            .checked_sub(shares)
            .ok_or(BridgeError::AmountOverflow)?;
        self.paid_payout_shares =
            self.paid_payout_shares.checked_add(shares).ok_or(BridgeError::AmountOverflow)?;
        Ok(())
    }

    /// The vault rejected the payout for good: the shares are the prize Source's again.
    pub fn cancel_payout(&mut self, shares: u128) -> Result<()> {
        self.pending_payout_shares = self
            .pending_payout_shares
            .checked_sub(shares)
            .ok_or(BridgeError::AmountOverflow)?;
        Ok(())
    }

    pub fn next_batch_id(&mut self) -> Result<u64> {
        self.last_batch_id = self.last_batch_id.checked_add(1).ok_or(BridgeError::SeqOverflow)?;
        Ok(self.last_batch_id)
    }

    pub fn next_payout_id(&mut self) -> Result<u64> {
        self.last_payout_id = self.last_payout_id.checked_add(1).ok_or(BridgeError::SeqOverflow)?;
        Ok(self.last_payout_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route() -> VaultRoute {
        VaultRoute {
            eid: 1,
            peer_address: [0; 32],
            bump: 0,
            asset: [0; 32],
            escrow_enabled: true,
            min_batch_units: 0,
            last_batch_id: 0,
            last_payout_id: 0,
            escrow_shares: 0,
            escrow_units: 0,
            issued_shares: 0,
            issued_units: 0,
            last_funded_season: 0,
            pending_payout_shares: 0,
            paid_payout_shares: 0,
        }
    }

    #[test]
    fn escrow_snapshots_only_move_forward_and_stay_a_pair() {
        let mut r = route();
        r.note_escrow(100, 120);
        r.note_escrow(60, 70); // an older acknowledgement arriving late
        r.note_escrow(100, 120); // a repeat
        assert_eq!((r.escrow_shares, r.escrow_units), (100, 120));
        r.note_escrow(150, 200);
        assert_eq!((r.escrow_shares, r.escrow_units), (150, 200));
    }

    #[test]
    fn issuance_takes_only_confirmed_inflow_once_per_season() {
        let mut r = route();
        r.note_escrow(100, 120);
        assert!(r.issue(1, 101, 120).is_err(), "more than the vault confirmed");
        r.issue(1, 100, 120).unwrap();
        assert_eq!(r.unissued(), (0, 0));
        assert!(r.issue(1, 1, 1).is_err(), "the Season is funded");
        r.note_escrow(130, 160);
        assert!(r.issue(1, 30, 40).is_err(), "an earlier Season cannot be funded again");
        r.issue(2, 30, 40).unwrap();
        assert_eq!((r.issued_shares, r.issued_units), (130, 160));
    }

    #[test]
    fn payout_shares_stay_reserved_until_the_vault_answers() {
        let mut r = route();
        r.begin_payout(40).unwrap();
        r.begin_payout(10).unwrap();
        r.finish_payout(40).unwrap();
        r.cancel_payout(10).unwrap();
        assert_eq!((r.pending_payout_shares, r.paid_payout_shares), (0, 40));
        assert!(r.cancel_payout(1).is_err(), "nothing pending");
        assert!(r.finish_payout(1).is_err(), "nothing pending");
    }
}
