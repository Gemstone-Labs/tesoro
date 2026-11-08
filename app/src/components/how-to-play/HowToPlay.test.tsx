import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GUIDE_STEPS } from "@/lib/how-to-play";
import { usePracticeHowTo } from "./PracticeGuide";
import { HowToPlay } from "./HowToPlay";
import { lastStepButton, stepAfterKey } from "./guide-nav";

describe("guide navigation", () => {
  it("moves with the arrow keys and stops at both ends", () => {
    expect(stepAfterKey("ArrowRight", 0, 5)).toBe(1);
    expect(stepAfterKey("ArrowRight", 4, 5)).toBe(4);
    expect(stepAfterKey("ArrowLeft", 0, 5)).toBe(0);
    expect(stepAfterKey("ArrowLeft", 3, 5)).toBe(2);
    expect(stepAfterKey("a", 2, 5)).toBe(2);
  });

  it("ends with Back and the button of where the guide was opened", () => {
    expect(lastStepButton("game-page")).toBe("Done");
    expect(lastStepButton("first-practice")).toBe("Start practice");
    expect(lastStepButton("practice-menu")).toBe("Done");
  });
});

describe("HowToPlay markup", () => {
  const render = (open: boolean) => renderToStaticMarkup(<HowToPlay game="holdem" open={open} onClose={() => {}} end="game-page" />);

  it("opens on step 1 of 5 with the phone clip set, one dot per step", () => {
    const html = render(true);
    expect(html).toContain(GUIDE_STEPS.holdem[0].title);
    expect(html).toContain("Step 1 of 5");
    expect(html).toContain("/art/how-to-play/holdem/1-phone.webm");
    expect(html).not.toContain("/art/how-to-play/holdem/2-phone.webm");
    expect(html.match(/<i><b /g)).toHaveLength(5);
    expect(html).toContain("How to play Buckshot Hold");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*?Back/);
  });

  it("renders nothing inside while closed", () => {
    expect(render(false)).not.toContain("htp-clip");
  });

  it("gives the pause card a How to play item", () => {
    let label = "";
    function Probe() { label = usePracticeHowTo("vanguard").item.label; return null; }
    renderToStaticMarkup(<Probe />);
    expect(label).toBe("How to play");
  });
});
