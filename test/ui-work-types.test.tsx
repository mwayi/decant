import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyData, SLICE_LOADERS, slicesForView } from "../src/ui/data-slices.ts";
import { ALL_DATE_RANGE } from "../src/ui/date-range.ts";
import type { DimensionRow } from "../src/ui/types.ts";
import { AnalyticsView, type SliceStatus, WorkTypesPanel } from "../src/ui/views/analytics.tsx";

const row = (key: string, sessions = 2): DimensionRow => ({
  key,
  sessions,
  usage_sessions: sessions,
  input_tokens: 1234,
  output_tokens: 567,
  reasoning_tokens: 0,
  est_reasoning_tokens: 0,
  estimated_cost_usd: 12.5,
});

function render(rows: DimensionRow[], status: SliceStatus = "ready"): string {
  return renderToStaticMarkup(
    <AnalyticsView
      data={{ ...emptyData, byWorkType: rows }}
      dateRange={ALL_DATE_RANGE}
      onDateRangeChange={() => {}}
      onSourceChange={() => {}}
      onSync={() => {}}
      sliceStatus={(slice) => (slice === "byWorkType" ? status : "ready")}
      source=""
      syncing={false}
    />,
  );
}

describe("Analytics work types", () => {
  test("renders recorded new types, tokens, cost and honest classification guidance", () => {
    const html = render([row("documentation"), row("review"), row("mixed"), row("(unclassified)")]);
    expect(html).toContain("<h2>Work types</h2>");
    expect(html).toContain('aria-label="Usage by work type"');
    expect(html).toContain("Documentation");
    expect(html).toContain("Review");
    expect(html).toContain("Mixed");
    expect(html).toContain("Unclassified");
    expect(html).toContain("Input tokens");
    expect(html).toContain("Output tokens");
    expect(html).toContain("12.50");
    expect(html).toContain("inferred");
    expect(html).toContain("No sessions yet");
    expect(html).toContain("Planning");
  });

  test("distinguishes loading, failure, empty and refreshing states", () => {
    const panel = (rows: DimensionRow[], status: SliceStatus) =>
      renderToStaticMarkup(<WorkTypesPanel rows={rows} status={status} />);
    expect(panel([], "loading")).toContain("Reading work types");
    expect(panel([], "loading")).not.toContain("No sessions yet");
    expect(panel([], "failed")).toContain("Not loaded");
    expect(panel([row("review")], "failed")).not.toContain('aria-label="Usage by work type"');
    expect(panel([], "ready")).toContain("No work types in range");
    expect(panel([row("review")], "loading")).toContain('data-updating="true"');
  });

  test("does not present missing usage as a free work type", () => {
    const html = renderToStaticMarkup(
      <WorkTypesPanel rows={[{ ...row("review"), usage_sessions: 0, estimated_cost_usd: 0 }]} />,
    );
    expect(html).toContain('class="faint"');
    expect(html).not.toContain("$0.00");
  });

  test("loads work types using the selected date and agent source scope", async () => {
    expect(slicesForView("analytics")).toContain("byWorkType");
    expect(SLICE_LOADERS.byWorkType.dateScoped).toBe(true);
    let requested = "";
    const fakeFetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requested = String(input);
        return Response.json([row("prototype")]);
      },
      { preconnect: fetch.preconnect },
    );
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
    try {
      const result = await SLICE_LOADERS.byWorkType.load("from=2026-11-22&source=codex_app");
      const url = new URL(requested, "http://localhost");
      expect(url.pathname).toBe("/api/stats/by-dimension");
      expect(url.searchParams.get("dim")).toBe("work_type");
      expect(url.searchParams.get("from")).toBe("2026-11-22");
      expect(url.searchParams.get("source")).toBe("codex_app");
      expect(result.byWorkType).toEqual([row("prototype")]);
    } finally {
      fetcher.mockRestore();
    }
  });
});
