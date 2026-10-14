import { describe, expect, it } from "vitest";
import type { InstantLine } from "./fees";
import { isExceedsPending, runInstant } from "./instant-run";

const line = (key: string, gemas: bigint): InstantLine => ({ key, gemas, payout: gemas * 2n });
const race = new Error("Error Message: only Gemas whose yield has not landed can be redeemed instantly; redeem the rest in full.");

describe("isExceedsPending", () => {
  it("spots the program's message, and only that", () => {
    expect(isExceedsPending(race)).toBe(true);
    expect(isExceedsPending(new Error("Not enough SOL"))).toBe(false);
  });
});

describe("runInstant", () => {
  const confirmed = [line("a", 100n), line("b", 50n)];

  it("sends what was confirmed when the fresh read agrees", async () => {
    const sent: string[] = [];
    const out = await runInstant(confirmed, async () => confirmed, async (l) => void sent.push(`${l.key}:${l.gemas}`));
    expect(out).toEqual({ kind: "sent", sent: confirmed });
    expect(sent).toEqual(["a:100", "b:50"]);
  });

  it("an ExceedsPending at send re-reads once; the same plan is sent again", async () => {
    let reads = 0;
    let fail = true;
    const out = await runInstant(
      confirmed,
      async () => (++reads, confirmed),
      async () => {
        if (fail) {
          fail = false;
          throw race;
        }
      },
    );
    expect(reads).toBe(2);
    expect(out.kind).toBe("sent");
  });

  it("when the re-read is smaller nothing more is sent and the new amount comes back", async () => {
    const sent: string[] = [];
    let reads = 0;
    const out = await runInstant(
      confirmed,
      async () => (++reads === 1 ? confirmed : [line("a", 70n), line("b", 50n)]),
      async (l) => {
        if (l.key === "a") throw race;
        sent.push(l.key);
      },
    );
    expect(sent).toEqual([]);
    expect(out).toEqual({ kind: "smaller", gemas: 120n, lines: [line("a", 70n), line("b", 50n)], sent: [] });
  });

  it("never sends more than confirmed, even when the re-read grew", async () => {
    const sent: bigint[] = [];
    let fail = true;
    await runInstant(
      [line("a", 100n)],
      async () => [line("a", 400n)],
      async (l) => {
        if (fail) {
          fail = false;
          throw race;
        }
        sent.push(l.gemas);
      },
    );
    expect(sent).toEqual([100n]);
  });

  it("does not resend lines that already went through", async () => {
    const sent: string[] = [];
    let fail = true;
    await runInstant(confirmed, async () => confirmed, async (l) => {
      if (l.key === "b" && fail) {
        fail = false;
        throw race;
      }
      sent.push(l.key);
    });
    expect(sent).toEqual(["a", "b"]);
  });

  it("a second ExceedsPending, or any other error, is thrown", async () => {
    await expect(runInstant(confirmed, async () => confirmed, async () => { throw race; })).rejects.toBe(race);
    const other = new Error("boom");
    await expect(runInstant(confirmed, async () => confirmed, async () => { throw other; })).rejects.toBe(other);
  });

  it("a smaller first read asks before sending anything", async () => {
    const send = async () => {
      throw new Error("must not send");
    };
    const out = await runInstant(confirmed, async () => [line("a", 10n)], send);
    expect(out).toMatchObject({ kind: "smaller", gemas: 10n, sent: [] });
    expect(await runInstant(confirmed, async () => [], send)).toEqual({ kind: "none", sent: [] });
  });
});
