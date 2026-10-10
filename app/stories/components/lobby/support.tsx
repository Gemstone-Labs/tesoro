import type { Decorator } from "@storybook/nextjs-vite";
import { withScreen } from "../../screens/support/screen";

/** The Lobby's own container (its CSS sizes rails by container width), inside the app shell. */
export const inLobby: Decorator = (Story) => (
  <div className="lobby">
    <Story />
  </div>
);

export const lobbyDecorators = [withScreen, inLobby];
