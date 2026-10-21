import fs from "node:fs";
import path from "node:path";
import { getObservationHistoryGeneration } from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import { hash, privatePath, requireSafe } from "./config.mjs";

const g = getObservationHistoryGeneration("v3");
const sha = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const empty = (s) => Array.isArray(s) && s.length === 0;
function sameHash(a, b) { return sha(a) && a === b; }

export function acceptReports(directory, c, invocation) {
  const files = {};
  function report(name, timestamped = true) {
    const filename = path.join(directory, `${name}.json`);
    privatePath(filename);
    const bytes = fs.readFileSync(filename);
    const value = JSON.parse(bytes);
    files[name] = { filename, sha256: hash(bytes) };
    if (timestamped) {
      const start = Date.parse(value.started_at), end = Date.parse(value.completed_at);
      requireSafe(Number.isFinite(start) && Number.isFinite(end)
        && start >= Date.parse(invocation.started_at) && end >= start && end <= Date.now(), "report_timestamp");
    }
    return value;
  }
  // Every attempt creates an exclusive directory before the command is launched.
  // The publisher schema has no timestamps; its exclusive fresh path is the freshness proof.
  const publisher = report("publisher", false), inventory = report("inventory"), backup = report("backup");
  requireSafe(publisher.status === "succeeded" && publisher.mode === "write-r2"
    && publisher.source_root_key === `${g.timeseries_binding_index_prefix}/_manifests/root.json`
    && publisher.pack_root_key === `${g.timeseries_binding_pack_prefix}/root.json`, "publisher_report");
  requireSafe(inventory.ok === true && inventory.dry_run === false
    && inventory.observation_generation === "v3" && inventory.observation_history_index_authority === "v3"
    && inventory.inventory_mode === "hierarchical" && inventory.source_root === c.source
    && inventory.observations_prefix === g.observations_prefix && inventory.core_prefix === g.core_prefix
    && inventory.inventory_root_key === `${g.backup_inventory_prefix}/root.json`
    && inventory.timeseries_binding_backup_mode === "pack"
    && inventory.timeseries_binding_packs?.available === true, "inventory_report");
  requireSafe(backup.ok === true && backup.complete === true && backup.dry_run === false
    && backup.observation_generation === "v3" && backup.source_root === c.source && backup.dest_root === c.destination
    && backup.timeseries_binding_backup_mode === "pack" && backup.timeseries_binding_packs_only === false
    && backup.observation_parquet_copy_mode === "full" && backup.max_days_per_run === 0
    && backup.inventory_root_key === `${g.backup_inventory_prefix}/root.json`
    && backup.state_root_key === `${g.backup_state_prefix}/root.json`
    && backup.checkpoint_batch_units === Number(c.env.UK_AQ_R2_HISTORY_CHECKPOINT_BATCH_UNITS)
    && backup.checkpoint_flush_seconds === Number(c.env.UK_AQ_R2_HISTORY_CHECKPOINT_FLUSH_SECONDS), "backup_report");
  const obs = backup.observations, pack = backup.timeseries_binding_packs, invPack = inventory.timeseries_binding_packs;
  requireSafe(sameHash(obs?.source_root_hash, obs?.processed_source_root_hash)
    && sameHash(obs.source_root_hash, inventory.observations_source_root_hash)
    && empty(obs.incomplete_months) && empty(obs.incomplete_years), "observations_incomplete");
  requireSafe(pack?.mode === "pack" && pack.complete === true && empty(pack.incomplete_ranges)
    && sameHash(pack.source_root_hash, pack.processed_source_root_hash)
    && sameHash(pack.source_root_hash, publisher.source_root_hash)
    && sameHash(pack.source_root_hash, invPack.source_root_hash)
    && sameHash(pack.pack_root_sha256, publisher.pack_root_sha256)
    && sameHash(pack.pack_root_sha256, invPack.pack_root_sha256)
    && pack.pack_root_relative_path === publisher.pack_root_key
    && pack.pack_root_relative_path === invPack.pack_root_relative_path
    && pack.pack_root_size === publisher.pack_root_size && pack.pack_root_size === invPack.pack_root_size
    && Number.isSafeInteger(pack.pack_root_size) && pack.pack_root_size > 0
    && pack.packs_total === publisher.range_count && pack.packs_total === invPack.ranges_total
    && publisher.member_count === invPack.member_count
    && pack.pack_root?.verification_status === "verified"
    && pack.pack_root.destination_identity_match === true && pack.pack_root.destination_missing === false
    && pack.pack_root.dry_run === false, "packed_checkpoint_incomplete");
  requireSafe(backup.core?.complete === true && sameHash(backup.core.source_hash, backup.core.processed_source_hash)
    && backup.core.pruning_enabled === false && backup.run_manifests?.complete === true
    && backup.timeseries_binding?.skipped === true && empty(backup.timeseries_binding.incomplete_ranges), "domains_incomplete");
  const latest = backup.latest_timeseries, identity = latest?.processed_source_identity;
  requireSafe(latest?.source_path === g.observations_timeseries_latest_key && latest.incomplete === false
    && latest.error === null && ["verified", "previously_verified"].includes(latest.verification_status)
    && identity?.verified === true && identity.source_path === latest.source_path
    && sameHash(identity.sha256, latest.sha256) && identity.byte_size === latest.byte_size
    && inventory.latest_timeseries?.source_path === latest.source_path
    && sameHash(inventory.latest_timeseries.sha256, latest.sha256)
    && inventory.latest_timeseries.byte_size === latest.byte_size, "latest_incomplete");
  requireSafe(backup.verification?.complete === true && backup.verification.error === null
    && (backup.verification.active === false || sameHash(backup.verification.source_root_hash,
      backup.verification.processed_source_root_hash))
    && backup.prune?.forced_failed_days === 0, "verification_incomplete");
  return { operation_id: invocation.operation_id, run_id: invocation.run_id,
    report_identity: hash(JSON.stringify(files)), files,
    observation_source_root_hash: obs.source_root_hash, binding_source_root_hash: pack.source_root_hash,
    pack_root_sha256: pack.pack_root_sha256, state_root_key: backup.state_root_key };
}
