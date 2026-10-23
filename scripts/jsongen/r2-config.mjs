import { configuredEnvironment } from './environment.mjs';
import { assertConfiguredIdentity } from './admission.mjs';
// Shared private JSONgen R2 target plus operation-specific credentials.
// Callers must choose READ or WRITE explicitly; there are no credential fallbacks.
const credentialModes = new WeakMap();
const configuredTargets = new WeakMap();
const configuredEnvironments = new WeakMap();

function invalidConfiguration(message) {
  const error = new Error(message);
  error.code = 'invalid_r2_configuration';
  throw error;
}

export function managedR2TargetConfig(env = process.env) {
  try { assertConfiguredIdentity(env); } catch { invalidConfiguration('Explicit environment and configured repository required'); }
  const environment = configuredEnvironment(env);
  const endpointValue = env.UK_AQ_JSONGEN_R2_ENDPOINT;
  if (typeof endpointValue !== 'string' || !endpointValue || endpointValue !== endpointValue.trim())
    invalidConfiguration('UK_AQ_JSONGEN_R2_ENDPOINT is required');
  let endpoint;
  try { endpoint = new URL(endpointValue); }
  catch { invalidConfiguration('UK_AQ_JSONGEN_R2_ENDPOINT must be a valid HTTPS R2 endpoint'); }
  if (endpoint.protocol !== 'https:' || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(endpoint.hostname)
    || endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
    || endpoint.username || endpoint.password)
    invalidConfiguration('UK_AQ_JSONGEN_R2_ENDPOINT must be an account-scoped HTTPS R2 S3 endpoint');

  const bucket = env.UK_AQ_JSONGEN_R2_BUCKET;
  if (typeof bucket !== 'string' || bucket !== bucket.trim()
    || !/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    || bucket.includes('..'))
    invalidConfiguration('UK_AQ_JSONGEN_R2_BUCKET is required and must be a valid bucket name');
  const target = Object.freeze({ endpoint: endpoint.origin, bucket, region: 'auto' });
  configuredTargets.set(target, target);
  configuredEnvironments.set(target, environment);
  return target;
}

export function assertManagedR2Target(r2, env = process.env) {
  const expected = configuredTargets.get(r2) || managedR2TargetConfig(env);
  if (r2?.endpoint !== expected.endpoint || r2?.bucket !== expected.bucket || r2?.region !== expected.region)
    invalidConfiguration('R2 client target differs from the explicit JSONgen environment configuration');
  return expected;
}

function managedR2CredentialConfig(env, accessMode) {
  const target = managedR2TargetConfig(env);
  const names = accessMode === 'read'
    ? ['UK_AQ_JSONGEN_R2_READ_ACCESS_KEY_ID', 'UK_AQ_JSONGEN_R2_READ_SECRET_ACCESS_KEY']
    : ['UK_AQ_JSONGEN_R2_WRITE_ACCESS_KEY_ID', 'UK_AQ_JSONGEN_R2_WRITE_SECRET_ACCESS_KEY'];
  const [accessName, secretName] = names;
  const accessKeyId = env[accessName];
  const secretAccessKey = env[secretName];
  if (typeof accessKeyId !== 'string' || !accessKeyId.trim()
    || typeof secretAccessKey !== 'string' || !secretAccessKey.trim())
    invalidConfiguration(`Both ${accessName} and ${secretName} are required`);
  if (env.CFLARE_R2_ACCESS_KEY_ID && accessKeyId === env.CFLARE_R2_ACCESS_KEY_ID)
    invalidConfiguration(`${accessName} must be separate from canonical Prune R2 credentials`);
  const config = Object.freeze({ ...target, access_key_id: accessKeyId, secret_access_key: secretAccessKey });
  configuredTargets.set(config, target);
  configuredEnvironments.set(config, configuredEnvironments.get(target));
  credentialModes.set(config, accessMode);
  return config;
}

export function managedR2ReadConfig(env = process.env) {
  return managedR2CredentialConfig(env, 'read');
}

export function managedR2WriteConfig(env = process.env) {
  return managedR2CredentialConfig(env, 'write');
}

export function assertManagedR2CredentialMode(r2, accessMode) {
  if (credentialModes.get(r2) !== accessMode)
    invalidConfiguration(`Explicit JSONgen ${accessMode.toUpperCase()} R2 credentials are required for this operation`);
}

// Configuration captured by the trusted factory, never taken from source JSON.
// Plain read adapters still require the same explicit process configuration.
export function managedR2Environment(r2, env = process.env) {
  assertManagedR2Target(r2, env);
  return configuredEnvironments.get(r2) ?? configuredEnvironment(env);
}
