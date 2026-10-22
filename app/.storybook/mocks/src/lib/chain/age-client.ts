// Storybook: the 18+ status answers from the story (`parameters.screen.age`): confirmed unless the story says it is still owed; nothing is sent.
import { screenData } from "../../../../../stories/screens/support/screen";

export const ageCall = async (step: "status" | "confirm"): Promise<boolean> => (step === "confirm" ? true : screenData().age !== "ask");
