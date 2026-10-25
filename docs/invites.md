# Invite emails

Mainnet is invite-only until the public launch (ADR 0012). The founders email Invites to waitlist members in batches.

```
export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RESEND_API_KEY=... NOTIFY_FROM="Tesoro <hello@mail.playtesoro.com>"
pnpm --filter @tesoro/keeper exec tsx ../app/scripts/send-invites.ts --limit 20           # dry run (default)
pnpm --filter @tesoro/keeper exec tsx ../app/scripts/send-invites.ts --limit 20 --send    # creates Invites and emails them
```

- Members go oldest sign-up first. `--limit N` takes the first N still eligible.
- The dry run prints who would get an Invite and the email text with a redacted code. It sends and writes nothing, and needs no email keys.
- `--send` creates one Invite per member (code from `newInviteCode`, stored as a hash with the member's email), emails it, then records `sent_at` on the Invite. It pauses between sends to stay under Resend's rate limit.
- The link is `https://www.playtesoro.com/play?invite=CODE` (override the origin with `INVITE_SITE_URL`). The Invite screen reads `?invite=` and fills the code in.
- Members who already redeemed are skipped. Members who were already sent an Invite are skipped too.
- `--resend` issues a fresh code to members who already got one. Only the hash is stored, so the old code cannot be re-sent; instead the old unused code is deleted once the new email is out. A member therefore never holds two working codes, and a failed send leaves the old code working. (Storing codes encrypted would add a key to protect for no gain.)
- Exit code is 1 when any send failed; run again to retry just those members.

Migration `0004_invite_sent_at.sql` adds `invites.sent_at`; apply it before the first `--send`.
