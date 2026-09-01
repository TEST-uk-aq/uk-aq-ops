#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PHYSICAL_1024_HOST = /-v3-physical-1024-candidate\.[a-z0-9-]*test[a-z0-9-]*\.workers\.dev$/i;
const PHYSICAL_LEAF_HOST = /-v3-leaf-candidate\.[a-z0-9-]*test[a-z0-9-]*\.workers\.dev$/i;
const MAX_MEASUREMENT_PAGES = 256;
const PAGINATION_REASON = "physical_pagination_incomplete";
const DEFAULT_CASE_NAMES = Object.freeze([
  "sensorcommunity_normal_ts7421_24h",
  "sensorcommunity_dense_ts7421_1h",
  "sensorcommunity_dense_ts7421_24h",
]);

export function buildPhysicalLeafMeasurementMatrix() {
  return [
    {
      name: "sensorcommunity_normal_ts7421_24h",
      connector_id: 7,
      timeseries_id: 7421,
      start_utc: "2026-08-20T00:00:00.000Z",
      end_utc: "2026-08-21T00:00:00.000Z",
      fixture_expected_leaf_pages: 1,
    },
    {
      name: "sensorcommunity_dense_ts7421_1h",
      connector_id: 7,
      timeseries_id: 7421,
      start_utc: "2026-04-03T00:00:00.000Z",
      end_utc: "2026-04-03T01:00:00.000Z",
      fixture_expected_leaf_pages: 1,
    },
    {
      name: "sensorcommunity_dense_ts7421_24h",
      connector_id: 7,
      timeseries_id: 7421,
      start_utc: "2026-04-03T00:00:00.000Z",
      end_utc: "2026-04-04T00:00:00.000Z",
      fixture_expected_leaf_pages: 13,
    },
  ];
}

function endpoint(raw, pattern, label) {
  const url = new URL(String(raw || ""));
  if (url.protocol !== "https:" || !pattern.test(url.hostname)) {
    throw new Error(`refusing ${label}; expected its isolated TEST workers.dev host`);
  }
  url.pathname = "/v1/observations";
  url.search = "";
  url.hash = "";
  return url;
}

function parse(argv) {
  const options = {
    physical1024Endpoint: process.env.UK_AQ_V3_PHYSICAL_1024_CANDIDATE_URL || "",
    physicalLeafEndpoint: process.env.UK_AQ_V3_PHYSICAL_LEAF_CANDIDATE_URL || "",
    outputDir: "",
    repeat: 1,
    timeoutMs: 30_000,
    dryRun: false,
    leafOnly: false,
    caseNames: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => argv[++index] || (() => { throw new Error(`${argument} requires a value`); })();
    if (argument === "--physical-1024-endpoint") options.physical1024Endpoint = next();
    else if (argument === "--physical-leaf-endpoint") options.physicalLeafEndpoint = next();
    else if (argument === "--output-dir") options.outputDir = next();
    else if (argument === "--repeat") options.repeat = Number(next());
    else if (argument === "--timeout-ms") options.timeoutMs = Number(next());
    else if (argument === "--case") options.caseNames.push(next());
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--leaf-only") options.leafOnly = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (
    !Number.isSafeInteger(options.repeat) ||
    options.repeat < 1 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1
  ) throw new Error("repeat and timeout-ms must be positive integers");
  return options;
}

function selectCases(matrix, caseNames) {
  const selectedNames = caseNames.length ? caseNames : DEFAULT_CASE_NAMES;
  const accepted = new Set(matrix.map((item) => item.name));
  const unknown = [...new Set(selectedNames.filter((name) => !accepted.has(name)))];
  if (unknown.length) {
    throw new Error(`Unknown --case name(s): ${unknown.join(", ")}. Accepted: ${[...accepted].join(", ")}`);
  }
  const selected = new Set(selectedNames);
  return matrix.filter((item) => selected.has(item.name));
}

function requestUrl(base, item, physicalCursor = null) {
  const url = new URL(base);
  for (const [key, value] of Object.entries({
    connector_id: item.connector_id,
    pollutant: "pm25",
    timeseries_id: item.timeseries_id,
    start_utc: item.start_utc,
    end_utc: item.end_utc,
    diagnostics: "workload_v1",
  })) url.searchParams.set(key, String(value));
  if (physicalCursor) url.searchParams.set("physical_cursor", physicalCursor);
  return url;
}

