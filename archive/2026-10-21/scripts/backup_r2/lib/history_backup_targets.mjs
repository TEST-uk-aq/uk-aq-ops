import { spawnSync } from "node:child_process";

// These are the shared workflow remote names, not environment selectors.
export const HISTORY_R2_REMOTE = "uk_aq_r2";
export const HISTORY_DROPBOX_REMOTE = "uk_aq_dropbox";

function required(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required; no environment fallback is allowed`);
  return value;
}

function endpoint(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error("R2 endpoint must be an HTTPS origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || url.pathname !== "/") throw new Error("R2 endpoint must be an HTTPS origin");
  return url.origin;
}

export function resolveHistoryBackupR2(env = process.env) {
  // Accept either existing complete naming family; never assemble credentials
  // or a target from partially configured families. Reject conflicting aliases.
  const fields = ["ENDPOINT", "BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"];
  const family = fields.some((key) => String(env[`CFLARE_R2_${key}`] ?? "").trim())
    ? "CFLARE_R2" : "R2";
  const values = Object.fromEntries(fields.map((key) => [key, required(env, `${family}_${key}`)]));
  for (const key of [...fields, "REGION"]) {
    const primary = String(env[`CFLARE_R2_${key}`] ?? "").trim();
    const alias = String(env[`R2_${key}`] ?? "").trim();
    if (primary && alias && (key === "ENDPOINT" ? endpoint(primary) !== endpoint(alias) : primary !== alias)) {
      throw new Error(`Contradictory CFLARE_R2_${key} and R2_${key}`);
    }
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(values.BUCKET)) {
    throw new Error("Configured R2 bucket must be a bucket name, without a remote or prefix");
  }
  const region = String(env[`${family}_REGION`] ?? "").trim() || "auto";
  const alternateRegion = String(env[`${family === "R2" ? "CFLARE_R2" : "R2"}_REGION`] ?? "").trim();
  if (alternateRegion && alternateRegion !== region) {
    throw new Error("Contradictory configured R2 region and alternate naming family");
  }
  return Object.freeze({
    endpoint: endpoint(values.ENDPOINT), bucket: values.BUCKET,
    region,
    access_key_id: values.ACCESS_KEY_ID, secret_access_key: values.SECRET_ACCESS_KEY,
  });
}

function folder(value, name) {
  const normalized = value.replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")
      || /[:\\\x00-\x1f\x7f]/.test(normalized)) {
    throw new Error(`${name} must identify a nonempty Dropbox folder without traversal`);
  }
  return normalized;
}

export function configuredHistoryDropboxRoot(env = process.env) {
  return `${HISTORY_DROPBOX_REMOTE}:${folder(required(env, "UK_AQ_DROPBOX_ROOT"), "UK_AQ_DROPBOX_ROOT")}`
    + `/${folder(required(env, "UK_AQ_R2_HISTORY_DROPBOX_DIR"), "UK_AQ_R2_HISTORY_DROPBOX_DIR")}`;
}

export function assertHistoryBackupSource(sourceRoot, env = process.env) {
  const r2 = resolveHistoryBackupR2(env);
  if (sourceRoot !== `${HISTORY_R2_REMOTE}:${r2.bucket}`) {
    throw new Error("--source-root must exactly match uk_aq_r2:<configured R2 bucket>");
  }
  return r2;
}

export function assertHistoryBackupDestination(destRoot, env = process.env) {
  if (destRoot !== configuredHistoryDropboxRoot(env)) {
    throw new Error("--dest-root must exactly match the configured Dropbox backup root");
  }
}

// Inspect local configuration only. Never log config dump output (it contains
// credentials), including on failure. Prevent overrides that bypass this check.
export function assertHistoryBackupRemotes({ rcloneBin = "rclone", env = process.env, dropbox = true } = {}) {
  const r2 = resolveHistoryBackupR2(env);
  if (Object.keys(env).some((key) => key.startsWith("RCLONE_") && key !== "RCLONE_CONFIG")) {
    throw new Error("RCLONE_* overrides other than RCLONE_CONFIG are not allowed for guarded history backup");
  }
  const result = spawnSync(rcloneBin, ["config", "dump"], {
    env, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("Cannot inspect local rclone configuration for history backup");
  }
  let config;
  try { config = JSON.parse(result.stdout); }
  catch { throw new Error("Invalid local rclone configuration JSON"); }
  const source = config[HISTORY_R2_REMOTE];
  const allowedSourceKeys = new Set([
    "type", "provider", "env_auth", "access_key_id", "secret_access_key",
    "endpoint", "region", "acl", "no_check_bucket",
  ]);
  if (source?.type !== "s3" || source.provider !== "Cloudflare"
      || Object.keys(source).some((key) => !allowedSourceKeys.has(key))
      || String(source.env_auth || "false") !== "false"
      || source.access_key_id !== r2.access_key_id
      || !source.secret_access_key
      || endpoint(String(source.endpoint || "")) !== r2.endpoint
      || String(source.region || "auto") !== r2.region) {
    throw new Error("uk_aq_r2 remote contradicts configured R2 source identity");
  }
  if (dropbox) {
    const destination = config[HISTORY_DROPBOX_REMOTE];
    const allowedKeys = new Set(["type", "client_id", "client_secret", "token"]);
    let token;
    try { token = JSON.parse(destination?.token || ""); }
    catch { throw new Error("uk_aq_dropbox requires a configured OAuth token"); }
    if (destination?.type !== "dropbox"
        || Object.keys(destination).some((key) => !allowedKeys.has(key))
        || destination.client_id !== required(env, "DROPBOX_APP_KEY")
        || !destination.client_secret
        || token.refresh_token !== required(env, "DROPBOX_REFRESH_TOKEN")) {
      throw new Error("uk_aq_dropbox contradicts configured Dropbox identity or has unsupported path/account overrides");
    }
  }
}

export function assertIsolatedBindingRestoreDestination(destRoot, env = process.env) {
  const { bucket } = resolveHistoryBackupR2(env);
  const prefix = `${HISTORY_R2_REMOTE}:${bucket}-timeseries-binding-restore-`;
  if (!destRoot?.startsWith(prefix) || !/^[a-z0-9][a-z0-9-]*$/.test(destRoot.slice(prefix.length))
      || destRoot.slice(HISTORY_R2_REMOTE.length + 1).length > 63) {
    throw new Error("Restore destination must be uk_aq_r2:<configured bucket>-timeseries-binding-restore-<isolated run id>; active history buckets are forbidden");
  }
}
