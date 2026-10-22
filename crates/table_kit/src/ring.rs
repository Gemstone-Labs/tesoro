//! The result ring. A table plays Match after Match; a finished Match's result stays in a ring
//! slot until `tesoro_core` has frozen that Match, so the next Match can never overwrite a win
//! that Solana has not yet paid.

use crate::KitError;
use anchor_lang::prelude::*;

pub const RING_LEN: usize = 8;

pub const SLOT_FREE: u8 = 0;
/// A Match began on the table; its result is not in yet.
pub const SLOT_RESERVED: u8 = 1;
/// The result is in and waits for core's receipt.
pub const SLOT_DONE: u8 = 2;

/// Outcomes a ring slot can carry. `finalize` maps them to `tesoro_core::MatchResult`.
pub const OUTCOME_NONE: u8 = 0;
/// The Match's opener (seat 0) won.
pub const OUTCOME_WIN0: u8 = 1;
/// The Match's joiner (seat 1) won.
pub const OUTCOME_WIN1: u8 = 2;
/// Refund both entries in full.
pub const OUTCOME_DRAW: u8 = 3;
/// Both checked in and neither acted: each side pays the Platform Fee.
pub const OUTCOME_NO_SHOW: u8 = 4;

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug,
)]
pub struct Slot {
    pub state: u8,
    /// The tesoro_core Match this slot belongs to.
    pub match_key: Pubkey,
    /// The table epoch the Match ran in.
    pub epoch: u64,
    pub outcome: u8,
    /// Rollup clock when the result was written.
    pub at: i64,
}

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug,
)]
pub struct Ring {
    pub slots: [Slot; RING_LEN],
}

impl Ring {
    /// Takes a free slot for a Match that begins now. A full ring refuses the Match.
    pub fn reserve(&mut self, match_key: Pubkey, epoch: u64) -> core::result::Result<u8, KitError> {
        if self
            .slots
            .iter()
            .any(|s| s.state != SLOT_FREE && s.match_key == match_key)
        {
            return Err(KitError::RingDuplicate);
        }
        let i = self
            .slots
            .iter()
            .position(|s| s.state == SLOT_FREE)
            .ok_or(KitError::RingFull)?;
        self.slots[i] = Slot {
            state: SLOT_RESERVED,
            match_key,
            epoch,
            outcome: OUTCOME_NONE,
            at: 0,
        };
        Ok(i as u8)
    }

    /// Writes the result into the slot reserved for (match, epoch).
    pub fn record(
        &mut self,
        index: u8,
        match_key: &Pubkey,
        epoch: u64,
        outcome: u8,
        at: i64,
    ) -> core::result::Result<(), KitError> {
        let slot = self
            .slots
            .get_mut(index as usize)
            .ok_or(KitError::RingSlot)?;
        if slot.state != SLOT_RESERVED
            || slot.match_key != *match_key
            || slot.epoch != epoch
            || outcome == OUTCOME_NONE
        {
            return Err(KitError::RingSlot);
        }
        slot.state = SLOT_DONE;
        slot.outcome = outcome;
        slot.at = at;
        Ok(())
    }

    /// The slot of (match, epoch), whatever its state.
    pub fn find(&self, match_key: &Pubkey, epoch: u64) -> Option<(u8, &Slot)> {
        self.slots
            .iter()
            .enumerate()
            .find(|(_, s)| s.state != SLOT_FREE && s.match_key == *match_key && s.epoch == epoch)
            .map(|(i, s)| (i as u8, s))
    }

    /// Frees a slot. The caller has already shown the evidence ([`crate::receipt_at`] or
    /// [`crate::match_state_gone`]); this only checks that the slot is the Match's.
    pub fn free(
        &mut self,
        index: u8,
        match_key: &Pubkey,
        allowed_state: u8,
    ) -> core::result::Result<Slot, KitError> {
        let slot = self
            .slots
            .get_mut(index as usize)
            .ok_or(KitError::RingSlot)?;
        if slot.state != allowed_state || slot.match_key != *match_key {
            return Err(KitError::RingSlot);
        }
        let old = *slot;
        *slot = Slot::default();
        Ok(old)
    }

    pub fn used(&self) -> usize {
        self.slots.iter().filter(|s| s.state != SLOT_FREE).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    #[test]
    fn a_full_ring_refuses_and_a_freed_slot_is_reused() {
        let mut r = Ring::default();
        for n in 0..RING_LEN as u8 {
            r.reserve(k(n + 1), 1).unwrap();
        }
        assert_eq!(r.reserve(k(99), 1), Err(KitError::RingFull));
        r.record(3, &k(4), 1, OUTCOME_WIN0, 5).unwrap();
        r.free(3, &k(4), SLOT_DONE).unwrap();
        assert_eq!(r.reserve(k(99), 2), Ok(3));
    }

    #[test]
    fn one_slot_per_match() {
        let mut r = Ring::default();
        r.reserve(k(1), 1).unwrap();
        assert_eq!(r.reserve(k(1), 2), Err(KitError::RingDuplicate));
    }

    #[test]
    fn record_needs_the_reserved_slot_of_that_match_and_epoch() {
        let mut r = Ring::default();
        let i = r.reserve(k(1), 7).unwrap();
        assert_eq!(
            r.record(i, &k(2), 7, OUTCOME_DRAW, 0),
            Err(KitError::RingSlot)
        );
        assert_eq!(
            r.record(i, &k(1), 8, OUTCOME_DRAW, 0),
            Err(KitError::RingSlot)
        );
        assert_eq!(
            r.record(i, &k(1), 7, OUTCOME_NONE, 0),
            Err(KitError::RingSlot)
        );
        r.record(i, &k(1), 7, OUTCOME_DRAW, 0).unwrap();
        // A result is written once.
        assert_eq!(
            r.record(i, &k(1), 7, OUTCOME_WIN0, 0),
            Err(KitError::RingSlot)
        );
    }

    #[test]
    fn a_reserved_slot_is_not_freed_as_if_it_were_done() {
        let mut r = Ring::default();
        let i = r.reserve(k(1), 1).unwrap();
        assert_eq!(r.free(i, &k(1), SLOT_DONE), Err(KitError::RingSlot));
        assert_eq!(r.free(i, &k(2), SLOT_RESERVED), Err(KitError::RingSlot));
        assert!(r.free(i, &k(1), SLOT_RESERVED).is_ok());
    }

    #[test]
    fn find_is_keyed_by_match_and_epoch() {
        let mut r = Ring::default();
        r.reserve(k(1), 4).unwrap();
        assert!(r.find(&k(1), 4).is_some());
        assert!(r.find(&k(1), 5).is_none());
        assert!(r.find(&k(2), 4).is_none());
    }
}
