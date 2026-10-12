// Worker-compatible S3 SigV4 query presigning. The Node R2 helper signs requests
// with node:crypto and cannot run in a Worker or produce presigned URLs.
const encoder = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
const quote = value => encodeURIComponent(value).replace(/[!'()*]/g,
  character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = value => crypto.subtle.digest('SHA-256', encoder.encode(value));
async function hmac(key, value) {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(value)));
}
const queryString = entries => Object.entries(entries)
  .map(([key, value]) => [quote(key), quote(value)])
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  .map(([key, value]) => `${key}=${value}`).join('&');

export async function presignPut({ accountId, accessKeyId, secretAccessKey, bucket, key,
  checksumBase64, contentType, now = new Date(), expiresSeconds = 60 }) {
  if (!/^[a-f0-9]{32}$/.test(accountId) || !accessKeyId || !secretAccessKey
    || !/^[a-z0-9-]+$/.test(bucket) || !key.startsWith('managed/jsongen/v1/pending/unverified/')
    || !Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 60)
    throw new TypeError('invalid presigning configuration');
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const path = `/${quote(bucket)}/${key.split('/').map(quote).join('/')}`;
  const signedAt = new Date(now.getTime());
  signedAt.setUTCMilliseconds(0);
  const amzDate = signedAt.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const scope = `${amzDate.slice(0, 8)}/auto/s3/aws4_request`;
  const headers = {
    'content-type': contentType,
    host,
    'if-none-match': '*',
    'x-amz-checksum-sha256': checksumBase64,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonical = ['PUT', path, queryString(params),
    Object.keys(headers).sort().map(name => `${name}:${headers[name]}\n`).join(''),
    signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(await sha256(canonical))].join('\n');
  let signingKey = encoder.encode(`AWS4${secretAccessKey}`);
  for (const part of [amzDate.slice(0, 8), 'auto', 's3', 'aws4_request']) signingKey = await hmac(signingKey, part);
  params['X-Amz-Signature'] = hex(await hmac(signingKey, stringToSign));
  return {
    url: `https://${host}${path}?${queryString(params)}`,
    expiresAtUtc: new Date(signedAt.getTime() + expiresSeconds * 1000).toISOString(),
    headers: { 'Content-Type': contentType, 'If-None-Match': '*',
      'x-amz-checksum-sha256': checksumBase64 },
  };
}
