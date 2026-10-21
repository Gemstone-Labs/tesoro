import { DemoHttpError } from "../request-auth";

/** The signed `intent` field is the JSON text of `{ ixs: WireIx[] }`; the signature covers all of it. */
export function parseIntentText(text: string | number | undefined): unknown {
  if (typeof text !== "string" || text.length > 40_000) throw new DemoHttpError(400, "bad-request", "Malformed request.");
  try {
    return JSON.parse(text);
  } catch {
    throw new DemoHttpError(400, "bad-request", "Malformed request.");
  }
}
