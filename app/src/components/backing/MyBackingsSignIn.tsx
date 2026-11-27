import { Button, Card } from "@/components/ui";

export function MyBackingsSignIn({ onSignIn }: { onSignIn: () => void }) {
  return (
    <Card large as="section" aria-label="Sign in to see your Backings">
      <div className="stack">
        <p className="meta">Your Backings belong to your Account. Sign in to see them.</p>
        <Button block onClick={onSignIn}>Sign in</Button>
      </div>
    </Card>
  );
}
