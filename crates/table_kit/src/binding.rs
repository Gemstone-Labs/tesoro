//! Who may act for a seat. A seat record carries the Player's wallet (`player`) and the seat key
//! (`signer`) the Player bound for this Match. [`require_acting_seat`] resolves the one seat
//! being acted on, checks its whole binding (seat, Player, Match, Table epoch) and only then
//! accepts the signer, so a key that merely belongs to some Player never passes.

use anchor_lang::prelude::*;

/// The two keys that may act for one seat. `signer == player` when no seat key is bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeatKeys {
    pub player: Pubkey,
    pub signer: Pubkey,
}

impl SeatKeys {
    /// A seat acted on by the wallet alone.
    pub fn wallet(player: Pubkey) -> Self {
        Self {
            player,
            signer: player,
        }
    }

    /// The permission members of the seat: `[player, signer]`, one entry when they are equal.
    pub fn members(&self) -> Vec<Pubkey> {
        if self.player == self.signer {
            vec![self.player]
        } else {
            vec![self.player, self.signer]
        }
    }
}

/// What a seat record holds, as read from the Game's seat account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeatRecord {
    pub seat: usize,
    pub keys: SeatKeys,
    pub tesoro_match: Pubkey,
    pub epoch: u64,
}

/// What the table says the seats are.
#[derive(Debug, Clone, Copy)]
pub struct TableSeats<'a> {
    /// The Players' wallets by seat.
    pub players: &'a [Pubkey],
    pub tesoro_match: Pubkey,
    pub epoch: u64,
    pub seats_open: bool,
}

/// Why a seat check refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeatBindingError {
    /// The seat record is not this table's seat for its Player in this Match and epoch, or the
    /// table's seats are closed.
    NotBound,
    /// The signer is neither the seat's Player nor its seat key.
    NotTheSeat,
    /// Two seats share a Player, or a seat key is another seat's Player or the same as the
    /// table's: the signer could not be told apart.
    Ambiguous,
}

