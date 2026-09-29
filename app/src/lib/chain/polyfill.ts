import { Buffer } from "buffer";

// @coral-xyz/anchor and chain.ts use the Node global; the browser bundle has none.
const g = globalThis as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;
