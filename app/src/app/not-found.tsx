import "@/components/ui/ui.css";
import "@/components/ui/page.css";
import "@/components/shell/shell.css";
import "@/components/lobby/lobby.css";
import { AccountProvider } from "@/lib/auth/AccountProvider";
import { ChainDataProvider } from "@/lib/chain/ChainDataProvider";
import { AppShell } from "@/components/shell/AppShell";
import { Button, EmptyState } from "@/components/ui";

/** Any address with no page: the app shell around one sentence and the two ways back in. */
export default function NotFound() {
  return (
    <AccountProvider>
      <ChainDataProvider>
        <AppShell>
          <EmptyState
            title="Page not found"
            body="There is nothing at this address. It may have moved, or the link is incomplete."
            action={
              <>
                <Button variant="money" href="/lobby">Lobby</Button>
                <Button href="/play">Play</Button>
              </>
            }
          />
        </AppShell>
      </ChainDataProvider>
    </AccountProvider>
  );
}
