import "@/components/ui/ui.css";
import "@/components/ui/page.css";
import "@/components/shell/shell.css";
import "@/components/lobby/lobby.css";
import { AccountProvider } from "@/lib/auth/AccountProvider";
import { ChainDataProvider } from "@/lib/chain/ChainDataProvider";
import { InviteGate } from "@/components/account/InviteEntry";
import { AppShell } from "@/components/shell/AppShell";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <AccountProvider>
      <ChainDataProvider>
        <AppShell>
          <InviteGate>{children}</InviteGate>
        </AppShell>
      </ChainDataProvider>
    </AccountProvider>
  );
}
