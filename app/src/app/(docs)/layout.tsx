import type { Metadata } from "next";
import "@/components/ui/ui.css";
import "@/components/docs/docs.css";
import "@/components/docs/docs-visual.css";
import { DocsHeader } from "@/components/docs/DocsHeader";
import { NavList } from "@/components/docs/NavList";
import { TocRail } from "@/components/docs/TocRail";
import { ThemeBoot } from "@/components/landing/ThemeBoot";

export const metadata: Metadata = {
  title: { default: "Docs · Tesoro", template: "%s · Tesoro Docs" },
  description: "How Tesoro works, in plain words for players and in full detail for developers.",
};

/** Docs: static pages with the landing's light and dark themes, none of the app's providers or chain calls. */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="docs">
      <ThemeBoot />
      <a className="docs-skip" href="#docs-main">
        Skip to content
      </a>
      <DocsHeader />
      <div className="docs-grid">
        <aside className="docs-side" aria-label="Docs contents">
          <NavList />
        </aside>
        <main id="docs-main" className="docs-main">
          {children}
          <footer className="docs-foot">
            <p>Test mode · simulated yield · 1 month = 10 min · nothing here has value</p>
          </footer>
        </main>
        <TocRail />
      </div>
    </div>
  );
}
