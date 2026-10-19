# Tesoro

Stakers play now with yield they have not earned yet: Tesoro advances a Lock's projected yield as Gemas to play with, and the Lock stays locked until they are paid back.

Player words and code words: on 2026-10-19 the founder renamed the money terms Players read to plain words (Lock, Locked amount, Length, Earned, Left to pay back, test SOL). Code, programs, IDLs and the developer docs keep the older names (Position, Principal, Horizon, Accrued Yield, Debt, simSOL); each entry below names both. ADRs keep the words of their day.

## Language

### Money

**Lock** (code and on-chain: Position):
A staker's locked, yield-bearing stake in Tesoro. What it holds (its Locked amount) is never played with and never pays anything back; only its yield does. Players see "SOL Lock 1", "Your SOL Locks", "New Lock"; the action that makes one is "Get Gemas".
_Avoid_: Position (in Player copy), deposit, stake, vault, collateral

**Locked amount** (code and on-chain: Principal):
The staked amount inside a Lock, as opposed to the yield it earns. It is only ever locked, never spent. In sentences Players read "your SOL" or "what you lock".
_Avoid_: Principal (in Player copy), deposit, capital, collateral

**Advance**:
Gemas issued upfront against the projected yield of a Lock over a chosen Length, creating an obligation that keeps the Lock locked until it is paid back.
_Avoid_: loan, credit line, borrow, PNPL credit

**Extend**:
Adding months to a Lock's open Advance while some is still left to pay back, up to a total Length of 12 months. The added months' Gemas arrive at once as the owner's own Gemas of the same Source, at that Source's original price, and the Unlock Estimate moves out by the added months. Once it is paid back the Player takes another Advance instead.
_Avoid_: top-up, second Advance, refinance

**Extend Limit**:
A Player's own cap on the months Extend may add in any 30-day period, across all their Locks: 3 until they set it, 0 (Extend off) to 11 when they do. A Player can Extend at most once every 24 hours. Lowering the limit applies at once; raising it applies 24 hours later. Counted on real time, not the simulated yield clock.
_Avoid_: borrowing cap, credit limit

**Length** (code and on-chain: Horizon):
The period (1–12 months) a staker chooses when taking an Advance; the Advance is 80% of the Lock's projected yield over it: the yield net of the Yield Fee, so the Unlock Estimate still lands at the end of the Length. A Lock holds at most one open Advance. An open Advance with some left to pay back can be extended up to a total of 12 months (see **Extend**).
_Avoid_: Horizon (in Player copy), term, lock period, maturity

**Unlock Estimate**:
The projected date a Lock is paid back and unlocks. An estimate, never a promise: it moves with the provider's actual yield.
_Avoid_: unlock date, maturity date

**Earned** (code: Accrued Yield):
The yield a Lock has earned since it opened, net of the Yield Fee: its Locked amount times its staking growth since then. Always current; nobody has to record it, and it is what pays back the Advance and lets Gemas be Redeemed.
_Avoid_: Accrued Yield (in Player copy), refreshed yield, reported yield, cranked yield

**Staking Rate**:
How much of its asset one unit of a Lock's staking token is worth. It grows as the staking provider earns; its growth since a Lock opened is that Lock's yield. On devnet it is simulated (a fixed test APY, 1 month = 10 min). Not shown to Players.
_Avoid_: exchange rate, redemption rate, price, APY

**Gema** (plural Gemas):
The single play unit shared by every chain, worth $0.01 at the moment it is issued. Every Gema is a redeemable claim on its Source.
_Avoid_: credit, ORO, points, tokens, coins, chips, balance

**Source**:
The Advance a Gema was issued from, which fixes the asset and the amount that Gema redeems for. Gemas are equal at the table but not at redemption: its value follows its Source asset.
_Avoid_: backing (reserved for backing a player), provenance, collateral

