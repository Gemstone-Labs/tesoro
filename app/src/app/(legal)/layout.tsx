import "@/components/ui/ui.css";
import "@/components/docs/docs.css";
import "@/components/legal/legal.css";
import { ThemeBoot } from "@/components/landing/ThemeBoot";

/** Terms and Privacy: static reading pages with the docs' themes, none of the app's providers. */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ThemeBoot />
      {children}
    </>
  );
}
