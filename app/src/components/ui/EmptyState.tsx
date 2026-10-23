import type { ReactNode } from "react";
import { Bust, type BustName } from "./Character";
import { Busy, Button } from "./primitives";

/**
 * A page that has nothing to show (not found, no data, a missing requirement): the guide's bust, one
 * sentence and one natural-width action. `action` defaults to a Lobby link; pass `null` for none.
 */
export function EmptyState({ title, body, action, bust = "himWaiting" }: { title: string; body: ReactNode; action?: ReactNode; bust?: BustName }) {
  return (
    <section className="cut cut-frame empty-state" aria-labelledby="empty-title">
      <Bust name={bust} width={170} className="empty-state-bust" />
      <div className="empty-state-body">
        <h1 id="empty-title" className="page-title">{title}</h1>
        <p className="meta">{body}</p>
        {action !== null && <div className="empty-state-actions">{action ?? <Button href="/play">Play</Button>}</div>}
      </div>
    </section>
  );
}

/** A match or account page's one-line state: a spinner while it loads (a body ending in an ellipsis), an EmptyState otherwise. */
export function Notice({ title, body }: { title: string; body: string }) {
  if (body.endsWith("…")) {
    return (
      <div className="stack">
        <h1 className="page-title">{title}</h1>
        <Busy>{body}</Busy>
      </div>
    );
  }
  return <EmptyState title={title} body={body} />;
}