**Left to pay back** (code and on-chain: Debt):
The outstanding Gemas Sourced from a Lock, fixed in the Lock's own asset ("0.55 SOL left to pay back"). Only the Lock's own Earned yield, or the return of Gemas Sourced from it, ever reduces it; the Lock stays locked until it reaches zero ("Paid back").
_Avoid_: Debt (in Player copy), loan balance, obligation

### Identity

**Account**:
One person's single Tesoro identity, holding one address per chain family (Solana, EVM). Locks, Gemas, Match history and Backings all belong to the Account, never to a wallet.
_Avoid_: wallet, user

**Profile**:
The display name and picture a Player chose for their Account, kept on chain and public. It decorates the Account; it holds nothing and is not the Account. Names are labels, not identities: they are not unique.
_Avoid_: account (the Profile is only how the Account is shown), username, handle

**Invite**:
A one-time code emailed to one waitlist member that allows exactly one Account to be created on mainnet, used up when that Account is created. Every mainnet Account needs one until the public launch; members cannot pass on extra Invites.
_Avoid_: referral, access code, whitelist spot

**Name service name**:
A `.sol` (Solana Name Service) or `.eth` (ENS) primary name of a wallet the Player attached to their Profile. It is shown with a verified mark because the registry says the wallet owns it and the wallet proved it belongs to the Account.

### Play

**Game**:
A title in Tesoro's catalogue, made by a Studio. The catalogue is four Games: heads-up Hold'em (real-time), a block-placement puzzle (async), Trading Duel (real-time, two Players pick boxes on a price grid and score when the live price line passes through them, over two and a half minutes) and Vanguard (real-time blitz Stratego: hidden ranks, 5 seconds a move, capture the enemy Supply Truck).
_Avoid_: app, title, Match (a single contest)

**Seed**:
The shared generated setup both Players of an async Match play against, so their scores are directly comparable. A score counts only as the server's replay of the Player's inputs against the Seed.
_Avoid_: level, round, puzzle
In UI copy the Seed is never named: Players see "the same pieces" (Block Puzzle).

**Match**:
A head-to-head contest between two players with equal Gema entries (100, 500 or 1,000 on mainnet; 500, 1,000 or 2,500 in test mode), settled once: the winner takes the Pot minus Fees; a draw, abandonment or no-show refunds both entries.
_Avoid_: game (the catalogue title), bet, wager, contest

**Pot**:
The Gemas entered into one Match, held in escrow until settlement. The winner receives the loser's actual Gemas, each keeping its Source. An entry always draws on the entrant's own-Sourced Gemas before Gemas they won.
_Avoid_: prize pool, jackpot (the Leaderboard Pool is a different thing)

