import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? cssFiles(path) : name.endsWith(".css") ? [path] : [];
  });
}

/** Stylesheets are global: a page's root class defined in two files makes one page wear the other's layout after a client navigation. */
describe("page root classes", () => {
  it.each(["wl"])(".%s is styled by one stylesheet only", (name) => {
    const bare = new RegExp(`(^|[,}{\\s])\\.${name}(?=[\\s,{:])`, "m");
    const owners = cssFiles(join(__dirname, "..")).filter((f) => bare.test(readFileSync(f, "utf8")));
    expect(owners, `${name} is defined in: ${owners.join(", ")}. Give one page its own class name.`).toHaveLength(1);
  });
});
