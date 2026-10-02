import "@/components/ui/ui.css";
import "@/components/ui/page.css";
import "@/components/shell/shell.css";
import "@/components/lobby/lobby.css";
import { AccountProvider } from "@/lib/auth/AccountProvider";
import { ChainDataProvider } from "@/lib/chain/ChainDataProvider";
import { AppShell } from "@/components/shell/AppShell";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <AccountProvider>
      <ChainDataProvider>
        <AppShell>{children}</AppShell>
      </ChainDataProvider>
    </AccountProvider>
  );
}
