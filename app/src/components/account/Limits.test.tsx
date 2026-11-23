import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { LimitsView, type LimitsViewProps } from "./Limits";

const noop = () => undefined;
const props: LimitsViewProps = { entry: null, extend: null, away: null, now: 0, busy: null, error: null, onSetEntry: noop, onSetExtend: noop, onStartBreak: noop, onStartSelfExclusion: noop, onRetry: noop };
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("starting a Break or Self-Exclusion while a Railcar car boards (Q40 review #2)", () => {
  it("when the step-off failed the Player is told they are still in the car, with the way to Step off", () => {
    const h = renderToStaticMarkup(<LimitsView {...props} stillBoarding />);
    expect(text(h)).toContain("You are still in a Railcar car: Step off");
    expect(h).toMatch(/<a href="\/play\/railcar">Step off<\/a>/);
  });

  it("says nothing when the step-off went through or there was no car", () => {
    expect(text(renderToStaticMarkup(<LimitsView {...props} />))).not.toContain("still in a Railcar car");
  });
});
