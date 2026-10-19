import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, IBM_Plex_Mono, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";
import { GemaDefs } from "@/components/ui/gema";
import { SITE_INDEXABLE, SITE_URL } from "@/lib/site";
import { BRAND } from "@/lib/brand";

const schibsted = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["400", "700", "800", "900"],
  variable: "--font-schibsted",
  display: "swap",
});

const barlow = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["700", "800"],
  variable: "--font-display",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

const DESCRIPTION = "Play now with yield you haven't earned yet. Skill games on Solana; what you lock is never played.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  robots: SITE_INDEXABLE ? undefined : { index: false, follow: false },
  title: BRAND.name,
  description: DESCRIPTION,
  openGraph: { title: BRAND.name, description: DESCRIPTION, siteName: BRAND.name, type: "website" },
  twitter: { card: "summary_large_image", title: BRAND.name, description: DESCRIPTION },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0C0E10",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${schibsted.variable} ${barlow.variable} ${plexMono.variable}`}>
      <body>
        <GemaDefs />
        {children}
      </body>
    </html>
  );
}
