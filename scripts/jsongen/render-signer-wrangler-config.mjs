#!/usr/bin/env node

// Render the ignored deployment-only Wrangler file from explicit environment
// values. The checked-in base config intentionally has no account or route.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workerDirectory = resolve(repositoryRoot, 'workers/uk_aq_jsongen_signer');
const basePath = resolve(workerDirectory, 'wrangler.toml');
const outputPath = resolve(process.argv[2] || resolve(workerDirectory, 'wrangler.deploy.toml'));
const fail = message => { throw new Error(message); };
const required = name => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim())
    fail(`Missing or invalid ${name}`);
  return value;
};
const replaceOnce = (source, pattern, replacement, label) => {
  const matches = source.match(pattern) || [];
  if (matches.length !== 1) fail(`Expected exactly one ${label} in base Wrangler config`);
  return source.replace(pattern, replacement);
};
const tomlString = value => JSON.stringify(value);

const environment = required('UK_AQ_ENV_NAME');
const enabled = required('UK_AQ_JSONGEN_SIGNER_ENABLED');
const deployAccount = required('CLOUDFLARE_ACCOUNT_ID');
const r2Account = required('UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID');
const bucket = required('UK_AQ_JSONGEN_R2_BUCKET');
const r2Endpoint = required('UK_AQ_JSONGEN_R2_ENDPOINT');
const workerName = required('UK_AQ_JSONGEN_SIGNER_WORKER_NAME');
const signerUrlValue = required('UK_AQ_JSONGEN_PRUNE_SIGNER_URL');
const namespaceId = required('UK_AQ_JSONGEN_SIGNER_RATE_LIMIT_NAMESPACE_ID');

if (environment !== 'TEST' || !['false', 'true'].includes(enabled))
  fail('This renderer only accepts an explicit TEST environment and boolean enablement');
if (!/^[a-f0-9]{32}$/.test(deployAccount) || r2Account !== deployAccount)
  fail('Cloudflare deployment and R2 account settings must be the same valid account ID');
if (r2Endpoint !== `https://${deployAccount}.r2.cloudflarestorage.com`)
  fail('Configured R2 endpoint must match the deployment account S3 endpoint');
if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..'))
  fail('A valid configured TEST JSONgen R2 bucket is required');
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName))
  fail('A valid configured TEST signer Worker name is required');
let signerUrl;
try { signerUrl = new URL(signerUrlValue); }
catch { fail('UK_AQ_JSONGEN_PRUNE_SIGNER_URL must be the configured HTTPS signer endpoint'); }
const hostname = signerUrl.hostname;
const labels = hostname.split('.');
if (signerUrl.protocol !== 'https:' || signerUrl.port || signerUrl.username || signerUrl.password
  || signerUrl.pathname !== '/v1/upload-intents' || signerUrl.search || signerUrl.hash
  || hostname.length > 253 || labels.length < 2 || isIP(hostname)
  || hostname === 'workers.dev'
  || hostname.endsWith('.workers.dev')
  || !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
  fail('A valid custom hostname is required; workers.dev and preview endpoints are not accepted');
if (!/^[1-9]\d*$/.test(namespaceId) || !Number.isSafeInteger(Number(namespaceId)))
  fail('An operator-allocated positive rate-limit namespace ID is required');

let config = await readFile(basePath, 'utf8');
config = replaceOnce(config, /^name = "jsongen-signer"$/gm,
  `name = ${tomlString(workerName)}\naccount_id = ${tomlString(deployAccount)}`,
  'generic Worker name');
config = replaceOnce(config, /^preview_urls = false$/gm,
  `preview_urls = false\nroutes = [{ pattern = ${tomlString(hostname)}, custom_domain = true }]`,
  'disabled preview setting');
config = replaceOnce(config, /^\[vars\]$/gm,
  `[vars]\nUK_AQ_ENV_NAME = ${tomlString(environment)}\nUK_AQ_R2_CLOUDFLARE_ACCOUNT_ID = ${tomlString(r2Account)}\nUK_AQ_JSONGEN_R2_BUCKET = ${tomlString(bucket)}`,
  'Worker vars table');
config = replaceOnce(config, /^UK_AQ_JSONGEN_SIGNER_ENABLED = "false"$/gm,
  `UK_AQ_JSONGEN_SIGNER_ENABLED = ${tomlString(enabled)}`,
  'disabled-by-default enablement');
config += `\n[[ratelimits]]\nname = "UK_AQ_JSONGEN_SIGNER_RATE_LIMIT"\nnamespace_id = ${tomlString(namespaceId)}\nsimple = { limit = 10, period = 10 }\n`;

if (outputPath === basePath || dirname(outputPath) !== workerDirectory)
  fail('Output must be a deployment-only TOML beside worker.mjs and must not replace wrangler.toml');
await writeFile(outputPath, config, { mode: 0o600 });
process.stdout.write(`Rendered TEST signer Wrangler config: ${outputPath}\n`);
