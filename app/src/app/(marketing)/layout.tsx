import "@/components/ui/ui.css";
import "@/components/landing/landing.css";
import "@/components/landing/games.css";
import "@/components/landing/money.css";
import { ThemeBoot } from "@/components/landing/ThemeBoot";

/** The marketing pages: shared tokens and fonts, none of the app's providers or shell. */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ThemeBoot />
      {children}
    </>
  );
}
