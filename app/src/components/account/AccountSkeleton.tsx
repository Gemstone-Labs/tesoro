import { SkeletonCards } from "@/components/ui";

/** The Account page's own shape while it loads: banner hero, the three figure panels, then history rows. */
export function AccountSkeleton() {
  return (
    <div className="pa" aria-busy="true">
      <header className="cut cut-frame pa-hero skel" aria-hidden="true">
        <div className="pa-banner" />
        <div className="pa-id">
          <span className="cut cut-btn skel-av pa-avatar" />
          <div className="pa-who skel-lines">
            <span className="skel-line lg" style={{ width: "40%", height: 34 }} />
            <span className="skel-line" style={{ width: "24%" }} />
          </div>
        </div>
        <div className="pa-facts skel-lines">
          <span className="skel-line" style={{ width: "52%" }} />
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
