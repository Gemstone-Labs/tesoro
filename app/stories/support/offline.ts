// Imported first in .storybook/preview.tsx: app modules that keep a reference to `fetch` when they load
// (the chain client's RPC fetch) must get the blocked one.
import { blockNetwork } from "./network";

blockNetwork();
