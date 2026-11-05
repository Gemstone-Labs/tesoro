"use client";

/**
 * The Tells on a Player's phone: a sound per stage (screws, bolt and panel rattle, sparks and creak) and a vibration that
 * grows as the wall nears. Sound follows the shared game sound setting; vibration has Railcar's own setting.
 */
import { createHaptics } from "../block-puzzle/haptics";
import { isMuted, sfx } from "../fx";
import { TELL_HAPTICS, type TellCue } from "./brake";

export const RAILCAR_VIBRATION_KEY = "tesoro.railcar.vibration";

type Haptics = ReturnType<typeof createHaptics>;

export function createTellPlayer(o: { sound: (cue: TellCue) => void; muted: () => boolean; haptics: Haptics }): (cues: TellCue[]) => void {
  return (cues) => {
    for (const cue of cues) {
      if (!o.muted()) o.sound(cue);
      o.haptics.pulse(TELL_HAPTICS[cue]);
    }
  };
}

export const railcarHaptics = createHaptics(
  () => (typeof window === "undefined" ? null : window.localStorage),
  () => (typeof navigator !== "undefined" && typeof navigator.vibrate === "function" ? navigator.vibrate.bind(navigator) : undefined),
  RAILCAR_VIBRATION_KEY,
);

export const playTells = createTellPlayer({ sound: (cue) => sfx(cue), muted: isMuted, haptics: railcarHaptics });
