// Explicit local-only benchmark; not part of automatic test discovery.
// node --expose-gc tests/uk_aq_observation_history_planner_benchmark.mjs [--progress]
import { buildObservationHistoryIndexV3PublicationPlan } from "../workers/shared/uk_aq_observation_history_index_v3.mjs";
import { createMigrationProgressReporter } from "../scripts/backup_r2/lib/observation_history_migration_v3.mjs";
import { archivePlannerGraph } from "./fixtures/uk_aq_index_v3_planner_graphs.mjs";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--progress")) throw new Error("Only --progress is supported");
const progressEnabled = args.includes("--progress");
const graph = archivePlannerGraph(76986, 576);
globalThis.gc?.();
const memoryBefore = process.memoryUsage();
const reporter = createMigrationProgressReporter({
  label: "V3 migration: reconstructing recovered plan: v3 publication plan",
  total: graph.objects.length, enabled: progressEnabled,
});
let progressEvents = 0;
const cpuBefore = process.cpuUsage();
const startedAt = process.hrtime.bigint();
const plan = buildObservationHistoryIndexV3PublicationPlan({
  ...graph,
  onProgress: progressEnabled ? ({ completed }) => {
    progressEvents += 1;
    reporter.report(completed);
  } : null,
});
const wallSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
const cpu = process.cpuUsage(cpuBefore);
const memoryAfter = process.memoryUsage();
process.stdout.write(`${JSON.stringify({
  kind: "local_synthetic_v3_publication_planner_benchmark",
  node_version: process.version,
  object_count: plan.entries.length,
  changed_edge_count: plan.changed_dependency_edge_count,
  external_reference_count: plan.external_reference_count,
  graph: "physical leaves, scoped parents, one latest, external canonical and Parquet prerequisites",
  progress_enabled: progressEnabled,
  progress_events: progressEvents,
  planner_wall_seconds: wallSeconds,
  planner_cpu_user_seconds: cpu.user / 1e6,
  planner_cpu_system_seconds: cpu.system / 1e6,
  process_peak_rss_mib: process.resourceUsage().maxRSS / 1024,
  process_rss_before_mib: memoryBefore.rss / 1024 ** 2,
  process_rss_after_mib: memoryAfter.rss / 1024 ** 2,
  schedule_sha256: plan.schedule_sha256,
})}\n`);
