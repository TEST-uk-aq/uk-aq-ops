// Preparation-only resource admission. These are code ceilings, never settings.
// Eight accepted maximum-size writer files bound compressed input; one accepted
// maximum-size file bounds the whole decoded row set. The 1 GiB estimate includes
// four input copies, four decoded-column copies, 1 KiB row bookkeeping plus two
// UTF-16 variable values per row, 512 bytes per graph item and 64 MiB parser/WASM
// reserve. This is a conservative admission estimate, not a TEST runtime capacity
// attestation. Supported physical evidence is additionally checked before WASM.
import * as zlib from "node:zlib";
import { getHeapStatistics } from "node:v8";
import { freemem } from "node:os";
import { ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3 as writer } from "../../../workers/shared/uk_aq_observation_history_writer_limits_v3.mjs";

const MiB = 1024 * 1024;
export const SCHEMA2_PREPARATION_LIMITS = Object.freeze({
  max_affected_dcps: 16, max_scopes: 64, max_objects: 4096, max_edges: 16384,
  max_total_body_bytes: 8 * writer.max_file_bytes,
  max_decoded_rows: writer.max_file_rows, max_uncompressed_bytes: 64 * MiB,
  max_estimated_peak_working_bytes: 1024 * MiB,
  max_json_body_bytes: writer.max_file_bytes,
  max_json_depth: 32, max_json_tokens: 131072, max_json_string_bytes: MiB,
  max_file_bytes: writer.max_file_bytes, max_file_rows: writer.max_file_rows,
  max_row_groups_per_file: writer.max_row_groups_per_file,
  max_row_group_rows: writer.max_row_group_rows,
  max_variable_value_bytes: 1024, max_page_bytes: MiB,
  max_zstd_window_bytes: writer.max_file_bytes, max_footer_bytes: MiB,
  max_thrift_nodes: 131072, max_thrift_depth: 16,
  max_page_header_bytes: 64 * 1024,
  runtime_memory_reserve_bytes: 64 * MiB,
});
const L = SCHEMA2_PREPARATION_LIMITS;

function blocked(message) { throw new Error(`schema-2 preparation resource admission blocked: ${message}`); }
function integer(value, name, max, zero = false) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) blocked(`unsafe ${name}`);
    value = Number(value);
  }
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > max) blocked(`${name} exceeds supported finite bound`);
  return value;
}

export function assertPreparationResourceTotals(totals) {
  const value = { ...totals };
  for (const [field, bound] of Object.entries({ affected_dcps: L.max_affected_dcps,
    scopes: L.max_scopes, objects: L.max_objects, edges: L.max_edges,
    total_body_bytes: L.max_total_body_bytes, decoded_rows: L.max_decoded_rows,
    uncompressed_bytes: L.max_uncompressed_bytes })) {
    value[field] = integer(value[field] ?? 0, field, bound, true);
  }
  const variable = integer(value.max_variable_value_bytes ?? L.max_variable_value_bytes,
    "variable value bytes", L.max_variable_value_bytes, true);
  value.estimated_peak_working_bytes = 64 * MiB + 4 * value.total_body_bytes +
    4 * value.uncompressed_bytes + value.decoded_rows * (1024 + 4 * variable) +
    (value.objects + value.edges) * 512;
  integer(value.estimated_peak_working_bytes, "estimated peak working bytes", L.max_estimated_peak_working_bytes);
  assertPreparationRuntimeCapacity(value.estimated_peak_working_bytes);
  return value;
}

// Dynamic readings decide admission only; never enter a deterministic freeze.
// Both heap and OS available memory must cover the estimate plus a fixed reserve.
// Buffers may live outside V8, so satisfying only the heap limit is insufficient.
export function assertPreparationRuntimeCapacity(requiredBytes = L.max_estimated_peak_working_bytes) {
  integer(requiredBytes, "required runtime bytes", L.max_estimated_peak_working_bytes);
  // availableMemory accounts for process/container constraints on supported
  // Node runtimes; host freemem alone does not establish a container's capacity.
  if (typeof process.availableMemory !== "function") blocked("runtime lacks container-aware available-memory inspector");
  const heap = getHeapStatistics(), usage = process.memoryUsage(), free = freemem(), available = process.availableMemory();
  if (![heap.heap_size_limit, usage.heapUsed, free, available].every(Number.isSafeInteger) ||
      heap.heap_size_limit <= 0 || free <= 0 || available <= 0 ||
      requiredBytes + L.runtime_memory_reserve_bytes > heap.heap_size_limit - usage.heapUsed ||
      requiredBytes + L.runtime_memory_reserve_bytes > Math.min(free, available)) blocked("current runtime cannot establish finite available heap/OS memory for estimate");
}

