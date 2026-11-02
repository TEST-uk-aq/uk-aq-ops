import { check, monthBounds, validateSelection, selectionKey, objectKey, HISTORY_JSON_MAX_MANIFEST_BYTES } from '../shared/uk_aq_historical_json.mjs';

const error = (status, code) => Response.json({ error: { code } }, { status, headers: { 'Cache-Control': 'no-store' } });
export async function historicalJson(request, env) {
  const began = performance.now(), url = new URL(request.url);
  const route = /^\/v2\/history-json\/(manifest|observations|aqi)$/.exec(url.pathname)?.[1];
  if (!route) return error(404, 'route_not_found');
  try {
    const common = ['connector_id', 'station_id', 'timeseries_id', 'pollutant', 'month'];
    const names = route === 'manifest' ? common : [...common, 'pub_id', 'source_id', 'algorithm_version', 'sha256'];
    check([...url.searchParams.keys()].length === names.length && names.every(k => url.searchParams.getAll(k).length === 1), 'query_invalid');
    const id = { connector_id: Number(url.searchParams.get('connector_id')), station_id: Number(url.searchParams.get('station_id')),
      timeseries_id: Number(url.searchParams.get('timeseries_id')), pollutant_code: url.searchParams.get('pollutant') };
    const month = url.searchParams.get('month');
    const bounds = monthBounds(month);
    check(Date.parse(bounds.end_utc) <= Date.parse(new Date().toISOString().slice(0, 7) + '-01T00:00:00.000Z'), 'closed_history_only');
    // No cached selector at either Worker: every manifest check is authoritative R2.
    const selected = await env.UK_AQ_COMPRESSED_CHART_BUCKET.get(selectionKey(id, month));
    if (!selected) return error(404, 'history_month_unavailable');
    if (selected.size < 1 || selected.size > HISTORY_JSON_MAX_MANIFEST_BYTES) {
      await selected.body.cancel(); return error(502, 'selection_size_invalid');
    }
    let manifest;
    try { manifest = JSON.parse(await selected.text()); } catch { return error(502, 'selection_json_invalid'); }
    try { validateSelection(manifest, id, month); } catch { return error(502, 'selection_inconsistent'); }
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store', 'X-UK-AQ-History-PubID': manifest.pub_id,
      'X-UK-AQ-History-Source': manifest.source_id, 'X-UK-AQ-History-Algorithm': manifest.algorithm_version,
      'X-UK-AQ-History-Selection-Checked-At': new Date().toISOString(), 'X-UK-AQ-History-Cache': 'R2',
      'X-UK-AQ-History-R2-Reads': route === 'manifest' ? '1' : '2' };
    if (route === 'manifest') {
      headers['Server-Timing'] = `history_selection;dur=${(performance.now() - began).toFixed(2)}`;
      return Response.json(manifest, { headers });
    }
    const descriptor = manifest.objects[route];
    if (url.searchParams.get('pub_id') !== manifest.pub_id || url.searchParams.get('source_id') !== manifest.source_id
      || url.searchParams.get('algorithm_version') !== manifest.algorithm_version || url.searchParams.get('sha256') !== descriptor.sha256)
      return error(409, 'history_publication_changed');
    const object = await env.UK_AQ_COMPRESSED_CHART_BUCKET.get(objectKey(manifest, route));
    // SHA-256 metadata is installed by the operator only after byte verification.
    // No month-wide hashing, decoding, aggregation or JSON transformation here.
    if (!object || object.size !== descriptor.byte_size || object.customMetadata?.sha256 !== descriptor.sha256) {
      await object?.body?.cancel(); return error(502, 'history_object_unavailable_or_inconsistent');
    }
    Object.assign(headers, { 'Content-Encoding': 'gzip', 'Content-Length': String(object.size),
      'Cache-Control': 'private, max-age=31536000, immutable', 'ETag': `"${descriptor.sha256}"`,
      'X-UK-AQ-History-Object-SHA256': descriptor.sha256, 'X-UK-AQ-History-Compressed-Bytes': String(object.size),
      'Server-Timing': `history_object;dur=${(performance.now() - began).toFixed(2)}` });
    return new Response(object.body, { encodeBody: 'manual', headers });
  } catch (err) {
    const code = String(err?.message || 'history_unavailable');
    return error(['query_invalid', 'identity_invalid', 'month_invalid', 'closed_history_only'].includes(code) ? 400 : 503,
      ['query_invalid', 'identity_invalid', 'month_invalid', 'closed_history_only'].includes(code) ? code : 'history_unavailable');
  }
}
