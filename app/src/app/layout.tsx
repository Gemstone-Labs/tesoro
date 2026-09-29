import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";
import "@/components/ui/ui.css";
import { AccountProvider } from "@/lib/auth/AccountProvider";
import { GemaDefs } from "@/components/ui";
import { AppHeader } from "@/components/shell/AppHeader";
import { BottomNav } from "@/components/shell/BottomNav";

const schibsted = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["400", "700", "800", "900"],
  variable: "--font-schibsted",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Tesoro",
  description: "Play now with the staking yield you haven't earned yet.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0C0E10",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${schibsted.variable} ${plexMono.variable}`}>
      <body>
        <GemaDefs />
        <AccountProvider>
          <AppHeader />
          <main className="app-main">{children}</main>
          <BottomNav />
        </AccountProvider>
      </body>
    </html>
  );
}