**Queue**:
The waiting line for one game at one entry size, where Players are paired with the next entrant. In the async game a Player may play before an opponent is paired, so an unpaired Block Puzzle entry waits 24 hours for an opponent before it can be refunded; a live-game entry (Hold'em, Trading Duel, Vanguard) waits 1 hour.
_Avoid_: lobby, matchmaking pool

**Challenge**:
A Match opened by one Player for a specific opponent through a link, outside the Queue.
_Avoid_: invite, private table, duel

**Chips**:
In-match score units in Hold'em with no value outside the Match: the stack a Player bets with at the table. (Trading Duel scores points, which work the same way.) Gemas enter a Match once and leaves once; Chips are only the scorekeeping in between.
_Avoid_: in-game Gemas, bets

**Platform Fee**:
Tesoro's fixed share of every Pot on every game, taken in Gemas at settlement. One of Tesoro's three revenues, with the Yield Fee and the Instant Redeem Fee. Nothing is ever charged on a Locked amount.
_Avoid_: rake, commission, house edge

**Yield Fee**:
Tesoro's 20% of every increment of yield a Lock earns (SOL, ETH and HYPE alike), taken before the yield counts toward paying back, redemption or free yield. Never charged on a Locked amount.
_Avoid_: performance fee, staking commission, interest

**Studio Fee**:
The additional share of the Pot a game's studio sets for itself on top of the Platform Fee, taken in Gemas at settlement.
_Avoid_: developer cut, revenue share

**Leaderboard Fee**:
A fixed share of every Pot on every game (1% at launch), taken in Gemas at settlement on top of the Platform Fee and the Studio Fee, and paid into the Leaderboard Pool. A draw or a refund pays none. It is Tesoro's way of funding the prizes, not revenue.
_Avoid_: tournament fee, jackpot contribution, rake

**Leaderboard Pool**:
The Gemas collected from Leaderboard Fees, held by a Tesoro Account that no person controls and paid out to the top Players of each Season. Gemas in it keep their Source. Not a Pot: a Pot belongs to one Match.
_Avoid_: prize fund, jackpot, treasury (a Treasury is Tesoro's own holdings)

**Season**:
One week of the Leaderboard, Monday 00:00 UTC to the next Monday, numbered from 1 (Season 1 starts on 2026-10-05). The Leaderboard Pool is paid out 48 hours after the Season is recorded (shortly after it ends), once Tesoro has had the chance to void Players found cheating; a voided Player's slot pays nothing, the other ranks keep their places, and the voided share, and anything else not paid, rolls into the next.
_Avoid_: round, epoch, tournament

**Points**:
What a won Match earns its Player in a Season: one point for every 100 Gemas of entry, the same in every game. Losses, draws and refunds earn none. A backed Match earns them for the Player who played, not for the Backer. Only a Player's first 3 wins against the same opponent in a Season earn Points; later wins still pay the Pot. Ties in a Season go to the Player who first won in it.
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
The holder of the Gemas that fund a Backing. Only they bear the loss; their own Lock pays back as usual.
_Avoid_: investor, sponsor, staker (as a role in a Backing)

**Player**:
Whoever plays a Match, whether with their own Gemas or under a Backing. A backed Player never owes anything and can never redeem or redirect the Backer's Gemas.
_Avoid_: user, gamer, backee

### Redemption

**Redeem**:
To turn Gemas into their Source asset, possible only as far as the Source Lock's yield has actually been Earned. Winning Gemas never shortens the winner's own lock. Won Gemas can instead be Instant Redeemed.
_Avoid_: withdraw, cash out, claim

**Instant Redeem**:
Turning won Gemas into their Source asset now, before the Source's yield has landed, for 75% of their value, while the Treasury of that asset holds enough to pay it. The Treasury pays it and takes the Gemas; Tesoro keeps the other 25% (the **Instant Redeem Fee**). Only free Gemas the holder won whose yield has not landed yet (landed Gemas are Redeemed at full value), never their own-Sourced ones; what the Source Lock has left to pay back, and its counts, are untouched.
_Avoid_: early withdrawal, cash out, sell

**Treasury**:
Tesoro's own holdings and revenue, one per asset (on Solana, and inside each EVM vault). It collects the Yield Fee, pays Instant Redeems while it holds enough, is refilled when the Gemas it bought are redeemed at full value, and Tesoro may withdraw from it at any time. Not the Leaderboard Pool, and not a Lock.
_Avoid_: reserve, vault (a Lock's custody), pool

**Yield Report**:
An ETH or HYPE vault's statement of a Lock's Earned yield (and what the vault's Treasury still holds), carried to Solana when a Player's Redeem or Unlock needs it. Anyone may ask for it; nobody can alter it.
_Avoid_: sync, refresh, crank

### Protections

**Entry Limit**:
A Player's own cap on the Gemas they may enter into Matches in any 7 days. Off until they set it; lowering applies at once, raising applies 24 hours later.
_Avoid_: loss limit, betting limit, wager cap

**Break**:
A period of 1 day to 6 weeks, chosen by the Player, in which they cannot enter Matches. It cannot be ended early. Redeem and Unlock keep working.
_Avoid_: cool-off, pause, timeout

**Self-Exclusion**:
A period of 6 months or more, chosen by the Player, in which they cannot enter Matches, take Advances or Extend. It cannot be ended early. Redeem and Unlock keep working.
_Avoid_: ban, account closure, lockout
