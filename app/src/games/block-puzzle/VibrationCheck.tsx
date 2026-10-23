"use client";

import { useEffect, useRef, useState } from "react";
import { blockHaptics, type HapticResult } from "./haptics";

const explanations: Record<HapticResult, string> = {
  accepted: "Did you feel the test pulse? The browser accepted the request, but only you can confirm the vibration.",
  blocked: "The browser declined the vibration request. Try again after tapping Test vibration, or compare in another browser.",
  unavailable: "This browser does not offer vibration to this app. Visual feedback will still work.",
  error: "The browser could not send the vibration request. Try again, or compare in another browser.",
  off: "Game vibration is switched off. The test pulse works independently of that setting.",
};

/** Explicit physical check: API acceptance never claims the phone's motor worked. */
export function VibrationCheck({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [result, setResult] = useState<HapticResult | null>(null);
  const [felt, setFelt] = useState<boolean | null>(null);
  const [details, setDetails] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);
  const test = () => {
    setFelt(null);
    setResult(blockHaptics.test());
    setDetails(`API: ${blockHaptics.supported() ? "available" : "unavailable"}; page: ${document.visibilityState}; user activation: ${navigator.userActivation ? navigator.userActivation.hasBeenActive ? "yes" : "no" : "unknown"}; game vibration: ${blockHaptics.enabled() ? "on" : "off"}; test: 160 ms.`);
  };
  return <dialog ref={dialog} className="bp-vibration-check" aria-labelledby="bp-vibration-title" onCancel={onClose}>
    <h2 id="bp-vibration-title">Test vibration</h2>
    <p>Tap below for one clear pulse. Hold the phone in your hand.</p>
    <button type="button" className="cut cut-btn btn" onClick={test} autoFocus>Send test pulse</button>
    {result && <>
      <p role="status">{felt === true ? "Vibration confirmed on this phone." : felt === false ? "No vibration felt. Check Silent / Do Not Disturb and the phone’s vibration settings, then retry. If it still does not respond, compare in another browser." : explanations[result]}</p>
      {result === "accepted" && felt === null && <div className="bp-vibration-answers">
        <button type="button" className="cut cut-btn btn neutral" onClick={() => setFelt(true)}>I felt it</button>
        <button type="button" className="cut cut-btn btn neutral" onClick={() => setFelt(false)}>Nothing happened</button>
      </div>}
      <details><summary>Test details</summary><p>{details} Result: {result}.</p></details>
    </>}
    <button type="button" className="cut cut-btn btn neutral" onClick={onClose}>Back to game</button>
  </dialog>;
}
