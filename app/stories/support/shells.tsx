import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { DocsHeader } from "@/components/docs/DocsHeader";
import { NavList } from "@/components/docs/NavList";
import { TocRail } from "@/components/docs/TocRail";

/** Which route-group layout wraps a story: `parameters.shell`. */
export type Shell = "none" | "app" | "marketing" | "docs";

/** Mirrors src/app/(docs)/layout.tsx, without the ThemeBoot script (the toolbar sets the theme). */
function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="docs">
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

export function ShellFor({ shell, children }: { shell: Shell; children: ReactNode }) {
  if (shell === "app") return <AppShell>{children}</AppShell>;
  if (shell === "docs") return <DocsLayout>{children}</DocsLayout>;
  return <>{children}</>;
}
