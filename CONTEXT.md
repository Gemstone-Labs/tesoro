# Tesoro

Stakers play now with yield they have not earned yet: Tesoro advances a Lock's projected yield as Gemas to play with, and the Lock stays locked until they are paid back.

Player words and code words: on 2026-10-19 the founder renamed the money terms Players read to plain words (Lock, Locked amount, Length, Earned, Left to pay back, test SOL). Code, programs, IDLs and the developer docs keep the older names (Position, Principal, Horizon, Accrued Yield, Debt, simSOL); each entry below names both. ADRs keep the words of their day.

## Language

### Money

**Lock** (code and on-chain: Position):
A staker's locked, yield-bearing stake in Tesoro. What it holds (its Locked amount) is never played with and never pays anything back; only its yield does. Players see "SOL Lock 1", "Your SOL Locks", "New Lock"; the action that makes one is "Get Gemas".
_Avoid_: Position (in Player copy), stake, collateral. "Deposit" and "Vault" are the Simple view's words for it, below.

**Deposit** (Simple view; code: a SOL Lock with a 12-month Length and its Advance taken):
What a beginner puts in through a Pack. The Simple view never says Lock, Advance, Length, staking or APY (`app/src/plain-words.test.ts` guards `vault/` and `components/deposit/`). Players read "You get your deposit back after about 12 months": about, never a promise, and what comes back depends on the SOL price when they withdraw.
_Avoid_: buy, spend, purchase (a deposit is money that comes back)

**Pack**:
One of the three fixed deposits in the Simple view's Buy Gemas modal: Starter $100, Player $250, Pro $500. Code names it `DepositPack`; the waitlist's reveal pack is a different thing.

