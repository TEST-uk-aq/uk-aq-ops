import { randomUUID } from 'node:crypto';
import { requireValid as check } from '../schema.mjs';
import { GENERATION } from './dropbox-reader.mjs';
import { withHistoryWriterClient, withObservationsGlobalOperationLock } from '../../../workers/shared/uk_aq_r2_history_writer.mjs';
import { hasRequiredR2Config, r2GetObjectBounded, sha256Hex } from '../../../workers/shared/r2_sigv4.mjs';
import { resolveR2HistoryIndexConfig } from '../../../workers/shared/uk_aq_r2_history_index.mjs';
import {
  OBSERVATIONS_AGGREGATE_MANIFEST_KINDS,
  buildR2HistoryV2ObservationsMonthManifestKey,
  buildR2HistoryV2ObservationsYearManifestKey,
  validateR2HistoryV2ObservationsAggregateManifest,
} from '../../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs';

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_HEARTBEAT_MS = 5_000;

export async function withBootstrapObservationLock(callback, {
  env = process.env,
  runId = randomUUID(),
  diagnostics = [],
} = {}) {
  check(env.UK_AQ_ENV_NAME === 'TEST', 'UK_AQ_ENV_NAME must be TEST');
  const databaseUrl = String(env.SUPABASE_DB_URL || env.DATABASE_URL || '').trim();
  check(databaseUrl, 'SUPABASE_DB_URL or DATABASE_URL is required for scoped currentness checks');
  return await withHistoryWriterClient(databaseUrl, client => withObservationsGlobalOperationLock({
    client,
    owner: 'jsongen_dropbox_bootstrap',
    runId,
    timeoutMs: LOCK_TIMEOUT_MS,
    heartbeatMs: LOCK_HEARTBEAT_MS,
    diagnostics,
    diagnosticEnvironment: env.UK_AQ_ENV_NAME,
  }, async (_identity, lock) => {
    const context = { assertHeld: () => lock.assertHeld(), signal: lock.signal };
    context.assertHeld();
    const result = await callback(context);
    context.assertHeld();
    return result;
  }), { applicationName: 'uk-aq-jsongen-dropbox-bootstrap-currentness' });
}

function parseJson(body, key) {
  try { return JSON.parse(Buffer.from(body).toString('utf8')); }
  catch (error) { throw new Error(`Invalid canonical R2 hierarchy JSON: ${key}`, { cause: error }); }
}

export function compareDayMembership(sourceDays, canonicalDays, selectedDays) {
  return selectedDays.map(dayUtc => {
    const sourceHash = sourceDays.get(dayUtc) || null;
    const canonicalHash = canonicalDays.get(dayUtc) || null;
    return { day_utc: dayUtc, source_manifest_hash: sourceHash,
      canonical_manifest_hash: canonicalHash, matches: sourceHash === canonicalHash };
  });
}

