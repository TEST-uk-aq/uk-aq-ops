import { mkdir, writeFile } from "node:fs/promises";
import {
  buildObservsConfig,
  executeObservsPartitionMaintenance,
  reportObservsPartitionMaintenanceError,
} from "./server.mjs";

const REPORT_PATH = "tmp/uk_aq_observs_partition_maintenance_report.json";

function boundedValue(value, depth = 0) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= 4_000 ? value : `${value.slice(0, 3_997)}...`;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (depth >= 8) {
    return "[MaxDepth]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => boundedValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 100).map(([key, entry]) => [key, boundedValue(entry, depth + 1)]),
    );
  }
  return String(value);
}

async function writeReport(payload) {
  await mkdir("tmp", { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(boundedValue(payload), null, 2)}\n`, "utf8");
}

async function main() {
  const url = new URL("http://localhost/");
  if (process.env.INPUT_DROP_DRY_RUN === "true") {
    url.searchParams.set("dropDryRun", "true");
  }

  try {
    const config = buildObservsConfig(url);
    const summary = await executeObservsPartitionMaintenance(config);
    await writeReport({ ok: true, summary });
  } catch (error) {
    const errorReport = await reportObservsPartitionMaintenanceError(error, {
      execution_mode: "github_actions",
    });
    await writeReport({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...errorReport,
    });
    process.exitCode = 1;
  }
}

await main();
