use crate::msg_codec::{KIND_LEADERBOARD, KIND_STUDIO, MAX_BATCH_ENTRIES};
use crate::*;

pub const BATCH_OPEN: u8 = 0;
/// Immutable and in transit: its message may be sent, and sent again, until every entry is paid.
pub const BATCH_SEALED: u8 = 1;
pub const BATCH_DONE: u8 = 2;

/// One covered fee counter of one Position, already debited on Solana.
#[derive(Clone, Copy, Default, AnchorSerialize, AnchorDeserialize, InitSpace)]
pub struct BatchEntry {
    /// The Position's id inside the vault.
    pub vault_position_id: u64,
    /// The core Source whose counter paid the units.
    pub source: Pubkey,
    /// Source-asset units debited from the counter and owed by the vault.
    pub units: u64,
    /// Units the vault has acknowledged paying, cumulative. Only grows, never above `units`.
    pub paid: u128,
}

/// An immutable, route-scoped cash-in batch (`["batch", eid, vault, id]`): Platform, Studio or
/// Leaderboard fees of ETH/HYPE Sources.
///
/// Solana debits each counter when the entry is added (core's `cash_in_fee_from_source`), so the
/// units are owed by the vault from that moment and nothing here ever gives them back: a lost or
/// delayed message is sent again with the same batch id and the vault pays each entry at most
/// once (persistent receipt); acknowledgements carry cumulative amounts and are applied with a
/// maximum, so duplicates, reordering and partial executions reconcile to the same state.
#[account]
#[derive(InitSpace)]
pub struct Batch {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub id: u64,
    pub bump: u8,
    /// 0 Platform, 1 Studio, 2 Leaderboard (core fee class).
    pub kind: u8,
    pub state: u8,
    /// EVM address paid by Platform and Studio batches; zero for Leaderboard (the vault's escrow).
    pub recipient: [u8; 20],
    pub count: u8,
    pub entries: [BatchEntry; MAX_BATCH_ENTRIES],
    pub total_units: u128,
    pub paid_units: u128,
    /// How many times the message was sent (informational).
    pub sends: u32,
}

impl Batch {
    pub fn entries(&self) -> &[BatchEntry] {
        &self.entries[..usize::from(self.count)]
    }

    pub fn add(&mut self, entry: BatchEntry, recipient: [u8; 20]) -> Result<()> {
        require!(self.state == BATCH_OPEN, BridgeError::BatchNotOpen);
        require!(usize::from(self.count) < MAX_BATCH_ENTRIES, BridgeError::BatchFull);
        require!(entry.units > 0, BridgeError::NothingToPay);
        if self.kind == KIND_LEADERBOARD {
            require!(recipient == [0u8; 20], BridgeError::BatchMismatch);
        } else if self.count == 0 {
            require!(recipient != [0u8; 20], BridgeError::NoEvmAddress);
            self.recipient = recipient;
        } else {
            require!(self.recipient == recipient, BridgeError::BatchMismatch);
        }
        self.entries[usize::from(self.count)] = entry;
        self.count += 1;
        self.total_units = self
            .total_units
            .checked_add(u128::from(entry.units))
            .ok_or(BridgeError::AmountOverflow)?;
        Ok(())
    }

    pub fn seal(&mut self, min_units: u64) -> Result<()> {
        require!(self.state == BATCH_OPEN, BridgeError::BatchNotOpen);
        require!(self.count > 0, BridgeError::BatchEmpty);
        require!(self.total_units >= u128::from(min_units), BridgeError::BatchBelowMinimum);
        self.state = BATCH_SEALED;
        Ok(())
    }

    /// Applies an acknowledgement: `paid[i]` is the vault's cumulative payment of entry `i`.
    /// Returns whether anything changed. Idempotent and order-independent.
    pub fn apply_result(&mut self, paid: &[u128]) -> Result<bool> {
        require!(self.state != BATCH_OPEN, BridgeError::BatchNotSealed);
        require!(paid.len() == usize::from(self.count), BridgeError::BatchMismatch);
        let mut changed = false;
        for (entry, reported) in self.entries[..usize::from(self.count)].iter_mut().zip(paid) {
            let next = (*reported).min(u128::from(entry.units)).max(entry.paid);
            changed |= next != entry.paid;
            entry.paid = next;
        }
        let total: u128 = self.entries().iter().map(|e| e.paid).sum();
        self.paid_units = total;
        if total == self.total_units {
            self.state = BATCH_DONE;
        }
        Ok(changed)
    }