export async function readCurrentObservationScopes(scopes, {
  env = process.env,
  signal,
  assertHeld = () => {},
} = {}) {
  check(env.UK_AQ_ENV_NAME === 'TEST', 'UK_AQ_ENV_NAME must be TEST');
  const config = resolveR2HistoryIndexConfig(env);
  check(hasRequiredR2Config(config.r2), 'complete existing R2 credentials/configuration are required for scoped currentness');
  const rootPrefix = GENERATION.observations_prefix;
  const rootKey = GENERATION.observations_root_key;
  const rootYearCache = new Map();
  const yearMonthCache = new Map();
  const reads = [];

  async function readManifest(key, level, expectedHash = null) {
    assertHeld();
    const object = await r2GetObjectBounded({ r2: config.r2, key, max_bytes: MAX_MANIFEST_BYTES,
      timeout_ms: 15_000, signal });
    assertHeld();
    const raw = parseJson(object.body, key);
    const manifest = validateR2HistoryV2ObservationsAggregateManifest(raw, { basePrefix: rootPrefix });
    check(manifest.kind === OBSERVATIONS_AGGREGATE_MANIFEST_KINDS[level],
      `canonical hierarchy level mismatch: ${key}`);
    if (expectedHash) check(manifest.content_hash === expectedHash,
      `canonical parent/reference content_hash mismatch: ${key}`);
    const reference = { key, content_hash: manifest.content_hash, object_sha256: sha256Hex(object.body),
      byte_size: object.bytes };
    reads.push(reference);
    return { manifest, reference };
  }

  const rootResult = await readManifest(rootKey, 'root');
  const root = rootResult.manifest;

  async function year(yearNumber) {
    if (rootYearCache.has(yearNumber)) return rootYearCache.get(yearNumber);
    const ref = root.children.find(child => child.year === yearNumber) || null;
    if (!ref) {
      const absent = { reference: null, manifest: null };
      rootYearCache.set(yearNumber, absent);
      return absent;
    }
    const expectedKey = buildR2HistoryV2ObservationsYearManifestKey(rootPrefix, yearNumber);
    check(ref.manifest_key === expectedKey, `canonical root year path mismatch: ${yearNumber}`);
    const result = await readManifest(ref.manifest_key, 'year', ref.content_hash);
    check(result.manifest.year === yearNumber, `canonical year identity mismatch: ${yearNumber}`);
    const value = { reference: ref, ...result };
    rootYearCache.set(yearNumber, value);
    return value;
  }

  async function month(monthUtc) {
    if (yearMonthCache.has(monthUtc)) return yearMonthCache.get(monthUtc);
    const [yearText, monthText] = monthUtc.split('-');
    const yearNumber = Number(yearText);
    const yearResult = await year(yearNumber);
    if (!yearResult.manifest) {
      const absent = { reference: null, manifest: null, year: yearResult };
      yearMonthCache.set(monthUtc, absent);
      return absent;
    }
    const ref = yearResult.manifest.children.find(child => child.month === monthText) || null;
    if (!ref) {
      const absent = { reference: null, manifest: null, year: yearResult };
      yearMonthCache.set(monthUtc, absent);
      return absent;
    }
    const expectedKey = buildR2HistoryV2ObservationsMonthManifestKey(rootPrefix, yearNumber, monthText);
    check(ref.manifest_key === expectedKey, `canonical year month path mismatch: ${monthUtc}`);
    const result = await readManifest(ref.manifest_key, 'month', ref.content_hash);
    check(result.manifest.year === yearNumber && result.manifest.month === monthText,
      `canonical month identity mismatch: ${monthUtc}`);
    const value = { reference: ref, ...result, year: yearResult };
    yearMonthCache.set(monthUtc, value);
    return value;
  }

  const results = [];
  for (const scope of scopes) {
    assertHeld();
    try {
      check(/^\d{4}-(0[1-9]|1[0-2])$/.test(scope.month_utc || ''), 'invalid scoped month');
      const currentMonth = await month(scope.month_utc);
      const canonicalDays = new Map((currentMonth.manifest?.children || [])
        .map(child => [child.day_utc, child.manifest_hash]));
      const rootEvidence = {
        root: rootResult.reference,
        year: currentMonth.year.reference,
        year_manifest: currentMonth.year.reference?.key || null,
        month: currentMonth.reference,
        observations_root_content_hash: root.content_hash,
      };
      const currentness = scope.mode === 'complete_month'
        ? { mode: 'complete_month', source_content_hash: scope.source_month_hash || null,
            canonical_content_hash: currentMonth.manifest?.content_hash || null,
            matches: (scope.source_month_hash || null) === (currentMonth.manifest?.content_hash || null) }
        : { mode: 'partial_completed_days', days: compareDayMembership(
            new Map(scope.source_days.map(day => [day.day_utc, day.manifest_hash])),
            canonicalDays, scope.selected_days) };
      if (currentness.mode === 'partial_completed_days') {
        check(scope.source_days.length === scope.selected_days.length,
          `Dropbox selected-day proof is incomplete for ${scope.month_utc}`);
        currentness.matches = currentness.days.every(day => day.matches);
      }
      const contextResults = [];
      check((scope.source_context_days || []).length === (scope.context_days || []).length,
        `Dropbox PM context day proof is incomplete for ${scope.month_utc}`);
      for (const contextDay of scope.context_days || []) {
        try {
          const contextMonth = await month(contextDay.slice(0, 7));
          const contextHash = contextMonth.manifest?.children.find(child => child.day_utc === contextDay)?.manifest_hash || null;
          const sourceHash = scope.source_context_days?.find(day => day.day_utc === contextDay)?.manifest_hash || null;
          contextResults.push({ day_utc: contextDay, source_manifest_hash: sourceHash,
            canonical_manifest_hash: contextHash, matches: sourceHash === contextHash,
            proof_state: 'established', root: rootResult.reference,
            year: contextMonth.year.reference, month: contextMonth.reference });
        } catch (error) {
          assertHeld();
          contextResults.push({ day_utc: contextDay, matches: false,
            proof_state: 'not_established', error: error.message });
        }
      }
      results.push({ month_utc: scope.month_utc, currentness,
        context_days: contextResults, matches: currentness.matches && contextResults.every(day => day.matches),
        canonical_scope: rootEvidence, proof_state: 'established' });
    } catch (error) {
      // A lost lock is invocation-wide: never downgrade it to one failed month.
      assertHeld();
      results.push({ month_utc: scope.month_utc,
        currentness: { mode: scope.mode, matches: false, state: 'not_established' },
        context_days: [], matches: false, proof_state: 'not_established', error: error.message });
    }
  }
  return { root: rootResult.reference, root_content_hash: root.content_hash,
    reads, scopes: results, checked_at_utc: new Date().toISOString() };
}