function rowsSha256(rows) {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function physicalDiagnostics(diagnostics) {
  if (!diagnostics) return null;
  return {
    logical_requested_start_utc: diagnostics.logical_requested_start_utc ?? null,
    logical_requested_end_utc: diagnostics.logical_requested_end_utc ?? null,
    physical_page_path: diagnostics.physical_page_path ?? null,
    physical_page_number: diagnostics.physical_page_number ?? null,
    continuation_cursor_supplied: diagnostics.continuation_cursor_supplied ?? null,
    candidate_intersecting_segments: diagnostics.candidate_intersecting_segments ?? null,
    selected_chronological_segments: diagnostics.selected_chronological_segments,
    selected_files: diagnostics.selected_files,
    selected_segment_physical_identity: diagnostics.selected_segment_physical_identity ?? null,
    selected_segment_row_count: diagnostics.selected_segment_row_count ?? null,
    physical_segments_decoded: diagnostics.physical_segments_decoded ?? null,
    physical_rows_decoded: diagnostics.physical_rows_decoded,
    returned_rows: diagnostics.returned_rows,
    pagination_complete: diagnostics.pagination_complete ?? null,
    continuation_returned: diagnostics.continuation_returned ?? null,
    scoped_manifests_read: diagnostics.scoped_manifests_read ?? null,
    whole_logical_range_segment_discovery: diagnostics.whole_logical_range_segment_discovery ?? null,
    global_segment_sorting: diagnostics.global_segment_sorting ?? null,
    index_objects_read: diagnostics.index_objects_read,
    index_bytes_read: diagnostics.index_bytes_read,
    timeseries_leaf_objects_read: diagnostics.timeseries_leaf_objects_read ?? 0,
    timeseries_leaf_bytes_read: diagnostics.timeseries_leaf_bytes_read ?? 0,
    coarse_child_shards_read: diagnostics.coarse_child_shards_read ?? 0,
    identity_head_reads: diagnostics.identity_head_reads,
    r2_range_reads: diagnostics.r2_range_reads,
    r2_bytes_requested: diagnostics.r2_bytes_requested,
    parquet_footer_fetched: diagnostics.parquet_footer_fetched,
    parquet_footer_parsed: diagnostics.parquet_footer_parsed,
    timeseries_id_decoded: diagnostics.timeseries_id_decoded,
  };
}

async function fetchPayload({ url, secret, timeoutMs }) {
  const response = await fetch(url, {
    headers: { "x-uk-aq-upstream-auth": secret },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* retain bounded platform text below */ }
  return { response, payload, text };
}

function pageEvidence({ response, payload, text, pageNumber }) {
  const diagnostics = payload?.coverage?.exact_reader_diagnostics || payload?.diagnostics || null;
  const rows = Array.isArray(payload?.rows) ? payload.rows : null;
  return {
    page_number: pageNumber,
    status: response.status,
    ok: response.ok,
    returned_rows: payload?.row_count ?? null,
    response_complete: payload?.response_complete ?? null,
    has_gap: payload?.has_gap ?? null,
    partial_reasons: payload?.partial_reasons ?? null,
    physical_page_path: diagnostics?.physical_page_path ?? payload?.physical_page?.physical_page_path ?? null,
    manifest_objects_read: diagnostics?.scoped_manifests_read ?? null,
    leaf_objects_read: diagnostics?.timeseries_leaf_objects_read ?? null,
    index_bytes_read: diagnostics?.index_bytes_read ?? null,
    whole_range_discovery: diagnostics?.whole_logical_range_segment_discovery ?? null,
    global_segment_sort: diagnostics?.global_segment_sorting ?? null,
    physical_rows: diagnostics?.physical_rows_decoded ?? null,
    physical_page: payload?.physical_page ?? null,
    rows,
    rows_sha256: rows ? rowsSha256(rows) : null,
    diagnostic_request_id:
      response.headers.get("x-ukaq-diagnostic-request-id") ||
      payload?.diagnostic_request?.request_id ||
      null,
    cf_ray: response.headers.get("cf-ray") || payload?.diagnostic_request?.cloudflare_ray_id || null,
    physical: physicalDiagnostics(diagnostics),
    error: payload?.error ?? (!payload ? text.slice(0, 500) : null),
    cloudflare_cpu_time_ms: null,
    cloudflare_cpu_time_source: "correlate this page request ID or CF-Ray in Cloudflare invocation telemetry",
  };
}

function assertLeafPage(page, expectedPageNumber) {
  if (!page.ok || !Array.isArray(page.rows) || page.returned_rows !== page.rows.length) {
    throw new Error(`leaf page ${expectedPageNumber} failed or has contradictory rows`);
  }
  const physicalPage = page.physical_page;
  const physical = page.physical;
  if (
    physicalPage?.schema_version !== 2 ||
    physicalPage?.page_number !== expectedPageNumber ||
    physicalPage?.physical_page_path !== (expectedPageNumber === 1
      ? "initial_discovery"
      : "direct_leaf_continuation") ||
    physical?.physical_page_path !== physicalPage.physical_page_path ||
    !Number.isSafeInteger(physicalPage?.candidate_intersecting_segments) ||
    ![0, 1].includes(physicalPage?.segments_decoded) ||
    !Number.isSafeInteger(physicalPage?.physical_rows_decoded) ||
    physicalPage.physical_rows_decoded < 0 ||
    physicalPage.physical_rows_decoded > 1024 ||
    physical?.physical_segments_decoded !== physicalPage.segments_decoded ||
    physical?.physical_rows_decoded !== physicalPage.physical_rows_decoded ||
    physical?.selected_chronological_segments !== physicalPage.segments_decoded ||
    physical?.parquet_footer_fetched !== false ||
    physical?.parquet_footer_parsed !== false ||
    physical?.timeseries_id_decoded !== false
  ) throw new Error(`leaf page ${expectedPageNumber} violates the one-segment physical contract`);
  if (
    expectedPageNumber === 1
      ? physical?.whole_logical_range_segment_discovery !== true ||
        physical?.global_segment_sorting !== true ||
        physical?.scoped_manifests_read !== 1
      : physical?.whole_logical_range_segment_discovery !== false ||
        physical?.global_segment_sorting !== false ||
        physical?.scoped_manifests_read !== 0 ||
        physical?.timeseries_leaf_objects_read !== 1
  ) throw new Error(`leaf page ${expectedPageNumber} did not use the expected discovery path`);
  if (physicalPage.pagination_complete) {
    if (physicalPage.next_cursor !== null) throw new Error(`leaf page ${expectedPageNumber} returned a terminal cursor`);
  } else if (
    typeof physicalPage.next_cursor !== "string" ||
    !physicalPage.next_cursor ||
    page.response_complete !== false ||
    page.has_gap !== false ||
    !page.partial_reasons?.includes(PAGINATION_REASON)
  ) throw new Error(`leaf page ${expectedPageNumber} has unsafe continuation semantics`);
}

async function attemptPhysical1024({ base, item, number, secret, timeoutMs }) {
  const url = requestUrl(base, item);
  try {
    const { response, payload, text } = await fetchPayload({ url, secret, timeoutMs });
    const rows = Array.isArray(payload?.rows) ? payload.rows : null;
    return {
      schema_version: 2,
      measured_at_utc: new Date().toISOString(),
      case: item.name,
      variant: "physical_1024",
      attempt: number,
      request: item,
      response: {
        status: response.status,
        ok: response.ok,
        returned_rows: payload?.row_count ?? null,
        response_complete: payload?.response_complete ?? null,
        rows,
        rows_sha256: rows ? rowsSha256(rows) : null,
        diagnostic_request_id:
          response.headers.get("x-ukaq-diagnostic-request-id") ||
          payload?.diagnostic_request?.request_id ||
          null,
        cf_ray: response.headers.get("cf-ray") || null,
        error: payload?.error ?? (!payload ? text.slice(0, 500) : null),
      },
      physical: physicalDiagnostics(payload?.coverage?.exact_reader_diagnostics || payload?.diagnostics || null),
      cloudflare_cpu_time_ms: null,
      cloudflare_cpu_time_source: "correlate diagnostic_request_id or cf_ray in Cloudflare invocation telemetry",
    };
  } catch (error) {
    return {
      schema_version: 2,
      measured_at_utc: new Date().toISOString(),
      case: item.name,
      variant: "physical_1024",
      attempt: number,
      request: item,
      response: { status: null, ok: false, returned_rows: null, response_complete: null, rows_sha256: null, diagnostic_request_id: null, cf_ray: null, error: error instanceof Error ? error.message : String(error) },
      physical: null,
      cloudflare_cpu_time_ms: null,
      cloudflare_cpu_time_source: null,
    };
  }
}

async function attemptPhysicalLeaf({ base, item, number, secret, timeoutMs }) {
  const pages = [];
  const rows = [];
  const cursors = new Set();
  let cursor = null;
  try {
    for (let pageNumber = 1; pageNumber <= MAX_MEASUREMENT_PAGES; pageNumber += 1) {
      const url = requestUrl(base, item, cursor);
      const fetched = await fetchPayload({ url, secret, timeoutMs });
      const page = pageEvidence({ ...fetched, pageNumber });
      assertLeafPage(page, pageNumber);
      pages.push(page);
      rows.push(...page.rows);
      if (page.physical_page.pagination_complete) break;
      cursor = page.physical_page.next_cursor;
      if (cursors.has(cursor)) throw new Error(`leaf cursor repeated at page ${pageNumber}`);
      cursors.add(cursor);
    }
    const finalPage = pages.at(-1);
    if (!finalPage?.physical_page?.pagination_complete) {
      throw new Error(`leaf measurement exceeded ${MAX_MEASUREMENT_PAGES} pages`);
    }
    return {
      schema_version: 2,
      measured_at_utc: new Date().toISOString(),
      case: item.name,
      variant: "physical_leaf_1024_paged",
      attempt: number,
      request: item,
      response: {
        status: finalPage.status,
        ok: pages.every((page) => page.ok),
        returned_rows: rows.length,
        response_complete: finalPage.response_complete,
        rows,
        rows_sha256: rowsSha256(rows),
        page_count: pages.length,
        rows_per_page: pages.map((page) => page.returned_rows),
        physical_segments_decoded_per_page: pages.map((page) => page.physical_page.segments_decoded),
        physical_rows_decoded_per_page: pages.map((page) => page.physical_page.physical_rows_decoded),
        physical_page_path_per_page: pages.map((page) => page.physical_page_path),
        manifest_objects_read_per_page: pages.map((page) => page.manifest_objects_read),
        leaf_objects_read_per_page: pages.map((page) => page.leaf_objects_read),
        index_bytes_read_per_page: pages.map((page) => page.index_bytes_read),
        whole_range_discovery_per_page: pages.map((page) => page.whole_range_discovery),
        global_segment_sort_per_page: pages.map((page) => page.global_segment_sort),
        diagnostic_request_ids_per_page: pages.map((page) => page.diagnostic_request_id),
        cf_rays_per_page: pages.map((page) => page.cf_ray),
        pages,
        error: null,
      },
      cloudflare_cpu_time_ms: null,
      cloudflare_cpu_time_source: "each page carries its own Cloudflare telemetry correlation identity",
    };
  } catch (error) {
    return {
      schema_version: 2,
      measured_at_utc: new Date().toISOString(),
      case: item.name,
      variant: "physical_leaf_1024_paged",
      attempt: number,
      request: item,
      response: {
        status: pages.at(-1)?.status ?? null,
        ok: false,
        returned_rows: rows.length,
        response_complete: false,
        rows,
        rows_sha256: rows.length ? rowsSha256(rows) : null,
        page_count: pages.length,
        rows_per_page: pages.map((page) => page.returned_rows),
        physical_segments_decoded_per_page: pages.map((page) => page.physical_page.segments_decoded),
        physical_rows_decoded_per_page: pages.map((page) => page.physical_page.physical_rows_decoded),
        physical_page_path_per_page: pages.map((page) => page.physical_page_path),
        manifest_objects_read_per_page: pages.map((page) => page.manifest_objects_read),
        leaf_objects_read_per_page: pages.map((page) => page.leaf_objects_read),
        index_bytes_read_per_page: pages.map((page) => page.index_bytes_read),
        whole_range_discovery_per_page: pages.map((page) => page.whole_range_discovery),
        global_segment_sort_per_page: pages.map((page) => page.global_segment_sort),
        diagnostic_request_ids_per_page: pages.map((page) => page.diagnostic_request_id),
        cf_rays_per_page: pages.map((page) => page.cf_ray),
        pages,
        error: error instanceof Error ? error.message : String(error),
      },
      cloudflare_cpu_time_ms: null,
      cloudflare_cpu_time_source: null,
    };
  }
}

async function main() {
  const options = parse(process.argv.slice(2));
  const matrix = selectCases(buildPhysicalLeafMeasurementMatrix(), options.caseNames);
  const variants = options.leafOnly
    ? ["physical_leaf_1024_paged"]
    : ["physical_1024", "physical_leaf_1024_paged"];
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      repeat: options.repeat,
      variants,
      cases: matrix,
      physical_contract: {
        max_logical_request_hours: 24,
        max_segments_per_leaf_invocation: 1,
        max_physical_rows_per_leaf_invocation: 1024,
        client_follows_physical_cursor: true,
        cursor_schema_version: 2,
        first_page_path: "initial_discovery",
        same_leaf_continuation_path: "direct_leaf_continuation",
        same_leaf_continuation_manifest_objects: 0,
        fixture_expected_pages_are_evidence_not_runtime_configuration: true,
      },
    }, null, 2)}\n`);
    return;
  }

  const endpoints = {
    physical_leaf_1024_paged: endpoint(
      options.physicalLeafEndpoint,
      PHYSICAL_LEAF_HOST,
      "physical leaf endpoint",
    ),
  };
  if (!options.leafOnly) {
    endpoints.physical_1024 = endpoint(
      options.physical1024Endpoint,
      PHYSICAL_1024_HOST,
      "physical 1024 endpoint",
    );
  }
  const secret = String(process.env.UK_AQ_EDGE_UPSTREAM_SECRET || "");
  if (!secret) throw new Error("UK_AQ_EDGE_UPSTREAM_SECRET is required");

  const stamp = new Date().toISOString();
  const directory = path.resolve(options.outputDir || path.join(
    "tmp",
    "index_v3_physical_leaf_measurements",
    stamp.replaceAll(/[-:]/g, ""),
  ));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "run.json"), `${JSON.stringify({
    schema_version: 2,
    run_id: crypto.randomUUID(),
    started_at_utc: stamp,
    repeat: options.repeat,
    cases: matrix.length,
    variants,
    endpoints: Object.fromEntries(Object.entries(endpoints).map(([key, value]) => [key, value.origin])),
  }, null, 2)}\n`, { flag: "wx" });

  let sequence = 0;
  for (const item of matrix) {
    for (let number = 1; number <= options.repeat; number += 1) {
      const pair = [];
      for (const variant of variants) {
        sequence += 1;
        const result = variant === "physical_1024"
          ? await attemptPhysical1024({ base: endpoints[variant], item, number, secret, timeoutMs: options.timeoutMs })
          : await attemptPhysicalLeaf({ base: endpoints[variant], item, number, secret, timeoutMs: options.timeoutMs });
        pair.push(result);
        const filename = `${String(sequence).padStart(3, "0")}_${item.name}_${variant}_attempt${number}.json`;
        fs.writeFileSync(path.join(directory, filename), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
        fs.appendFileSync(path.join(directory, "results.jsonl"), `${JSON.stringify(result)}\n`);
        process.stdout.write(`${JSON.stringify({
          case: item.name,
          variant,
          attempt: number,
          status: result.response.status,
          rows: result.response.returned_rows,
          pages: result.response.page_count ?? 1,
          rows_sha256: result.response.rows_sha256,
          error: result.response.error,
        })}\n`);
      }
      const byVariant = Object.fromEntries(pair.map((result) => [result.variant, result]));
      const physical = byVariant.physical_1024;
      const leaf = byVariant.physical_leaf_1024_paged;
      const exactRowsEqual = physical?.response.rows && leaf?.response.rows
        ? JSON.stringify(physical.response.rows) === JSON.stringify(leaf.response.rows)
        : null;
      const comparison = {
        schema_version: 2,
        case: item.name,
        attempt: number,
        variants,
        comparable: Boolean(physical?.response.rows_sha256 && leaf?.response.rows_sha256),
        rows_sha256_equal: physical?.response.rows_sha256 && leaf?.response.rows_sha256
          ? physical.response.rows_sha256 === leaf.response.rows_sha256
          : null,
        exact_ordered_rows_equal: exactRowsEqual,
        physical_1024_rows_sha256: physical?.response.rows_sha256 ?? null,
        physical_leaf_assembled_rows_sha256: leaf?.response.rows_sha256 ?? null,
        physical_leaf_page_count: leaf?.response.page_count ?? null,
        fixture_expected_leaf_pages: item.fixture_expected_leaf_pages,
      };
      fs.appendFileSync(path.join(directory, "comparisons.jsonl"), `${JSON.stringify(comparison)}\n`);
      if (leaf && (!leaf.response.ok || leaf.response.response_complete !== true)) {
        throw new Error(`paged leaf measurement failed for ${item.name} attempt ${number}`);
      }
      if (leaf?.response.page_count !== item.fixture_expected_leaf_pages) {
        throw new Error(`paged leaf fixture page-count mismatch for ${item.name} attempt ${number}`);
      }
      if (physical && (!physical.response.ok || physical.response.response_complete !== true)) {
        throw new Error(`physical-1024 reference failed for ${item.name} attempt ${number}`);
      }
      if (comparison.comparable && (!comparison.rows_sha256_equal || exactRowsEqual !== true)) {
        throw new Error(`assembled exact rows or SHA-256 mismatch for ${item.name} attempt ${number}`);
      }
    }
  }
  process.stdout.write(`results=${directory}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
