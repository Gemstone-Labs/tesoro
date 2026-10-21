import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useRef, useState } from "react";
import { Arena, burstAt, Callout, Countdown, CUES, MuteToggle, shake, sfx, useReducedMotion, type ArenaGame, type BurstKind, type CalloutTone } from "@/games/fx";
import "./motion.css";

const JEWELS = ["#ffb43a", "#3fc6ff", "#ff4d9b", "#9d74ff"];

function Demo({ game }: { game: ArenaGame }) {
  const target = useRef<HTMLDivElement>(null);
  const [callout, setCallout] = useState<{ text: string; tone: CalloutTone; n: number } | null>(null);
  const [count, setCount] = useState(0);
  const reduced = useReducedMotion();

  const burst = (kind: BurstKind, colors = JEWELS) => target.current && burstAt(target.current, { colors, kind, count: kind === "sparks" ? 30 : 24 });
  const say = (text: string, tone: CalloutTone = "plain") => setCallout({ text, tone, n: Date.now() });

  return (
    <Arena game={game}>
      <div style={{ padding: 24, minHeight: 520, display: "grid", gap: 20, alignContent: "start", position: "relative" }}>
        <div className="sbm-row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Game FX · {game}{reduced ? " · reduced motion" : ""}</h2>
          <MuteToggle />
        </div>

        <div className="sbm-panel">
          <p className="meta">Sound cues (click once on the page first so the browser allows audio; the speaker mutes).</p>
          <div className="sbm-btns" style={{ flexWrap: "wrap" }}>
            {CUES.map((c) => (
              <button key={c} type="button" className="sbm-btn" onClick={() => sfx(c)}>
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="sbm-panel">
          <p className="meta">Bursts and shake act on the board below.</p>
          <div className="sbm-btns" style={{ flexWrap: "wrap" }}>
            <button type="button" className="sbm-btn" onClick={() => { burst("shards"); sfx("clear"); }}>Shards</button>
            <button type="button" className="sbm-btn" onClick={() => { burst("shards", ["#6af8d6", "#2dbe8c"]); sfx("gem"); }}>Gem shards</button>
            <button type="button" className="sbm-btn" onClick={() => burst("sparks", ["#eaefec", "#8aa0bd"])}>Sparks</button>
            <button type="button" className="sbm-btn" onClick={() => burst("confetti")}>Confetti</button>
            <button type="button" className="sbm-btn" onClick={() => shake(target.current, 0.3)}>Shake light</button>
            <button type="button" className="sbm-btn" onClick={() => { shake(target.current, 1); sfx("combo"); }}>Shake hard</button>
          </div>
          <div ref={target} className="cut" style={{ marginTop: 16, height: 120, background: "rgba(23, 30, 37, 0.9)", display: "grid", placeItems: "center", position: "relative" }}>
            <span className="meta">Board</span>
            {callout && <Callout key={callout.n} text={callout.text} tone={callout.tone} onDone={() => setCallout(null)} />}
          </div>
          <div className="sbm-btns" style={{ flexWrap: "wrap", marginTop: 12 }}>
            <button type="button" className="sbm-btn" onClick={() => say("Double!")}>Callout</button>
            <button type="button" className="sbm-btn" onClick={() => say("Line going up", "up")}>Callout up</button>
            <button type="button" className="sbm-btn" onClick={() => say("Line going down", "down")}>Callout down</button>
            <button type="button" className="sbm-btn" onClick={() => say("Gem ×2", "gem")}>Callout gem</button>
            <button type="button" className="sbm-btn" onClick={() => say("Last ten seconds", "warn")}>Callout warn</button>
          </div>
        </div>

        <div className="sbm-panel" style={{ position: "relative", minHeight: 220 }}>
          <button type="button" className="sbm-btn primary" onClick={() => setCount((c) => c + 1)}>Start countdown</button>
          {count > 0 && <Countdown key={count} />}
        </div>
      </div>
    </Arena>
  );
}

const meta = {
  title: "Motion/Game FX",
  component: Demo,
  parameters: { layout: "fullscreen" },
  args: { game: "block-puzzle" },
  argTypes: { game: { control: "inline-radio", options: ["block-puzzle", "holdem", "trading-duel"] } },
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Block Burst arena: violet and sky at the edges. Every cue, burst, shake, callout and the 3-2-1 countdown. */
export const BlockPuzzle: Story = {};
export const Holdem: Story = { args: { game: "holdem" } };
export const Trading: Story = { args: { game: "trading-duel" } };
