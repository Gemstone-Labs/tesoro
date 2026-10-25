# 0014: Journal sponsor reservations by generation before broadcast

Status: accepted for implementation; runtime rollout requires the database and every sponsor writer to move together.

## Context

The app reserves lamports for completing a Match or Entry Ticket. The keeper can physically close either without going
through the app. A Ticket can also become a Match Pot, and its address can be reused after closure. A settlement record
freezes a result before physical closure and does not prove that rent was returned.

## Decision

Keep usage counters and policy limits unchanged. Give every `sponsor_hold` an immutable UUID generation, including
existing rows. Store the signed transaction, signature, newly acquired reservations and the exact generations of its
close targets in `sponsor_completion` before broadcasting. The journal covers admissions that create/ensure a reserve
and physical closes; unrelated sponsored moves do not need a journal entry.

Prepare and finish are atomic RPCs using one transaction-level advisory lock. Creating a Match or Ticket cannot adopt
an existing reservation. Joining a Match can use its existing reservation only once its originating admission is resolved
and while no close of that generation is pending. Retrying a signature preserves its original generation snapshot and
signed bytes. A completed journal is terminal; a failed signature cannot be prepared again.

The app and keeper reconcile through the same code. Only a finalized successful transaction whose executed Core
instruction names the target in a physical-close role, with positive pre-balance and zero post-balance, releases its
captured generation. `close_match` includes the Match and both consumed Ticket/Pot addresses; `close_ticket` includes
the cancelled Ticket. A finalized failure releases only reservations newly acquired by that transaction. No receipt,
settlement event, TTL or current account absence authorizes cleanup. Repeated reconciliation cannot delete a newer hold.

An original sender's definite preflight rejection can cancel its newly acquired reserves only if neither a duplicate
submit nor a recovery worker has claimed the same journal. Both claims and this rejection check use the same database
lock. Once another worker might broadcast, that rejection is uncertain and cannot retire the reservation.

Recovery rotates pending entries, including accounts no longer in the keeper's inventory. If a transaction is not yet
finalized and its blockhash remains valid, recovery may rebroadcast the exact saved bytes. Signature deduplication
prevents a second execution. Expired transactions unavailable from the RPC remain reserved until authoritative evidence
can be obtained; there is deliberately no address sweep or timeout refund.

Self-paying clients can close sponsored Tickets without passing through either sender. The keeper also observes closes
against a snapshot of a live reservation's generation and originating admission signature. That finalized admission must
name the address in an exact Core create/ensure role and leave it funded. A later finalized physical close with positive
pre-balance and zero post-balance can retire only that generation and origin, with an audit record written atomically.
Same-slot ordering requires the signatures' positions in the finalized block; address-history order is insufficient.
Missing transactions or block positions retain the reservation. A durable per-generation cursor advances only through
fully examined history pages, so unrelated transactions cannot permanently push a close beyond a fixed scan limit.

This proof depends on two current Core rules: Match IDs use a permanent increasing `next_match` counter, while a new
sponsored Ticket cannot adopt an existing reservation. A self-paid Ticket recreation therefore cannot turn the old reserve
into a new sponsored lifecycle. Legacy rows without an originating signature remain outside this observer and need a
generation captured before closure or separately reviewed historical provenance.

## Rollout and rollback

Migration `0017` is additive and leaves the history migrations `0015`/`0016` untouched. Existing reservations retain their
amounts and creation times. Journal tables and RPCs are service-role only. Revoke direct service-role writes to
`sponsor_hold` so legacy address-only deletes and upserts fail closed.

Drain sponsor submissions and stop keeper writers before migration. Snapshot reservations, apply only the reviewed
migration in a transaction with bounded lock/statement timeouts, then deploy the compatible app and keeper before
resuming writers. Do not bulk-apply other pending migrations. Reconcile each legacy hold through a captured physical
close; already missing accounts require separately reviewed historical evidence, never an inferred generation.

On a failed rollout, retain the schema and reservations, stop admissions and keep compatible recovery available. Restoring
old table-write privileges or running an old app as the writer would reintroduce the unsafe cleanup and is not a rollback.
Before release acceptance, exercise ordinary sponsored Match and Entry Ticket cycles through the persistent database,
record generation-specific before/after rows, rent and Gema totals, and unchanged Player SOL. Isolated database replay
and in-process authentication are different evidence from a deployed signed-in flow.
