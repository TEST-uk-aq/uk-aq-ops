// Lossless schema-3/4 wire encoding. Repeated references, identities, diagnostics
// and scalar strings are interned once. Expansion always precedes semantic
// validation; table references confer no authority of their own.
import { canonicalJson } from './schema.mjs';
import { LIMITS, evidence } from './limits.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';

const check = (ok, detail) => evidence(ok, 'invalid_report', detail);
const ENCODING = 'interned_json_tree_v1';
const MAX_NODES = 200_000, MAX_DEPTH = 128;

export function encodeCompactReport(report) {
  check([3, 4].includes(report?.schema_version) && report.kind === 'uk_aq_jsongen_reconciliation' && !report.encoding,
    'Expanded schema-3/4 reconciliation required');
  const bytes = canonicalJson(report);
  evidence(bytes.length <= LIMITS.uncompressed_bytes, 'resource_limit', 'Expanded report exceeds decode memory envelope');
  const nodes = [], interned = new Map(), objects = new WeakMap(), visiting = new WeakSet();
  let nodeBytes = 0;
  const visit = (value, depth = 0) => {
    check(depth <= MAX_DEPTH, 'Report nesting exceeds bounded encoding');
    let node;
    if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) {
      check(typeof value !== 'number' || Number.isFinite(value), 'Non-finite report number');
      node = ['v', value];
    } else {
      check(value && typeof value === 'object', 'Unsupported report value');
      if (objects.has(value)) return objects.get(value);
      check(!visiting.has(value), 'Cyclic report'); visiting.add(value);
      node = Array.isArray(value) ? ['a', value.map(v => visit(v, depth + 1))]
        : ['o', Object.keys(value).sort().filter(key => value[key] !== undefined)
          .flatMap(key => [key, visit(value[key], depth + 1)])];
      visiting.delete(value);
    }
    const key = canonicalJson(node).toString('utf8');
    let id = interned.get(key);
    if (id === undefined) {
      id = nodes.length; nodes.push(node); interned.set(key, id); nodeBytes += Buffer.byteLength(key);
      evidence(nodes.length <= MAX_NODES && nodeBytes <= LIMITS.report_bytes,
        'resource_limit', 'Compact report table exceeds wire envelope');
    }
    if (value && typeof value === 'object') objects.set(value, id);
    return id;
  };
  const root = visit(report);
  const result = { schema_version: report.schema_version, kind: report.kind, encoding: ENCODING,
    expanded_sha256: sha256Hex(bytes), expanded_byte_size: bytes.length, nodes, root };
  evidence(canonicalJson(result).length <= LIMITS.report_bytes, 'resource_limit', 'Compact report exceeds 4 MiB wire envelope');
  return result;
}

export function decodeCompactReport(report) {
  if (!report?.encoding) return report;
  const fields = ['schema_version', 'kind', 'encoding', 'expanded_sha256', 'expanded_byte_size', 'nodes', 'root'];
  check([3, 4].includes(report.schema_version) && report.kind === 'uk_aq_jsongen_reconciliation'
    && report.encoding === ENCODING && Object.keys(report).length === fields.length
    && fields.every(k => Object.hasOwn(report, k)) && Array.isArray(report.nodes)
    && report.nodes.length > 0 && report.nodes.length <= MAX_NODES
    && /^[a-f0-9]{64}$/.test(report.expanded_sha256)
    && Number.isSafeInteger(report.expanded_byte_size) && report.expanded_byte_size > 0
    && report.expanded_byte_size <= LIMITS.uncompressed_bytes,
  'Invalid compact report header');
  // Bound the table's flat grammar before serializing untrusted structures.
  for (const node of report.nodes) {
    check(Array.isArray(node) && node.length === 2, 'Malformed report table node');
    check(node[0] === 'v' ? node[1] === null || ['string', 'boolean', 'number'].includes(typeof node[1])
      : ['a', 'o'].includes(node[0]) && Array.isArray(node[1]) && node[1].length <= MAX_NODES
        && node[1].every((v, i) => node[0] === 'o' && i % 2 === 0 ? typeof v === 'string' : Number.isSafeInteger(v)),
    'Invalid report table grammar');
  }
  evidence(canonicalJson(report).length <= LIMITS.report_bytes, 'resource_limit', 'Compact report wire limit exceeded');
  const values = [], sizes = [], depths = [], unique = new Set();
  const child = (id, current) => {
    check(Number.isSafeInteger(id) && id >= 0 && id < current, 'Missing, forward or cyclic report table reference');
    return values[id];
  };
  for (let i = 0; i < report.nodes.length; i++) {
    const node = report.nodes[i]; check(Array.isArray(node) && node.length === 2, 'Malformed report table node');
    const nodeIdentity = canonicalJson(node).toString('utf8');
    check(!unique.has(nodeIdentity), 'Duplicate compact report node'); unique.add(nodeIdentity);
    const [kind, data] = node;
    let value, size, depth = 0;
    if (kind === 'v') {
      check(data === null || ['string', 'boolean', 'number'].includes(typeof data), 'Invalid report scalar');
      check(typeof data !== 'number' || Number.isFinite(data), 'Invalid report number');
      value = data; size = Buffer.byteLength(JSON.stringify(data));
    } else if (kind === 'a') {
      check(Array.isArray(data), 'Invalid report array'); value = data.map(id => child(id, i));
      size = 2 + Math.max(0, data.length - 1) + data.reduce((n, id) => n + sizes[id], 0);
      depth = 1 + data.reduce((n, id) => Math.max(n, depths[id]), 0);
    } else {
      check(kind === 'o' && Array.isArray(data) && data.length % 2 === 0, 'Invalid report object');
      const entries = []; let previous = null; size = 2;
      for (let k = 0; k < data.length; k += 2) {
        const key = data[k], id = data[k + 1];
        check(typeof key === 'string' && (previous === null || previous < key), 'Duplicate or unsorted report field');
        entries.push([key, child(id, i)]); previous = key;
        size += Buffer.byteLength(JSON.stringify(key)) + 1 + sizes[id] + (k ? 1 : 0);
        depth = Math.max(depth, depths[id] + 1);
      }
      value = Object.fromEntries(entries);
    }
    evidence(Number.isSafeInteger(size) && size <= LIMITS.uncompressed_bytes && depth <= MAX_DEPTH,
      'resource_limit', 'Report expansion/depth limit exceeded');
    values.push(value); sizes.push(size); depths.push(depth);
  }
  check(Number.isSafeInteger(report.root) && report.root >= 0 && report.root < values.length, 'Missing compact report root');
  // Canonical first-visit postorder proves reachability and deterministic IDs
  // without serializing and interning the entire expanded report a second time.
  const seen = new Set(); let next = 0;
  const visit = id => {
    if (seen.has(id)) return;
    const [kind, data] = report.nodes[id];
    if (kind === 'a') data.forEach(visit);
    if (kind === 'o') for (let k = 1; k < data.length; k += 2) visit(data[k]);
    check(id === next++, 'Noncanonical compact report node order'); seen.add(id);
  };
  visit(report.root); check(seen.size === report.nodes.length, 'Unused compact report nodes');
  const expanded = values[report.root];
  check(expanded?.schema_version === report.schema_version && !expanded.encoding && expanded.kind === report.kind,
    'Compact report cannot reinterpret an older schema');
  const bytes = canonicalJson(expanded);
  check(bytes.length === report.expanded_byte_size && sha256Hex(bytes) === report.expanded_sha256,
    'Compact report expanded byte identity mismatch');
  return expanded;
}
