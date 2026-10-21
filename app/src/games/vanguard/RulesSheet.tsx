"use client";

import { Button } from "@/components/ui";
import { NAMES } from "./rules";
import { POWER_LINES } from "./powers-ui";

/** The in-game ranks sheet: each rank's power in one line, strongest first. */
export function RulesSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="cut cut-frame vg-rules" role="dialog" aria-label="Ranks and powers">
      <h3>Ranks and powers</h3>
      <ol>
        {POWER_LINES.map(([rank, line]) => (
          <li key={rank}>
            <b>{rank}</b>
            <span>
              <span className="vg-rules-name">{NAMES[rank]}.</span> {line}
            </span>
          </li>
        ))}
      </ol>
      <Button onClick={onClose}>Close</Button>
    </div>
  );
}
