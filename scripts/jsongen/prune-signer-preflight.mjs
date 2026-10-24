// Configuration admission only. Never invoke transport, data clients or control.
import { validateHeaderValue } from 'node:http';
import { assertConfiguredIdentity } from './admission.mjs';
import { managedR2TargetConfig } from './r2-config.mjs';
import { resolvePruneSignerConfig } from './prune-signed-upload.mjs';

// Only reviewed constant messages may reach logs; never print caught errors or
// the resolved config (which contains credentials and private destinations).
const configurationItems = new Map([
  ['UK_AQ_JSONGEN_R2_ENDPOINT is required', 'UK_AQ_JSONGEN_R2_ENDPOINT'],
  ['UK_AQ_JSONGEN_R2_ENDPOINT must be a valid HTTPS R2 endpoint', 'UK_AQ_JSONGEN_R2_ENDPOINT'],
  ['UK_AQ_JSONGEN_R2_ENDPOINT must be an account-scoped HTTPS R2 S3 endpoint', 'UK_AQ_JSONGEN_R2_ENDPOINT'],
  ['UK_AQ_JSONGEN_R2_BUCKET is required and must be a valid bucket name', 'UK_AQ_JSONGEN_R2_BUCKET'],
  ['UK_AQ_JSONGEN_R2_BUCKET must be set before process launch', 'UK_AQ_JSONGEN_R2_BUCKET'],
  ['Prune signer URL required', 'UK_AQ_JSONGEN_PRUNE_SIGNER_URL'],
  ['Prune signer URL must be a reviewed HTTPS Access route /v1/upload-intents', 'UK_AQ_JSONGEN_PRUNE_SIGNER_URL'],
  ['Dedicated Prune signer token and Access credentials required',
    'UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN / UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_ID / UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_SECRET (dedicated credentials; writer token at least 32 characters)'],
]);

let currentItem = 'GitHub Actions execution context';
function check(item, validate) {
  currentItem = item;
  validate();
  console.log(`- PASS: ${item}`);
}
function requireCondition(condition) {
  if (!condition) throw new Error('Preflight prerequisite missing or invalid');
}

try {
  const env = process.env;
  check('GITHUB_ACTIONS=true and GITHUB_EVENT_NAME=workflow_dispatch', () => {
    requireCondition(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch');
  });
  check('UK_AQ_ENV_NAME=TEST', () => requireCondition(env.UK_AQ_ENV_NAME === 'TEST'));
  check('UK_AQ_GITHUB_REPO is explicit OWNER/REPO and equals actual GITHUB_REPOSITORY', () => {
    assertConfiguredIdentity(env);
  });
  check('UK_AQ_JSONGEN_R2_ENDPOINT and UK_AQ_JSONGEN_R2_BUCKET', () => {
    managedR2TargetConfig(env);
  });
  for (const [name, header] of [
    ['UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN', 'Authorization'],
    ['UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_ID', 'CF-Access-Client-Id'],
    ['UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_SECRET', 'CF-Access-Client-Secret'],
  ]) {
    check(`${name} is present and structurally valid for its HTTP header`, () => {
      const value = env[name];
      requireCondition(typeof value === 'string' && value.length > 0 && !/\s/.test(value));
      validateHeaderValue(header, header === 'Authorization' ? `Bearer ${value}` : value);
    });
  }
  check('Production resolvePruneSignerConfig admission (URL and dedicated credentials)', () => {
    resolvePruneSignerConfig(env);
  });
  console.log('\nPASS: Prune signer configuration is structurally ready in this TEST Actions context.');
  console.log('\nRemote signer authentication, target ownership, upload success and VERIFIED handover remain unverified.');
} catch (error) {
  const item = configurationItems.get(error?.message) || currentItem;
  console.log(`\nFAIL: Check ${item}. No configuration values are included in this report.`);
  process.exitCode = 1;
}
