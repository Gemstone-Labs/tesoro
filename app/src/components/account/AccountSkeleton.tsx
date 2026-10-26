import { MatchBannerSkeleton } from "@/components/match/MatchBanner";

/** The Account page's own shape while it loads: the tall profile card, the Gemas panel, then Recent Matches. */
export function AccountSkeleton() {
  return (
    <div className="pa" aria-busy="true">
      <header className="cut cut-frame pa-hero skel" aria-hidden="true">
        <div className="pa-top">
          <div className="pa-id">
            <span className="cut cut-btn skel-av pa-avatar" />
            <div className="pa-who skel-lines">
              <span className="skel-line lg" style={{ width: "50%", height: 30 }} />
              <span className="skel-line" style={{ width: "36%" }} />
            </div>
          </div>
        </div>
        <div className="pa-facts">
          <span className="skel-line" style={{ width: "62%" }} />
        </div>
      </header>
      <div className="cut cut-card pa-panel skel" aria-hidden="true">
        <span className="skel-lines">
          <span className="skel-line" style={{ width: "40%" }} />
          <span className="skel-line lg" style={{ width: "62%", height: 30 }} />
          <span className="skel-line" style={{ width: "78%" }} />
        </span>
      </div>
      <MatchBannerSkeleton count={3} label="Loading this Account…" />
    </div>
  );
}
