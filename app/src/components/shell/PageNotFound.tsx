import { Button, EmptyState } from "@/components/ui";

/** Any address with no page: one sentence and the two ways back in. */
export function PageNotFound() {
  return (
    <EmptyState
      title="Page not found"
      body="There is nothing at this address. It may have moved, or the link is incomplete."
      action={
        <>
          <Button variant="money" href="/play">Play</Button>
          <Button href="/play">Play</Button>
        </>
      }
    />
  );
}
