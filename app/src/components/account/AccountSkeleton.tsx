import { SkeletonCards } from "@/components/ui";

/** The Account page's own shape while it loads: hero, the three figure panels, then history rows. */
export function AccountSkeleton() {
  return (
    <div className="pa" aria-busy="true">
      <header className="cut cut-frame pa-hero skel" aria-hidden="true">
        <span className="cut cut-btn skel-av pa-avatar" />
        <div className="pa-who skel-lines">
          <span className="skel-line" style={{ width: "22%" }} />
          <span className="skel-line lg" style={{ width: "34%", height: 34 }} />
          <span className="skel-line" style={{ width: "58%" }} />
        </div>
      </header>
      <div className="pa-board" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="cut cut-card pa-panel skel">
            <span className="skel-lines">
              <span className="skel-line" style={{ width: "40%" }} />
              <span className="skel-line lg" style={{ width: "62%", height: 30 }} />
              <span className="skel-line" style={{ width: "78%" }} />
            </span>
          </div>
        ))}
      </div>
      <div className="mh-list">
        <SkeletonCards count={3} avatar={false} className="mh-skel" label="Loading this Account…" />
      </div>
    </div>
  );
}
