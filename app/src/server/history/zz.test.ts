import { it } from "vitest";
import { testDb } from "./test-db";
it("t", async () => { for (let i = 0; i < 3; i++) { const t = Date.now(); const { sql } = await testDb(); console.log("DB", i, Date.now() - t); await sql.close(); } }, 120000);
