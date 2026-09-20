import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePath = new URL(
  "../workers/uk_aq_cache_proxy/src/who_daily_series_route.ts",
  import.meta.url,
);

test("WHO daily series degrades conservatively when provenance is unavailable", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /let dailyProvenance: Map<string, "P" \| "R"> \| null = null;/,
  );
  assert.match(
    source,
    /catch \(error\) \{\s*console\.error\("WHO daily-series provenance enrichment degraded", \{[\s\S]*?\}\);\s*\}/,
  );
  assert.doesNotMatch(source, /who_daily_series_provenance_failed/);
  assert.match(source, /raw\.source_validation_status/);
  assert.match(
    source,
    /dailyProvenance\?\.get\(String\(item\.day_utc\)\) \?\?\s*\(item\.daily_mean_ugm3 !== null \? "P" : null\)/,
  );
});
