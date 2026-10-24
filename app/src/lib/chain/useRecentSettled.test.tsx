import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { useRecentSettled } from "./useRecentSettled";

it("reserves Live wins on the first render before the query subscribes", () => {
  function Probe() {
    const { loading, matches } = useRecentSettled(12);
    return <span>{loading ? "loading" : `loaded ${matches.length}`}</span>;
  }
  expect(renderToStaticMarkup(<Probe />)).toBe("<span>loading</span>");
});