**Vault** (Simple view's money page, `/vault`):
Your Gemas, your deposits and when each comes back, and your winnings to cash out. **Pro view** (code: the Advanced view) is today's Wallet. Its switch sits on the Vault under the balance card and in both Buy Gemas modals (switching in a modal swaps to the other one). Every Account starts with Pro view off and remembers its choice. Buy Gemas is the Vault's main action; Borrow Gemas beside it opens Post a Request on the Backing board.

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
The period (1–12 months) a staker chooses when taking an Advance; the Advance is the Lock's whole projected yield over it (Gemas are 100% of the yield), so the Unlock Estimate lands at the end of the Length. The Yield Fee is taken later, when the Gemas are cashed out. A Lock holds at most one open Advance. An open Advance with some left to pay back can be extended up to a total of 12 months (see **Extend**).
_Avoid_: Horizon (in Player copy), term, lock period, maturity

**Unlock Estimate**:
The projected date a Lock is paid back and unlocks. An estimate, never a promise: it moves with the provider's actual yield.
_Avoid_: unlock date, maturity date

**Earned** (code: Accrued Yield):
The yield a Lock has earned since it opened: its Locked amount times its staking growth since then (nothing is taken from it as it accrues). Always current; nobody has to record it, and it is what pays back the Advance and lets Gemas be Redeemed.
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

**Friend**:
Another Account that both Players agreed to keep in each other's private list, kept off chain and seen only by the two of them. Friendship is a convenience: it changes no rule of play, Points or payouts.
_Avoid_: follower, contact, buddy, invite

**Friend request**:
One Player's ask to become Friends with another Account, which becomes a friendship only when the other Player accepts it.
_Avoid_: invite (an Invite is the waitlist's way into mainnet)

**Add-me link**:
A Player's own shareable link that makes whoever opens it and accepts their Friend, with no further step from the owner. The owner can reset it, which ends the old link. Lower case mid-sentence ("your add-me link").
_Avoid_: Friend link (reads as a friend's link), invite link, referral link

### Play

**Game**:
A title in Tesoro's catalogue, made by a Studio. The catalogue is four Games: Buckshot Hold'em (heads-up poker, real-time), a block-placement puzzle (async), Trading Duel (real-time, two Players pick boxes on a price grid and score when the live price line passes through them, over two and a half minutes) and Vanguard (real-time blitz Stratego: hidden ranks, 10 seconds a move, every rank has a power, capture the enemy Supply Truck).
_Avoid_: app, title, Match (a single contest)

**Seed**:
The shared generated setup both Players of an async Match play against, so their scores are directly comparable. A score counts only as the server's replay of the Player's inputs against the Seed.
_Avoid_: level, round, puzzle
In UI copy the Seed is never named: Players see "the same pieces" (Block Burst).

**Match**:
A head-to-head contest between two players with equal Gema entries (100, 500 or 1,000 on mainnet; 500, 1,000 or 2,500 in test mode), settled once: the winner takes the Pot minus Fees; a draw or an abandoned Match refunds both entries; a no-show (both Players checked in, then neither acted) settles as a draw minus each side's Platform Fee. No Match can start settling more than 7 days after it opened: after that, only a refund is possible, in any Game.
_Avoid_: game (the catalogue title), bet, wager, contest

**Pot**:
The Gemas entered into one Match, held in escrow until settlement. The winner receives the loser's actual Gemas, each keeping its Source. The program, never the app, chooses which Gemas an entry uses: the entrant's own-Sourced Gemas first, then won Gemas whose planned repayment date is earliest (see **Entry draw**).
_Avoid_: prize pool, jackpot (the Leaderboard Pool is a different thing)

**Queue**:
The waiting line for one game at one entry size, where Players are paired with the next entrant. In the async game a Player may play before an opponent is paired, so an unpaired Block Burst entry waits 24 hours for an opponent before it can be refunded; a live-game entry (Hold'em, Trading Duel, Vanguard) waits 1 hour.
_Avoid_: lobby, matchmaking pool

**Challenge**:
A Match opened by one Player for a specific opponent through a link, outside the Queue.
_Avoid_: invite, private table, duel

**Table**:
A seat for a Match that Hold'em, Trading Duel and Vanguard keep ready on MagicBlock between Matches. A Match is bound to exactly one Table, which shows nothing from the Match before. Players never set a Table up or pay for one; Tesoro does, once per Table, and each Game has a capped number of them. Block Puzzle has no Tables yet.
_Avoid_: room, lobby, server

**Chips**:
In-match score units in Hold'em with no value outside the Match: the stack a Player bets with at the table. (Trading Duel scores points, which work the same way.) Gemas enter a Match once and leaves once; Chips are only the scorekeeping in between.
_Avoid_: in-game Gemas, bets

**Platform Fee**:
Tesoro's fixed share of every Pot on every game, taken in Gemas at settlement. One of Tesoro's three revenues, with the Yield Fee and the Instant Redeem Fee. Nothing is ever charged on a Locked amount.
_Avoid_: rake, commission, house edge

**Yield Fee**:
20% of yield when it is cashed out (SOL, ETH and HYPE alike): on a Redeem, on the repaid part of an Instant Redeem, when the Treasury redeems the Gemas it bought, and on a Lock owner's free yield at Unlock (including what a Return gave back). Taken once per cash-out, from what leaves: 1,000 Gemas Redeem for $8.00. Never charged on a Locked amount, on fee Gemas (Platform, Studio, Leaderboard Fees) or on prize Gemas. Half is Tesoro's revenue and half is owed to the Leaderboard Pool, both counted when the cash-out happens. Each Advance keeps the Yield Fee and the Pool's share in force when it was taken.
_Avoid_: performance fee, staking commission, interest

**Studio Fee**:
The additional share of the Pot a game's studio sets for itself on top of the Platform Fee, taken in Gemas at settlement. At most 10% of the Pot.
_Avoid_: developer cut, revenue share

**Leaderboard Fee**:
A fixed share of every Pot on every game (1% at launch), taken in Gemas at settlement on top of the Platform Fee and the Studio Fee, and paid into the Leaderboard Pool. A draw or a refund pays none. It is Tesoro's way of funding the prizes, not revenue. Its Gemas are repaid third in the **Payout order**.
_Avoid_: tournament fee, jackpot contribution, rake

**Leaderboard Pool**:
The prize money of the Leaderboard: the Gemas collected from Leaderboard Fees plus half the Yield Fee, held by a Tesoro Account that no person controls and paid out to the top Players of each Season. Gemas from Leaderboard Fees keep their Source. The Yield Fee half arrives as **prize Gemas**, each backed by staking tokens set aside for them, so prizes can be Redeemed at once. Every rank is paid the same mix of coins (SOL, ETH, HYPE) from a budget frozen when the Season is recorded. Not a Pot: a Pot belongs to one Match.
_Avoid_: prize fund, jackpot, treasury (a Treasury is Tesoro's own holdings)

**Season**:
One week of the Leaderboard, Monday 00:00 UTC to the next Monday, numbered from 1 (Season 1 starts on 2026-10-05). The Leaderboard Pool is paid out 48 hours after the Season is recorded (shortly after it ends), once Tesoro has had the chance to void Players found cheating; a voided Player's slot pays nothing, the other ranks keep their places, and the voided share, and anything else not paid, rolls into the next.
_Avoid_: round, epoch, tournament

**Points**:
What a won Match earns its Player in a Season: one point for every 100 Gemas of entry, the same in every game. Losses, draws and refunds earn none. A backed Match earns them for the Player who played, not for the Backer. Only a Player's first 3 wins against the same opponent in a Season earn Points; later wins still pay the Pot. Ties in a Season go to the Player who first won in it.
_Avoid_: score (a game's own result), XP, rank

**Studio**:
The maker of a game. Anyone who controls a game's program can register it, so the game can use Gemas. Tesoro's own games have Tesoro as their Studio. A Studio is **listed** when Tesoro has accepted its game (see **Listing**) and **unlisted** otherwise.
_Avoid_: developer, partner, publisher

**Listing** (a **Listed Game** is one whose listing is in force):
Tesoro's acceptance of a Game: free to apply, $500 a year once accepted, tied to the exact build Tesoro approved. Only a Listed Game earns Points, gets sponsored SOL costs, has its Studio Fee repaid ahead of other holders (second in the **Payout order**) and can be Backed. Unlisted Games still work, but do none of those. An upgrade of the Game to different code ends its listing until Tesoro approves the new build; a Match opened before the upgrade can then only be refunded.
_Avoid_: whitelist, verification, certification

### Vanguard

**Supply Truck**:
Each Army's objective piece in Vanguard. Capturing the enemy Supply Truck wins the Match. It moves one square, three times in all, never in two of its own turns in a row, and is shown to the enemy after its third drive. Rescue can send it across the board.
_Avoid_: flag, king

**Landmine**:
A Vanguard piece that never moves and beats every attacker, whatever its rank, and stays. Nothing clears it: the Engineer used to (before rules version 6) and no longer does. A Major that digs in becomes one.
_Avoid_: bomb, mine (in UI copy), defuse

**Depot**:
The square in each Army's base that the enemy raids. A one-square step onto it claims it once per Match and banks a Two-Step Turn. Jumps, wadi crossings, Recon runs, Rescues and the Dust Storm never claim one.
_Avoid_: base, flag square

**Two-Step Turn**:
A turn of two steps instead of one, banked by raiding the enemy Depot and spent before moving. Each step is one square for every piece; no Jump, wadi crossing, run or power except Become a Spy.
_Avoid_: double move, extra turn

**Dust Storm**:
Once per Match, on a turn between the 10th and the 18th, a random row or column with at least two pieces drifts one square. It is blind to rank and never claims a Depot.
_Avoid_: sandstorm, shuffle

**Power**:
What a Vanguard rank can do beyond moving one square and attacking. Every rank has one: Spy beats the 10, whichever of the two attacks; Recon runs any distance in a line; Engineer Blasts; Sergeant slides on diagonals; Lieutenant Jumps; Captain steps in 8 directions; Major Digs in; Colonel Rescues; General crosses a wadi; General of the Army Becomes a Spy.
_Avoid_: ability, skill, special

**Blast**:
The Engineer's power. It blows itself up (it leaves the board and is shown) and every piece on the squares around it, the enemy's and its own, turns face up for good. Nothing else is hurt. Uses the turn.
_Avoid_: explosion, defuse

**Jump**:
The Lieutenant's power. Besides its step, it may jump one neighbouring piece, either Army's, straight up, down, left or right onto the empty or enemy-held square right behind it. It can't jump a wadi. (The General's wadi crossing is a different power: it crosses a wadi, not a piece.)
_Avoid_: leap, hop

**Dig in**:
The Major's power. It turns the Major into a Landmine for good; it never moves again. Sealed: the opponent can't tell which piece dug in, and a face-down Dig in is a Pass in public. Counts as a missed turn.
_Avoid_: fortify, bury

**Rescue**:
The Colonel's power. The Colonel blows itself up (it leaves the board and is shown) and its Army's Supply Truck jumps from anywhere onto its square. Everyone sees where the Truck went. Costs no fuel and uses the turn.
_Avoid_: teleport, recall

**Become a Spy**:
The General of the Army's power. It turns into a Spy for good, so it can beat the enemy 10 without trading pieces. Free: it doesn't use the turn, and the Player makes their action in the same turn. Sealed, like Dig in; a switch never has an event of its own unless the piece was already face up.
_Avoid_: disguise, downgrade

**Pass**:
Giving up a Vanguard turn on purpose. A Pass counts as a missed turn: three in a row, Passes and timeouts mixed, lose the Match. It is not a move toward the 200-move cap and is refused inside a Two-Step Turn.
_Avoid_: skip, forfeit

### Backing

**Backing**:
An agreement, accepted by both sides, in which a Backer funds a Player's full entry into one Match. On a win the Backer's entry is returned first and the remainder is split by the share the Backer offered. It cannot be revoked once the Match starts.
_Avoid_: staking (a player), sponsorship, scholarship, loan

**Request**:
A Player's public listing asking to be backed for a game and entry size, shown with their real Match history. It carries no split; Backers answer it with Offers and the Player accepts one.
_Avoid_: application, ask, listing

**Offer**:
A Backer's terms for a Backing, made on one Request: game, entry and the Player's share of the surplus. The Backer chooses whom they back and the Player accepts or declines. There are no public Offers. An Offer holds back an amount of the Backer's Gemas, not particular Gemas; the Gemas are drawn by the **Entry draw** when the backed Match opens. Only Listed Games can be Backed.
_Avoid_: bid, proposal, deal

**Backer**:
The holder of the Gemas that fund a Backing. Only they bear the loss; their own Lock pays back as usual.
_Avoid_: investor, sponsor, staker (as a role in a Backing)

**Player**:
Whoever plays a Match, whether with their own Gemas or under a Backing. A backed Player never owes anything and can never redeem or redirect the Backer's Gemas.
_Avoid_: user, gamer, backee

### Redemption

**Redeem**:
To turn Gemas into their Source asset, possible only as far as the Source Lock's yield has actually been Earned and has reached those Gemas by the **Payout order**. Winning Gemas never shortens the winner's own lock. The Player chooses how many to Redeem and is paid their value less the Yield Fee; Gemas whose yield has not landed can instead be Instant Redeemed. What a Player can Redeem never goes down unless they Redeem or spend it: another holder's Redeem, the Lock owner's Extend, a new fee or an Instant Redeem cannot lower it.
_Avoid_: withdraw, cash out, claim

**Redeem now** (an amount, not an action):
What a Player's Gemas on one chain can be Redeemed for at full value at this moment. The Wallet shows it per chain, with an estimated "ready by" date for the rest.
_Avoid_: available balance

**Payout order**:
The order in which yield that lands on a Source repays that Source's Gemas. Only yield that lands after a Gema exists counts for it.
1. the Platform Fee Gemas;
2. the Studio Fee Gemas of Listed Games;
3. the Leaderboard Fee Gemas;
4. all other Gemas of the Source, in proportion to what is still unpaid;
5. Gemas added by each Extend, one tranche at a time, after everything issued before them, so an Extend never slows an earlier holder.

A Gema keeps its place for life: moving, betting or winning it changes neither its class nor its tranche. The order only changes who is paid first; the Lock's Left to pay back and Unlock Estimate do not change. One Match's fees turn into SOL in weeks instead of up to 12 months.
_Avoid_: priority queue, waterfall, seniority

**Entry draw**:
The program's rule for which Gemas an entry uses: the entrant's own-Sourced Gemas first, then won Gemas in order of planned repayment date, earliest first (the date the Gemas' Lock is projected to finish paying them back). Nobody can choose a different order. The Gemas an opponent wins from you are therefore your fastest ones.
_Avoid_: coin selection, lot picking

**Entry Ticket**:
A half-built entry. When an entry needs more Gemas lines than one transaction fits, the app stages the lines into an Entry Ticket over several transactions and then opens or joins the Match with it. While a Ticket is open the Player's other entries wait; the Player can cancel it, and it expires back to the Player's Gemas untouched. A Player whose free Gemas cover an entry can always enter.
_Avoid_: batch, partial entry

**Instant Redeem**:
Selling Gemas (won or own) to Tesoro's Treasury for their Source asset before the Source's yield has landed. The Yield Fee comes off first, then 25% (the **Instant Redeem Fee**): 1,000 Gemas pay $6.00 now instead of $8.00 later. Of the Instant Redeem Fee, one fifth is owed to the Leaderboard Pool and four fifths are Tesoro's, counted when the Treasury redeems the Gemas it bought. It is an order: the Player requests it, the Gemas wait in the order and cannot be played, and Tesoro fills it, in full or in part, while the Treasury of that asset can pay. The Player may cancel an unfilled order at any time, and an order that nobody fills expires and returns the Gemas. Only free Gemas whose yield has not landed yet are sold; landed Gemas are simply Redeemed (less the Yield Fee), never sold. A Player may sell their own deposit's Gemas too, and chooses how many. What the Source Lock has left to pay back, and its counts, are untouched.
_Avoid_: early withdrawal, cash out, sell (as the action name)

**Treasury**:
Tesoro's own holdings and revenue, one per asset (on Solana, and inside each EVM vault). It collects Tesoro's half of the Yield Fee, fills Instant Redeem orders while it holds enough, is refilled when the Gemas it bought are redeemed (paying the Yield Fee like anyone), and Tesoro may withdraw from it at any time. It is held in the staking token's shares and spends only fees already realised (at cash-out), never what Gema holders of an unlocked Lock are still owed and never the Pool's part. It also tops up a staking-token Lock's Unlock when the custody falls short of the owner's Locked amount (holders' landed shares grew with the pool). Holders carry a slash of the staking token as if they held it themselves; the Treasury does not insure them. Not the Leaderboard Pool, and not a Lock.
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