    /// Units the vault still owes on this batch.
    pub fn owed_units(&self) -> u128 {
        self.total_units.saturating_sub(self.paid_units)
    }

    pub fn is_fee(&self) -> bool {
        self.kind <= KIND_STUDIO
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(kind: u8) -> Batch {
        Batch {
            eid: 1,
            peer_address: [0; 32],
            id: 1,
            bump: 0,
            kind,
            state: BATCH_OPEN,
            recipient: [0; 20],
            count: 0,
            entries: [BatchEntry::default(); MAX_BATCH_ENTRIES],
            total_units: 0,
            paid_units: 0,
            sends: 0,
        }
    }

    fn entry(id: u64, units: u64) -> BatchEntry {
        BatchEntry { vault_position_id: id, source: Pubkey::new_unique(), units, paid: 0 }
    }

    #[test]
    fn a_fee_batch_has_one_registered_recipient() {
        let mut b = batch(0);
        assert!(b.add(entry(1, 5), [0; 20]).is_err(), "no recipient");
        b.add(entry(1, 5), [7; 20]).unwrap();
        assert!(b.add(entry(2, 5), [8; 20]).is_err(), "recipient changed under the batch");
        b.add(entry(2, 6), [7; 20]).unwrap();
        assert_eq!((b.count, b.total_units, b.recipient), (2, 11, [7; 20]));
    }

    #[test]
    fn a_leaderboard_batch_pays_no_wallet() {
        let mut b = batch(KIND_LEADERBOARD);
        assert!(b.add(entry(1, 5), [7; 20]).is_err());
        b.add(entry(1, 5), [0; 20]).unwrap();
    }

    #[test]
    fn sealing_needs_entries_and_the_minimum_and_freezes_the_batch() {
        let mut b = batch(0);
        assert!(b.seal(0).is_err(), "empty");
        b.add(entry(1, 5), [7; 20]).unwrap();
        assert!(b.seal(6).is_err(), "below the minimum");
        b.seal(5).unwrap();
        assert!(b.add(entry(2, 5), [7; 20]).is_err(), "sealed batches are immutable");
        assert!(b.seal(0).is_err(), "sealed once");
    }

    #[test]
    fn a_batch_holds_a_bounded_number_of_entries() {
        let mut b = batch(KIND_LEADERBOARD);
        for i in 0..MAX_BATCH_ENTRIES as u64 {
            b.add(entry(i, 1), [0; 20]).unwrap();
        }
        assert!(b.add(entry(99, 1), [0; 20]).is_err());
    }

    #[test]
    fn acknowledgements_are_cumulative_so_duplicates_and_reordering_change_nothing() {
        let mut b = batch(0);
        b.add(entry(1, 10), [7; 20]).unwrap();
        b.add(entry(2, 20), [7; 20]).unwrap();
        b.seal(0).unwrap();
        assert!(b.apply_result(&[4, 0]).unwrap());
        assert!(!b.apply_result(&[4, 0]).unwrap(), "the same acknowledgement again");
        assert!(b.apply_result(&[10, 5]).unwrap());
        assert!(!b.apply_result(&[4, 0]).unwrap(), "an older one delivered late");
        assert_eq!((b.paid_units, b.owed_units(), b.state), (15, 15, BATCH_SEALED));
        assert!(b.apply_result(&[10]).is_err(), "wrong entry count");
        b.apply_result(&[999, 20]).unwrap();
        assert_eq!(
            (b.paid_units, b.owed_units(), b.state),
            (30, 0, BATCH_DONE),
            "never above the request"
        );
    }

    #[test]
    fn an_acknowledgement_for_an_unsealed_batch_is_refused() {
        let mut b = batch(0);
        b.add(entry(1, 10), [7; 20]).unwrap();
        assert!(b.apply_result(&[1]).is_err());
    }
}