/// Resolves the seat `record` and returns its index, if `signer` may act for it.
pub fn require_acting_seat(
    table: &TableSeats,
    record: &SeatRecord,
    signer: &Pubkey,
) -> core::result::Result<usize, SeatBindingError> {
    let SeatKeys {
        player,
        signer: key,
    } = record.keys;
    for (i, p) in table.players.iter().enumerate() {
        if table.players[..i].contains(p) {
            return Err(SeatBindingError::Ambiguous);
        }
    }
    let seat = table
        .players
        .iter()
        .position(|p| *p == player)
        .ok_or(SeatBindingError::NotBound)?;
    if !(table.seats_open
        && record.seat == seat
        && record.tesoro_match == table.tesoro_match
        && record.epoch == table.epoch)
    {
        return Err(SeatBindingError::NotBound);
    }
    if key != player && table.players.contains(&key) {
        return Err(SeatBindingError::Ambiguous);
    }
    if *signer != player && *signer != key {
        return Err(SeatBindingError::NotTheSeat);
    }
    Ok(seat)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    const ANA: u8 = 1;
    const BEN: u8 = 2;
    const ANA_KEY: u8 = 11;
    const BEN_KEY: u8 = 12;
    const MATCH: u8 = 50;

    fn players() -> [Pubkey; 2] {
        [k(ANA), k(BEN)]
    }

    fn table(players: &[Pubkey]) -> TableSeats<'_> {
        TableSeats {
            players,
            tesoro_match: k(MATCH),
            epoch: 7,
            seats_open: true,
        }
    }

    fn ana_seat() -> SeatRecord {
        SeatRecord {
            seat: 0,
            keys: SeatKeys {
                player: k(ANA),
                signer: k(ANA_KEY),
            },
            tesoro_match: k(MATCH),
            epoch: 7,
        }
    }

    #[test]
    fn wallet_and_seat_key_both_act() {
        let p = players();
        assert_eq!(require_acting_seat(&table(&p), &ana_seat(), &k(ANA)), Ok(0));
        assert_eq!(
            require_acting_seat(&table(&p), &ana_seat(), &k(ANA_KEY)),
            Ok(0)
        );
    }

    #[test]
    fn second_seat_resolves_to_its_index() {
        let p = players();
        let ben = SeatRecord {
            seat: 1,
            keys: SeatKeys {
                player: k(BEN),
                signer: k(BEN_KEY),
            },
            ..ana_seat()
        };
        assert_eq!(require_acting_seat(&table(&p), &ben, &k(BEN_KEY)), Ok(1));
    }

    #[test]
    fn opponents_keys_are_refused_on_my_seat() {
        let p = players();
        for who in [BEN, BEN_KEY] {
            assert_eq!(
                require_acting_seat(&table(&p), &ana_seat(), &k(who)),
                Err(SeatBindingError::NotTheSeat)
            );
        }
    }

    #[test]
    fn stranger_is_refused() {
        let p = players();
        assert_eq!(
            require_acting_seat(&table(&p), &ana_seat(), &k(99)),
            Err(SeatBindingError::NotTheSeat)
        );
    }

    #[test]
    fn key_from_another_match_is_refused() {
        let p = players();
        let old = SeatRecord {
            tesoro_match: k(51),
            ..ana_seat()
        };
        assert_eq!(
            require_acting_seat(&table(&p), &old, &k(ANA_KEY)),
            Err(SeatBindingError::NotBound)
        );
    }

    #[test]
    fn old_key_on_a_reused_table_is_refused() {
        let p = players();
        let old = SeatRecord {
            epoch: 6,
            ..ana_seat()
        };
        assert_eq!(
            require_acting_seat(&table(&p), &old, &k(ANA_KEY)),
            Err(SeatBindingError::NotBound)
        );
        assert_eq!(
            require_acting_seat(&table(&p), &old, &k(ANA)),
            Err(SeatBindingError::NotBound)
        );
    }

    #[test]
    fn wrong_seat_index_or_closed_seats_are_refused() {
        let p = players();
        let swapped = SeatRecord {
            seat: 1,
            ..ana_seat()
        };
        assert_eq!(
            require_acting_seat(&table(&p), &swapped, &k(ANA)),
            Err(SeatBindingError::NotBound)
        );
        let closed = TableSeats {
            seats_open: false,
            ..table(&p)
        };
        assert_eq!(
            require_acting_seat(&closed, &ana_seat(), &k(ANA)),
            Err(SeatBindingError::NotBound)
        );
    }

    #[test]
    fn player_not_at_the_table_is_refused() {
        let p = [k(BEN), k(3)];
        assert_eq!(
            require_acting_seat(&table(&p), &ana_seat(), &k(ANA)),
            Err(SeatBindingError::NotBound)
        );
    }

    #[test]
    fn seat_key_equal_to_the_opponents_wallet_is_ambiguous() {
        let p = players();
        let aliased = SeatRecord {
            keys: SeatKeys {
                player: k(ANA),
                signer: k(BEN),
            },
            ..ana_seat()
        };
        assert_eq!(
            require_acting_seat(&table(&p), &aliased, &k(BEN)),
            Err(SeatBindingError::Ambiguous)
        );
    }

    #[test]
    fn duplicate_players_are_ambiguous() {
        let p = [k(ANA), k(ANA)];
        assert_eq!(
            require_acting_seat(&table(&p), &ana_seat(), &k(ANA)),
            Err(SeatBindingError::Ambiguous)
        );
    }

    #[test]
    fn wallet_only_seat_acts_by_wallet_alone() {
        let p = players();
        let wallet = SeatRecord {
            keys: SeatKeys::wallet(k(ANA)),
            ..ana_seat()
        };
        assert_eq!(require_acting_seat(&table(&p), &wallet, &k(ANA)), Ok(0));
        assert_eq!(
            require_acting_seat(&table(&p), &wallet, &k(ANA_KEY)),
            Err(SeatBindingError::NotTheSeat)
        );
    }

    #[test]
    fn members_are_player_and_signer_or_one_entry() {
        assert_eq!(SeatKeys::wallet(k(ANA)).members(), vec![k(ANA)]);
        let keys = SeatKeys {
            player: k(ANA),
            signer: k(ANA_KEY),
        };
        assert_eq!(keys.members(), vec![k(ANA), k(ANA_KEY)]);
    }
}
