import { settledMigrationBatches } from './observation_history_migration_concurrency.mjs';
import { createOperatorProgress } from '../../index_v3_migration/operator_execution.mjs';
import { getObservationHistoryGeneration, assertObservationHistoryGenerationKey } from "../../../workers/shared/uk_aq_observation_history_generation.mjs";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import {
  timeseriesBindingSourceRootKey, timeseriesBindingSourceRangeManifestKey,
  validateTimeseriesBindingSourceRootManifest, validateTimeseriesBindingSourceRangeManifest,
  buildTimeseriesBindingSourceRootManifest, buildTimeseriesBindingSourceRangeManifest,
} from "./timeseries_binding_source_hierarchy_v2.mjs";

const source = getObservationHistoryGeneration("v2");
const target = getObservationHistoryGeneration("v3");
const identity = (key, body) => ({ key, byte_size: body.byteLength, sha256: sha256Hex(body) });
const artifact = (key, payload) => {
  const body = JSON.stringify(payload, null, 2) + "\n";
  return { ...identity(key, Buffer.from(body)), body, payload };
};

export async function inventorySideBySideBindings(getObject, { concurrency = 1 } = {}) {
  const rootKey = timeseriesBindingSourceRootKey(source.timeseries_binding_index_prefix);
  const rootBytes = Buffer.from((await getObject({ key: rootKey })).body);
  const root = validateTimeseriesBindingSourceRootManifest(JSON.parse(rootBytes));
  if (root.source_prefix !== source.timeseries_binding_index_prefix) throw new Error("Binding source root is outside v2");
  const sourceObjects = [identity(rootKey, rootBytes)];
  const bindings = [];
  const ranges = [];
  const rangeObjects = [];
  const rangeProgress = createOperatorProgress({ label: 'Side-by-side: binding range inventory', total: root.ranges.length });
  const readRanges = [];
  for await (const settled of settledMigrationBatches(root.ranges, concurrency, async (reference) => {
    const key = timeseriesBindingSourceRangeManifestKey(source.timeseries_binding_index_prefix, reference.range_start, reference.range_end);
    if (key !== reference.manifest_key) throw new Error("Binding range source key mismatch");
    const bytes = Buffer.from((await getObject({ key })).body);
    const range = validateTimeseriesBindingSourceRangeManifest(JSON.parse(bytes));
    if (range.source_prefix !== source.timeseries_binding_index_prefix ||
        range.range_start !== reference.range_start || range.range_end !== reference.range_end ||
        range.source_range_hash !== reference.source_range_hash || range.units.length !== reference.unit_count) {
      throw new Error("Binding source range contradicts its authoritative root");
    }
    return { reference, key, bytes, range };
  })) {
    for (const entry of settled) {
      if (entry.result.status === 'fulfilled') readRanges.push(entry.result.value);
    }
    rangeProgress.report(readRanges.length);
  }
  const leafProgress = createOperatorProgress({ label: 'Side-by-side: binding leaf inventory', total: root.ranges.reduce((sum, range) => sum + range.unit_count, 0) });
  for (const rangeEntry of readRanges) {
    const { key, bytes, range } = rangeEntry;
    rangeEntry.bytes = null;
    sourceObjects.push(identity(key, bytes));
    const targetUnits = [];
    for await (const settled of settledMigrationBatches(range.units, concurrency, async (unit) => {
      const expectedKey = `${source.timeseries_binding_index_prefix}/timeseries_id=${unit.timeseries_id}.json`;
      if (unit.relative_path !== expectedKey) throw new Error("Binding source path is not deterministic");
      const body = Buffer.from((await getObject({ key: expectedKey })).body);
      if (body.byteLength !== unit.size || sha256Hex(body) !== unit.sha256) throw new Error(`Binding source physical identity mismatch: ${expectedKey}`);
      const binding = JSON.parse(body);
      if (![1,2].includes(binding.schema_version) || binding.history_version !== "v2" ||
          binding.index_kind !== "timeseries_binding" || binding.timeseries_id !== unit.timeseries_id ||
          !Number.isSafeInteger(binding.connector_id) || binding.connector_id <= 0 ||
          !/^[a-z0-9_]+$/.test(binding.pollutant_code || "")) throw new Error(`Invalid stable binding: ${expectedKey}`);
      const targetKey = `${target.timeseries_binding_index_prefix}/timeseries_id=${unit.timeseries_id}.json`;
      assertObservationHistoryGenerationKey(target, targetKey, "bindings");
      return { binding: { ...identity(targetKey, body), source_key: expectedKey, timeseries_id: unit.timeseries_id,
        connector_id: binding.connector_id, pollutant_code: binding.pollutant_code },
        unit: { ...unit, relative_path: targetKey, r2_md5: null } };
    })) {
      for (const entry of settled) if (entry.result.status === 'fulfilled') {
        bindings.push(entry.result.value.binding);
        targetUnits.push(entry.result.value.unit);
      }
      leafProgress.report(bindings.length);
    }
    const targetRange = buildTimeseriesBindingSourceRangeManifest({
      bindingPrefix: target.timeseries_binding_index_prefix,
      rangeStart: range.range_start, rangeEnd: range.range_end, units: targetUnits,
    });
    const targetKey = timeseriesBindingSourceRangeManifestKey(target.timeseries_binding_index_prefix, range.range_start, range.range_end);
    rangeObjects.push(artifact(targetKey, targetRange));
    ranges.push({ range_start: range.range_start, range_end: range.range_end,
      source_range_hash: targetRange.source_range_hash, manifest_key: targetKey, unit_count: targetUnits.length });
  }
  const targetRoot = buildTimeseriesBindingSourceRootManifest({ bindingPrefix: target.timeseries_binding_index_prefix, ranges });
  return { source_objects: sourceObjects, bindings,
    manifests: [...rangeObjects, artifact(timeseriesBindingSourceRootKey(target.timeseries_binding_index_prefix), targetRoot)] };
}
