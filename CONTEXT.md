# Tesoro

Stakers play now with yield they have not earned yet: Tesoro advances a staking position's projected yield as Gemas to play with, and the position stays locked until they are paid back.

## Language

### Money

**Position**:
A staker's locked, yield-bearing stake in Tesoro. Its Principal is never played with and never pays Debt; only its yield does.
_Avoid_: deposit, stake, vault, collateral

**Principal**:
The staked amount inside a Position, as opposed to the yield it earns. It is only ever locked, never spent.
_Avoid_: deposit, capital, collateral

**Advance**:
Gemas issued upfront against the projected yield of a Position over a chosen period, creating an obligation that keeps the Position locked until it is resolved.
_Avoid_: loan, credit line, borrow, PNPL credit

**Horizon**:
The period (1–12 months) a staker chooses when taking an Advance; the Advance is 100% of the Position's projected yield over it. A Position holds at most one open Advance.
_Avoid_: term, lock period, maturity

**Unlock Estimate**:
The projected date a Position's Debt reaches zero. An estimate, never a promise: it moves with the provider's actual yield.
_Avoid_: unlock date, maturity date

**Gema** (plural Gemas):
The single play unit shared by every chain, worth $0.01 at the moment it is issued. Every Gema is a redeemable claim on its Source.
_Avoid_: credit, ORO, points, tokens, coins, chips, balance

**Source**:
The Advance a Gema was issued from, which fixes the asset and the amount that Gema redeems for. Gemas are equal at the table but not at redemption: its value follows its Source asset.
_Avoid_: backing (reserved for backing a player), provenance, collateral

**Debt**:
The outstanding Gemas Sourced from a Position, fixed in the Position's own asset. Only the Position's own accrued yield, or the return of Gemas Sourced from it, ever reduces it; the Position stays locked until it reaches zero.
_Avoid_: loan balance, obligation

### Identity

**Account**:
One person's single Tesoro identity, holding one address per chain family (Solana, EVM). Positions, Gemas, Match history and Backings all belong to the Account, never to a wallet.
_Avoid_: wallet, user

**Profile**:
The display name and picture a Player chose for their Account, kept on chain and public. It decorates the Account; it holds nothing and is not the Account. Names are labels, not identities: they are not unique.
_Avoid_: account (the Profile is only how the Account is shown), username, handle

**Name service name**:
A `.sol` (Solana Name Service) or `.eth` (ENS) primary name of a wallet the Player attached to their Profile. It is shown with a verified mark because the registry says the wallet owns it and the wallet proved it belongs to the Account.

### Play

**Game**:
A title in Tesoro's catalogue, made by a Studio. The launch catalogue is three Games: heads-up Hold'em (real-time), a block-placement puzzle (async) and Trading Duel (real-time, two Players trade one live price for five minutes).
_Avoid_: app, title, Match (a single contest)

**Seed**:
The shared generated setup both Players of an async Match play against, so their scores are directly comparable. A score counts only as the server's replay of the Player's inputs against the Seed.
_Avoid_: level, round, puzzle
In UI copy the Seed is never named: Players see "the same pieces" (Block Puzzle).

**Match**:
A head-to-head contest between two players with equal Gema entries (500, 1,000 or 2,500), settled once: the winner takes the Pot minus Fees; a draw, abandonment or no-show refunds both entries.
_Avoid_: game (the catalogue title), bet, wager, contest

**Pot**:
The Gemas entered into one Match, held in escrow until settlement. The winner receives the loser's actual Gemas, each keeping its Source. An entry always draws on the entrant's own-Sourced Gemas before Gemas they won.
_Avoid_: prize pool, jackpot (the Leaderboard Pool is a different thing)

**Queue**:
The waiting line for one game at one entry size, where Players are paired with the next entrant. In the async game a Player may play before an opponent is paired.
_Avoid_: lobby, matchmaking pool

**Challenge**:
A Match opened by one Player for a specific opponent through a link, outside the Queue.
_Avoid_: invite, private table, duel

**Chips**:
In-match score units in Hold'em and Trading Duel with no value outside the Match: the stack a Player bets with at the table, or trades with against the live price. Gemas enter a Match once and leaves once; Chips are only the scorekeeping in between.
_Avoid_: in-game Gemas, bets

**Platform Fee**:
Tesoro's fixed share of every Pot on every game, taken in Gemas at settlement. Tesoro's only revenue; nothing is ever charged on Principal, Advances or redemption.
_Avoid_: rake, commission, house edge

**Studio Fee**:
The additional share of the Pot a game's studio sets for itself on top of the Platform Fee, taken in Gemas at settlement.
_Avoid_: developer cut, revenue share

**Leaderboard Fee**:
A fixed share of every Pot on every game (1% at launch), taken in Gemas at settlement on top of the Platform Fee and the Studio Fee, and paid into the Leaderboard Pool. A draw or a refund pays none. It is Tesoro's way of funding the prizes, not revenue.
_Avoid_: tournament fee, jackpot contribution, rake

**Leaderboard Pool**:
The Gemas collected from Leaderboard Fees, held by a Tesoro Account that no person controls and paid out to the top Players of each Season. Gemas in it keep their Source. Not a Pot: a Pot belongs to one Match.
_Avoid_: prize fund, jackpot, treasury

**Season**:
One week of the Leaderboard, Monday 00:00 UTC to the next Monday, numbered from 1 (Season 1 starts on 2026-10-05). The Leaderboard Pool is paid out when a Season ends, and what is not paid rolls into the next.
_Avoid_: round, epoch, tournament

**Points**:
What a won Match earns its Player in a Season: one point for every 100 Gemas of entry, so 5, 10 and 25 for the three entries, the same in every game. Losses, draws and refunds earn none. A backed Match earns them for the Player who played, not for the Backer. Ties in a Season go to the Player who first won in it.
_Avoid_: score (a game's own result), XP, rank

**Studio**:
The maker of a game listed on Tesoro. Tesoro's own games have Tesoro as their Studio.
_Avoid_: developer, partner, publisher

### Backing

**Backing**:
An agreement, accepted by both sides, in which a Backer funds a Player's full entry into one Match. On a win the Backer's entry is returned first and the remainder is split by the share the Backer offered. It cannot be revoked once the Match starts.
_Avoid_: staking (a player), sponsorship, scholarship, loan

**Request**:
A Player's public listing asking to be backed for a game and entry size, shown with their real Match history. It carries no split; Backers answer it with Offers and the Player accepts one.
_Avoid_: application, ask, listing

**Offer**:
A Backer's terms for a Backing: game, entry and the Player's share of the surplus. Either directed at a Request (the Player accepts) or public (Players apply and the Backer accepts one). Either way the Backer chooses whom they back and the Player consents to the terms.
_Avoid_: bid, proposal, deal

**Backer**:
The holder of the Gemas that fund a Backing. Only they bear the loss; their own Position repays its Debt as usual.
_Avoid_: investor, sponsor, staker (as a role in a Backing)

**Player**:
Whoever plays a Match, whether with their own Gemas or under a Backing. A backed Player never gains Debt and can never redeem or redirect the Backer's Gemas.
_Avoid_: user, gamer, backee

### Redemption

**Redeem**:
To turn Gemas into their Source asset, possible only as far as the Source Position's yield has actually accrued. Winning Gemas never shortens the winner's own lock.
_Avoid_: withdraw, cash out, claim
