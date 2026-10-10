import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EnterMatch, type EnterKind } from "@/components/match/EnterMatch";
import { MatchRoute } from "@/components/match/MatchRoute";
import { setSpectated } from "../../components/support/spectated";
import { LAYERS, resetFlow, setFlowFrame, type Frame } from "./flow-store";
import { setScreenData } from "./screen";
import "./flow.css";

export interface Flow {
  title: string;
  /** The page the Lobby's Enter button (or a Challenge link) opens. */
  enter: EnterKind;
  /** Built on mount, so countdowns and deadlines are relative to now. */
  frames: () => Frame[];
}

/**
 * Plays a Match from the Enter button to the result on the real pages (EnterMatch, MatchRoute and
 * the Game's Match view), one step at a time. The dock lists every step, what runs underneath and
 * where; the chain mocks answer each step as the story reaches it.
 */
export function FlowPlayer({ flow, autoplay = true, speed = 1 }: { flow: Flow; autoplay?: boolean; speed?: number }) {
  const frames = useMemo(() => flow.frames(), [flow]);
  const [i, setI] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [playing, setPlaying] = useState(autoplay);
  const [open, setOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 720);
  const page = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const frame = frames[i];
  const last = frames.length - 1;

  // The mocks read these while the page renders and polls.
  setScreenData(frame.screen ?? {});
  setSpectated(frame.match);

  useLayoutEffect(() => setFlowFrame(frame), [frame]);
  useEffect(() => resetFlow, []);

  const go = (j: number) => {
    if (j < 0 || j > last || j === i) return;
    // Stepping forward keeps the page mounted so it moves on by itself; any other jump starts it afresh.
    if (j !== i + 1 || frames[j].remount) setEpoch((e) => e + 1);
    setI(j);
  };

  const [autoplayArg, setAutoplayArg] = useState(autoplay);
  if (autoplay !== autoplayArg) {
    setAutoplayArg(autoplay);
    setPlaying(autoplay);
  }
  const running = playing && i < last;

  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => go(i + 1), (frame.ms ?? 3200) / speed);
    return () => clearTimeout(t);
    // go only reads state this effect already depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, i, speed]);

  useEffect(() => {
    if (!frame.click) return;
    const t = setInterval(() => {
      const b = [...(page.current?.querySelectorAll("button") ?? [])].find((el) => el.textContent?.includes(frame.click!));
      if (b) {
        b.click();
        clearInterval(t);
      }
    }, 150);
    return () => clearInterval(t);
  }, [frame, epoch]);

  useEffect(() => {
    list.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: "nearest" });
  }, [i, open]);

  return (
    <>
      <div ref={page} key={epoch}>
        {frame.show === "enter" ? <EnterMatch {...flow.enter} /> : <MatchRoute matchId={frame.match!.id.toString()} />}
      </div>
      <aside className="sbf" aria-label="Match flow steps">
        <header className="sbf-head">
          <strong>{flow.title}</strong>
          <button type="button" className="sbf-btn" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide steps" : "Show steps"}
          </button>
        </header>
        <div className="sbf-url" title="Address bar">
          {frame.url}
        </div>
        <div className="sbf-controls">
          <button type="button" className="sbf-btn" onClick={() => go(0)} disabled={i === 0} aria-label="First step">
            ⏮
          </button>
          <button type="button" className="sbf-btn" onClick={() => go(i - 1)} disabled={i === 0} aria-label="Previous step">
            ◀
          </button>
          <button type="button" className="sbf-btn sbf-play" onClick={() => (i >= last ? (go(0), setPlaying(true)) : setPlaying(!running))}>
            {running ? "Pause" : i >= last ? "Replay" : "Play"}
          </button>
          <button type="button" className="sbf-btn" onClick={() => go(i + 1)} disabled={i >= last} aria-label="Next step">
            ▶
          </button>
          <span className="sbf-count">
            {i + 1} / {frames.length}
          </span>
        </div>
        {open ? (
          <ol className="sbf-steps" ref={list}>
            {frames.map((f, j) => (
              <li key={j} aria-current={j === i ? "step" : undefined} data-done={j < i || undefined}>
                <button type="button" onClick={() => go(j)}>
                  <span className="sbf-n">{j + 1}</span>
                  <span className="sbf-label">{f.label}</span>
                </button>
                {j === i && (
                  <div className="sbf-detail">
                    <div className="sbf-layers">
                      {f.layers.map((l) => (
                        <span key={l} className="sbf-layer" data-layer={l}>
                          {LAYERS[l]}
                        </span>
                      ))}
                    </div>
                    <p>{f.what}</p>
                    {f.calls && (
                      <ul className="sbf-calls">
                        {f.calls.map((c) => (
                          <li key={c}>
                            <code>{c}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="sbf-now">{frame.label}</p>
        )}
      </aside>
    </>
  );
}
