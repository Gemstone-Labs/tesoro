# Block Burst interaction prototype

Run `pnpm prototype:block-burst` from `app/`, then open `http://localhost:3393`.

This is a separate Vite entry on a throwaway branch. Production routes never import it. It uses the existing board/piece CSS, sounds, vibration and competitive engine without modifying them. Synthetic starting boards are local fixtures and cannot submit a Match.

Compare **A Current** with **B Measured**, or isolate **Motion only** and **Score only**. Reset repeats the same board and pieces. Four fixtures cover pickup, invalid drops, ordinary placement, one clear, consecutive clears and clear/place/clear. Dashed cells identify guided targets; free play also works. The90-second limit starts at first pickup.

The motion candidate uses board-bottom/tray-center pickup and1.5× relative touch travel. Score credit separates placement points from the pending clear bonus. Both use the same renderer and retained clear/effect timings, so A is a reproduction of current mapping/timing rather than production app performance. Competitive score arithmetic, seeded pieces and combo-reset policy stay unchanged.

Correctness checks establish state and presentation behavior. Actual phone interaction and subjective acceptance require comparison on the Seeker in Brave/home-screen mode.
