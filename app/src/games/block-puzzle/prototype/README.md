# Block Burst interaction prototype

Run `pnpm prototype:block-burst` from `app/`, then open `http://localhost:3393`.

This is a separate Vite entry on a throwaway branch. Production routes never import it. It uses the existing board/piece CSS, sounds, vibration and competitive engine without modifying them. Synthetic starting boards are local fixtures and cannot submit a Match.

Compare **A Before** with **B Updated**, or isolate **Original mapping**, **Motion only** and **Score only**. A preserves the initial improved B's visible mapping/feedback behavior; both use the improved preview renderer, so this is not a historical performance benchmark. Reset repeats the same board and pieces. Four fixtures cover pickup, invalid drops, ordinary placement, one clear, consecutive clears and clear/place/clear. Dashed cells identify guided targets; free play also works. The90-second limit starts at first pickup.

The motion candidate uses board-bottom/tray-center pickup and1.5× relative touch travel. B uses occupied-cell-center snapping, bounded retention of a legal landing and release into the visible preview. The retention radius is a source-backed experiment; the reference's active configuration is unproven. Preview classes update only when the target changes. Same-width viewport changes preserve the gesture; rotation/width changes and focus loss cancel it. Score credit separates placement points from the pending clear bonus. Competitive score arithmetic, seeded pieces, combo-reset policy and clear/effect timings stay unchanged.

B also adds a connected completion lane and a persistent gold rim during the final10seconds, stronger below5. Open **Comparison and event record → Try final10seconds** to inspect it immediately; Reset restores the90-second fixture. Reduced motion keeps the cue steady.

Correctness checks establish state and presentation behavior. Actual phone interaction and subjective acceptance require comparison on the Seeker in Brave/home-screen mode.
