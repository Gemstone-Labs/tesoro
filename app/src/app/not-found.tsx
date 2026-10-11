import "@/components/ui/ui.css";
import "@/components/ui/page.css";
import "@/components/shell/shell.css";
import "@/components/lobby/lobby.css";
import { AccountProvider } from "@/lib/auth/AccountProvider";
import { ChainDataProvider } from "@/lib/chain/ChainDataProvider";
import { AppShell } from "@/components/shell/AppShell";
import { PageNotFound } from "@/components/shell/PageNotFound";

/** Not-found renders outside the (app) layout, so it brings the app shell itself. */
export default function NotFound() {
  return (
    <AccountProvider>
      <ChainDataProvider>
        <AppShell>
          <PageNotFound />
        </AppShell>
      </ChainDataProvider>
    </AccountProvider>
  );
}