// Linear allocation-free lexical preflight for pinned JSON bytes. JSON.parse
// still performs syntax validation afterwards; this only admits a finite shape.
export function assertBoundedPreparationJson(rawBody) {
  if (!(rawBody instanceof Uint8Array) && typeof rawBody !== "string") blocked("JSON body must be pinned bytes or text");
  const length = typeof rawBody === "string" ? Buffer.byteLength(rawBody) : rawBody.byteLength;
  integer(length, "JSON body bytes", L.max_json_body_bytes);
  const bytes = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  const stack = []; let tokens = 0;
  const whitespace = b => b === 32 || b === 9 || b === 10 || b === 13;
  for (let at = 0; at < bytes.length;) {
    const b = bytes[at];
    if (whitespace(b)) { at++; continue; }
    if (++tokens > L.max_json_tokens) blocked("JSON token count");
    if (b === 34) {
      const start = at++; let closed = false;
      while (at < bytes.length) {
        if (at - start > L.max_json_string_bytes) blocked("JSON string bytes");
        const c = bytes[at++];
        if (c === 34) { closed = true; break; }
        if (c === 92) at++;
        else if (c < 32) blocked("JSON control character");
      }
      if (!closed) blocked("unterminated JSON string");
    } else if (b === 123 || b === 91) {
      stack.push(b); at++;
      if (stack.length > L.max_json_depth) blocked("JSON nesting depth");
    } else if (b === 125 || b === 93) {
      if (stack.pop() !== (b === 125 ? 123 : 91)) blocked("JSON container shape");
      at++;
    } else if (b === 44 || b === 58) at++;
    else {
      const start = at++;
      while (at < bytes.length && !whitespace(bytes[at]) && ![44, 58, 91, 93, 123, 125, 34].includes(bytes[at])) at++;
      if (at - start > 128) blocked("JSON primitive length");
    }
  }
  if (stack.length) blocked("unterminated JSON container");
}

// The general dependency Thrift reader allocates arrays from encoded lengths.
// Bound the compact protocol here before it or the Parquet decoder sees bytes.
function compact(body, start, end, maxBytes) {
  let offset = start, nodes = 0;
  const stop = Math.min(end, start + maxBytes);
  const need = n => { if (offset + n > stop) blocked("truncated or oversized Thrift structure"); };
  const byte = () => { need(1); return body[offset++]; };
  const varint = () => {
    let n = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const b = byte(); n |= BigInt(b & 127) << shift;
      if (!(b & 128)) return n;
    }
    blocked("oversized Thrift integer");
  };
  function value(type, depth) {
    if (++nodes > L.max_thrift_nodes || depth > L.max_thrift_depth) blocked("Thrift complexity");
    if (type === 1 || type === 2) return type === 1;
    if (type === 3) { const b = byte(); return b > 127 ? b - 256 : b; }
    if ([4, 5, 6].includes(type)) {
      const n = varint(); const signed = (n >> 1n) ^ -(n & 1n);
      if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) blocked("unsafe Thrift integer");
      return Number(signed);
    }
    if (type === 7) { need(8); const n = body.readDoubleLE(offset); offset += 8; return n; }
    if (type === 8) {
      const length = integer(varint(), "Thrift binary length", maxBytes, true);
      need(length); const bytes = body.subarray(offset, offset + length); offset += length; return bytes;
    }
    if (type === 9) {
      const b = byte(), element = b & 15;
      const length = (b >> 4) === 15 ? integer(varint(), "Thrift list length", L.max_thrift_nodes, true) : b >> 4;
      if (nodes + length > L.max_thrift_nodes || length > stop - offset) blocked("Thrift collection allocation");
      const items = [];
      for (let i = 0; i < length; i++) items.push(value(element === 1 || element === 2 ? 3 : element, depth + 1));
      return items;
    }
    if (type === 12) return structure(depth + 1);
    blocked("unsupported Thrift type");
  }
  function structure(depth) {
    if (depth > L.max_thrift_depth) blocked("Thrift depth");
    const result = {}; let field = 0;
    while (true) {
      const b = byte(), type = b & 15;
      if (!type) return result;
      field = b >> 4 ? field + (b >> 4) : value(4, depth);
      integer(field, "Thrift field", 32767);
      if (Object.hasOwn(result, field)) blocked("duplicate Thrift field");
      result[field] = value(type, depth);
    }
  }
  const result = structure(0);
  return { result, end: offset };
}

