import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { upsertSession } from "../src/ingest.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";
import { byDimension, totals } from "../src/stats.ts";

const directory = mkdtempSync(join(tmpdir(), "decant-work-type-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

for (const tool of ["claude", "codex"] as const) {
  test(`${tool} declarations persist on re-ingest without changing usage or session identity`, () => {
    const db = openDb(join(directory, `${tool}.db`));
    try {
      const source = readFileSync(
        join(import.meta.dir, "..", "fixtures", tool, "sample.jsonl"),
        "utf8",
      );
      const tagged = source.replace(
        tool === "claude" ? "Let me read the test." : "Found one TODO in src/a.rs",
        "[decant:work-type=feature]",
      );
      const parse = (content: string) =>
        tool === "claude"
          ? parseClaudeSession("tagged", content)
          : parseCodexSession("tagged", content, new Map());
      const store = (content: string, version: number) =>
        upsertSession(
          db,
          parse(content),
          "/synthetic/tagged.jsonl",
          version,
          content.length,
          String(version),
        );
      store(tagged, 1);
      const row = () =>
        db
          .query<{ id: number; work_type: string | null }, []>("SELECT id, work_type FROM session")
          .get();
      const original = row();
      expect(original).toMatchObject({ work_type: "feature" });
      if (original == null) {
        throw new Error("Tagged session was not stored");
      }
      const usage = totals(db);
      store(tagged.replace("work-type=feature", "work-type=refactor"), 2);
      expect(row()).toEqual({ ...original, work_type: "refactor" });
      expect(totals(db)).toEqual(usage);
      expect(byDimension(db, "work_type")).toMatchObject([
        {
          key: "refactor",
          sessions: 1,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
        },
      ]);
      expect(byDimension(db, "work_type")[0]?.estimated_cost_usd).toBeCloseTo(
        usage.estimated_cost_usd,
      );
      expect(byDimension(db, "work_type", { project: "/missing-project" })).toEqual([]);
    } finally {
      db.close();
    }
  });
}

test("work-type totals include mixed, unclassified and subagent usage exactly once", () => {
  const db = openDb(join(directory, "totals.db"));
  try {
    db.exec(`
      INSERT INTO session(tool, source_session_id, work_type, is_subagent,
                          total_input_tokens, total_output_tokens, estimated_cost_usd)
      VALUES ('codex', 'feature', 'feature', 0, 100, 20, 0.1),
             ('codex', 'child', 'refactor', 1, 200, 30, 0.2),
             ('codex', 'mixed', 'mixed', 0, 300, 40, 0.3),
             ('codex', 'unknown', NULL, 0, 400, 50, 0.4);
    `);
    const rows = byDimension(db, "work_type");
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.key === "refactor")).toMatchObject({
      sessions: 0,
      input_tokens: 200,
    });
    expect(rows.find((row) => row.key === "mixed")).toMatchObject({
      sessions: 1,
      input_tokens: 300,
    });
    expect(rows.find((row) => row.key === "(unclassified)")).toMatchObject({
      sessions: 1,
      input_tokens: 400,
    });
    const usage = totals(db);
    for (const field of [
      "sessions",
      "input_tokens",
      "output_tokens",
      "estimated_cost_usd",
    ] as const) {
      expect(rows.reduce((sum, row) => sum + row[field], 0)).toBeCloseTo(usage[field]);
    }
  } finally {
    db.close();
  }
});
