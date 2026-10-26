import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ListingView } from "./ListingView";

describe("Studio listing controls", () => {
  it.each([false, true])("offers payment without a disconnected featured control (featured=%s)", (featured) => {
    const html = renderToStaticMarkup(
      <ListingView reply={{ now: 1_800_000_000, yearUsd: 500, applications: [{
        id: 1, programId: "11111111111111111111111111111111", studio: "Example Studio",
        gameName: "Example Game", contactEmail: "studio@example.com", site: null, blurb: "",
        status: "accepted", featured, note: null, paidUntil: null, createdAt: 1_799_000_000, payments: [],
      }] }} />,
    );
    expect(html).toContain("Record $500 for 1 year");
    expect(html).not.toMatch(/Feature in the Lobby|Stop featuring|Showing in the Lobby/);
  });
});