function zstdBound(input, expected) {
  if (input.length < 9 || input.readUInt32LE(0) !== 0xfd2fb528) blocked("unsupported ZSTD frame (standard single frame required)");
  const flag = input[4], single = (flag >> 5) & 1, fcsFlag = flag >> 6;
  if (flag & 0x1b) blocked("unsupported ZSTD reserved bits or dictionary");
  let at = single ? 5 : 6;
  const sizeBytes = fcsFlag ? 1 << fcsFlag : single;
  if (at + sizeBytes > input.length) blocked("truncated ZSTD frame");
  let content = 0n;
  for (let i = 0; i < sizeBytes; i++) content |= BigInt(input[at++]) << BigInt(8 * i);
  if (fcsFlag === 1) content += 256n;
  if (sizeBytes && content !== BigInt(expected)) blocked("ZSTD content size differs from bounded page size");
  const wd = input[5], base = 2 ** (10 + (wd >> 3));
  const window = single ? integer(content, "ZSTD window", L.max_zstd_window_bytes, true) : base + base / 8 * (wd & 7);
  integer(window, "ZSTD window", L.max_zstd_window_bytes, true);
  let bound = 0, blocks = 0, last = false;
  while (!last) {
    if (at + 3 > input.length || ++blocks > 128) blocked("ZSTD block count/truncation");
    const h = input[at] | input[at + 1] << 8 | input[at + 2] << 16; at += 3;
    last = !!(h & 1); const type = (h >> 1) & 3, size = h >> 3;
    if (type === 3 || size > 131072) blocked("unsupported ZSTD block");
    bound += type === 2 ? Math.min(131072, window) : size;
    if (bound > L.max_page_bytes) blocked("ZSTD worst-case page allocation");
    at += type === 1 ? 1 : size;
    if (at > input.length) blocked("truncated ZSTD block");
  }
  if (flag & 4) at += 4;
  if (at !== input.length) blocked("ZSTD concatenated/skippable/trailing frame bytes");
  // Frame/window/block maxima are established before the decompressor allocates.
  if (typeof zlib.zstdDecompressSync !== "function") blocked("runtime lacks bounded native ZSTD inspector");
  const decoded = zlib.zstdDecompressSync(input, { maxOutputLength: Math.max(1, expected) });
  if (decoded.length !== expected) blocked("actual ZSTD page length differs from header");
  return Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

// hyparquet's RLE loop writes the encoded run length even beyond its initially
// sized output array. Validate run counts and bit widths before that loop runs.
function hybrid(bytes, start, end, width, expected, maxValue) {
  let at = start, seen = 0, nonzero = 0;
  if (width < 0 || width > 10) blocked("unsupported RLE bit width");
  while (seen < expected) {
    let header = 0, shift = 0, b;
    do {
      if (at >= end || shift > 28) blocked("truncated/oversized RLE header");
      b = bytes[at++]; header += (b & 127) * 2 ** shift; shift += 7;
    } while (b & 128);
    const packed = !!(header & 1), count = packed ? Math.floor(header / 2) * 8 : header / 2;
    if (!count || count > expected - seen + (packed ? 7 : 0)) blocked("RLE run exceeds bounded value count");
    const byteCount = packed ? count * width / 8 : Math.ceil(width / 8);
    if (at + byteCount > end) blocked("RLE run exceeds page");
    if (packed) {
      for (let i = 0; i < count; i++) {
        let value = 0;
        for (let bit = 0; bit < width; bit++) value |= ((bytes[at + Math.floor((i * width + bit) / 8)] >> ((i * width + bit) % 8)) & 1) << bit;
        if (i + seen < expected) {
          if (value > maxValue) blocked("RLE value exceeds dictionary/level domain");
          if (value) nonzero++;
        }
      }
    } else {
      let value = 0;
      for (let i = 0; i < byteCount; i++) value += bytes[at + i] * 2 ** (8 * i);
      if (value > maxValue) blocked("RLE value exceeds dictionary/level domain");
      if (value) nonzero += count;
    }
    at += byteCount; seen += count;
  }
  if (at !== end) blocked("unconsumed RLE stream bytes");
  return nonzero;
}

function checkDataValues(decoded, count, encoding, type, dictionaryCount) {
  if (decoded.length < 4) blocked("data page definition levels unavailable");
  const levelBytes = decoded.readUInt32LE(0), end = 4 + levelBytes;
  if (end > decoded.length) blocked("definition levels exceed page");
  const nonNull = hybrid(decoded, 4, end, 1, count, 1);
  if (encoding === 0) {
    if (decoded.length - end !== nonNull * (type === 1 ? 4 : 8)) blocked("PLAIN numeric page size");
  } else {
    if (end >= decoded.length) blocked("dictionary data bit width unavailable");
    const width = decoded[end];
    if (width > Math.max(1, Math.ceil(Math.log2(dictionaryCount)))) blocked("dictionary data bit width");
    if (width === 0) {
      if (decoded.length !== end + 1) hybrid(decoded, end + 1, decoded.length, 0, nonNull, Math.max(0, dictionaryCount - 1));
    } else hybrid(decoded, end + 1, decoded.length, width, nonNull, dictionaryCount - 1);
  }
}

export function preflightPhysicalBody(rawBody, { row_count: expectedRows = null } = {}) {
  if (!(rawBody instanceof Uint8Array)) blocked("physical body must be pinned bytes");
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  integer(body.length, "physical file bytes", L.max_file_bytes);
  if (body.length < 12 || body.toString("ascii", 0, 4) !== "PAR1" || body.toString("ascii", body.length - 4) !== "PAR1") blocked("unsupported Parquet magic");
  const footerBytes = integer(body.readUInt32LE(body.length - 8), "Parquet footer bytes", L.max_footer_bytes);
  const dataEnd = body.length - 8 - footerBytes;
  if (dataEnd < 4) blocked("Parquet footer overlaps data");
  const footer = compact(body, dataEnd, body.length - 8, L.max_footer_bytes);
  if (footer.end !== body.length - 8) blocked("trailing Parquet footer bytes");
  const meta = footer.result, rows = integer(meta[3], "physical file rows", L.max_file_rows);
  if (expectedRows !== null && expectedRows !== rows) blocked("physical row count differs from canonical metadata");
  if (!Array.isArray(meta[2]) || meta[2].length !== 8 || !Array.isArray(meta[4])) blocked("unsupported physical schema/group metadata");
  integer(meta[4].length, "row groups", L.max_row_groups_per_file);
  if (meta[8] || meta[9]) blocked("encrypted physical schema unsupported");
  if (meta[2][0][4]?.toString() !== "arrow_schema" || meta[2][0][5] !== 7) blocked("unsupported physical root schema");
  const names = ["connector_id", "station_id", "timeseries_id", "pollutant_code", "observed_at_utc", "value", "verification_status"];
  const types = [1, 1, 1, 6, 2, 5, 6];
  for (let i = 0; i < names.length; i++) {
    const column = meta[2][i + 1];
    if (column[1] !== types[i] || column[3] !== 1 || column[4]?.toString() !== names[i]) blocked("unsupported physical column schema");
  }
  let uncompressed = 0, pageCount = 0, countedRows = 0, maxVariable = 0;
  const spans = [];
  for (const group of meta[4]) {
    const groupRows = integer(group[3], "row-group rows", L.max_row_group_rows); countedRows += groupRows;
    if (!Array.isArray(group[1]) || group[1].length !== 7) blocked("unsupported physical column count");
    for (const [ordinal, column] of group[1].entries()) {
      if (column[1] || column[8] || column[9]) blocked("external/encrypted column unsupported");
      for (const [offsetField, lengthField] of [[4, 5], [6, 7]]) {
        if (column[offsetField] === undefined && column[lengthField] === undefined) continue;
        const indexStart = integer(column[offsetField], "physical index start", dataEnd);
        const indexLength = integer(column[lengthField], "physical index bytes", L.max_footer_bytes);
        if (indexStart < 4 || indexStart + indexLength > dataEnd) blocked("physical index outside data region");
        spans.push([indexStart, indexStart + indexLength]);
        const index = compact(body, indexStart, indexStart + indexLength, L.max_footer_bytes);
        if (index.end !== indexStart + indexLength) blocked("trailing physical index bytes");
      }
      const c = column[3];
      if (!c || c[1] !== types[ordinal] || c[4] !== 6 || c[5] !== groupRows ||
          !Array.isArray(c[3]) || c[3].length !== 1 || c[3][0]?.toString() !== names[ordinal]) blocked("unsupported column profile/codec");
      const start = integer(c[11] ?? c[9], "column start", dataEnd), length = integer(c[7], "column bytes", L.max_file_bytes);
      const end = start + length;
      if (start < 4 || end > dataEnd) blocked("column outside physical data");
      spans.push([start, end]);
      let at = start, columnDecoded = 0, values = 0, dictionary = false, dictionaryCount = 0, columnPages = 0;
      while (at < end) {
        if (++columnPages > 16 || ++pageCount > L.max_row_groups_per_file * 7 * 16) blocked("page count");
        const header = compact(body, at, end, L.max_page_header_bytes), p = header.result;
        const headerBytes = header.end - at;
        const plain = integer(p[2], "page uncompressed bytes", L.max_page_bytes, true);
        const compressed = integer(p[3], "page compressed bytes", L.max_page_bytes);
        if (header.end + compressed > end) blocked("page exceeds column chunk");
        const decoded = zstdBound(body.subarray(header.end, header.end + compressed), plain);
        if (p[1] === 2) {
          const count = integer(p[7]?.[1], "dictionary values", groupRows, true);
          if (dictionary || values || p[7]?.[2] !== 0 || p[5] || p[8]) blocked("unsupported dictionary profile");
          dictionary = true;
          dictionaryCount = count;
          if (types[ordinal] === 6) {
            let cursor = 0;
            for (let n = 0; n < count; n++) {
              if (cursor + 4 > decoded.length) blocked("truncated variable dictionary");
              const size = integer(decoded.readUInt32LE(cursor), "variable dictionary value", L.max_variable_value_bytes, true);
              cursor += 4 + size; maxVariable = Math.max(maxVariable, size);
              if (cursor > decoded.length) blocked("variable dictionary exceeds page");
            }
            if (cursor !== decoded.length) blocked("extra dictionary bytes");
          } else if (decoded.length !== count * (types[ordinal] === 1 ? 4 : 8)) blocked("numeric dictionary size");
        } else if (p[1] === 0) {
          const d = p[5];
          const count = integer(d?.[1], "data page values", groupRows);
          if (!d || ![0, 8].includes(d[2]) || d[3] !== 3 || d[4] !== 3 || p[7] || p[8] ||
              (d[2] === 8 && !dictionary) || (types[ordinal] === 6 && d[2] !== 8)) blocked("unsupported data-page/variable encoding");
          values += count;
          if (values > groupRows) blocked("data-page values exceed group");
          checkDataValues(decoded, count, d[2], types[ordinal], dictionaryCount);
        } else blocked("unsupported physical page type (only v1 data/dictionary supported)");
        columnDecoded += headerBytes + plain;
        uncompressed += plain;
        if (uncompressed > L.max_uncompressed_bytes) blocked("aggregate uncompressed file bytes");
        at = header.end + compressed;
      }
      if (values !== groupRows || columnDecoded !== c[6]) blocked("physical column values/uncompressed totals disagree");
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (spans.some((span, i) => i > 0 && span[0] < spans[i - 1][1])) blocked("overlapping physical columns");
  if (countedRows !== rows) blocked("file/group row totals disagree");
  const totals = assertPreparationResourceTotals({ total_body_bytes: body.length,
    decoded_rows: rows, uncompressed_bytes: uncompressed, max_variable_value_bytes: maxVariable });
  return Object.freeze({ row_count: rows, row_group_count: meta[4].length,
    page_count: pageCount, uncompressed_bytes: uncompressed,
    max_variable_value_bytes: maxVariable, estimated_peak_working_bytes: totals.estimated_peak_working_bytes });
}
