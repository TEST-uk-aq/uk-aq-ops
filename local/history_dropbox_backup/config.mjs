// Local JSON configuration only. Never source an env file or inherit backup settings.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { assertHistoryBackupSource, assertHistoryBackupDestination, assertHistoryBackupRemotes,
  configuredHistoryDropboxRoot, resolveHistoryBackupR2 } from "../../scripts/backup_r2/lib/history_backup_targets.mjs";

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const now = () => new Date().toISOString();
export function requireSafe(condition, category = "configuration") {
  if (!condition) throw Object.assign(new Error(category), { category });
}
export function privatePath(filename, directory = false) {
  const s = fs.lstatSync(filename);
  requireSafe(!s.isSymbolicLink() && (directory ? s.isDirectory() : s.isFile())
    && s.uid === process.getuid() && (s.mode & 0o077) === 0, "file_permissions");
  requireSafe(fs.realpathSync(filename) === filename, "symlink_path");
  return filename;
}
export function mkdir(filename) {
  fs.mkdirSync(filename, { recursive: true, mode: 0o700 });
  privatePath(filename, true);
}
export function atomic(filename, value) {
  return atomicText(filename, `${JSON.stringify(value, null, 2)}\n`);
}
export function atomicText(filename, value) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, filename);
    const parent = fs.openSync(path.dirname(filename), "r");
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export function read(filename) {
  if (!fs.existsSync(filename)) return null;
  privatePath(filename);
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}
export function locations(environment, configFile) {
  requireSafe(["TEST", "LIVE"].includes(environment));
  requireSafe(path.isAbsolute(configFile));
  const config = path.resolve(configFile);
  requireSafe(config === configFile && path.basename(config) === "backup.json"
    && path.basename(path.dirname(config)) === "config"
    && path.basename(path.dirname(path.dirname(config))) === environment);
  const root = path.dirname(path.dirname(config));
  requireSafe(!root.startsWith(`${repo}/`) && root !== repo);
  return {
    environment, config, root,
    state: path.join(root, "state"), reports: path.join(root, "reports"),
    logs: path.join(root, "attempt-logs"), output: path.join(root, "launchd"),
    active: path.join(root, "state/active.json"),
    stop: path.join(root, "state/stop.json"),
    block: path.join(root, "state/supervision-block.json"),
    mutex: path.join(root, "state/supervisor.lock"),
    label: `uk.co.ukaq.history-dropbox-backup.${environment.toLowerCase()}`,
    plist: path.join(os.homedir(), "Library/LaunchAgents",
      `uk.co.ukaq.history-dropbox-backup.${environment.toLowerCase()}.plist`),
  };
}
export function prepare(p) {
  for (const dir of [p.root, path.dirname(p.config), p.state, p.reports, p.logs, p.output,
    path.join(p.state, "operations")]) mkdir(dir);
}
const requiredEnv = ["CFLARE_R2_ENDPOINT", "CFLARE_R2_BUCKET", "CFLARE_R2_REGION",
  "CFLARE_R2_ACCESS_KEY_ID", "CFLARE_R2_SECRET_ACCESS_KEY", "SUPABASE_DB_URL",
  "DROPBOX_APP_KEY", "DROPBOX_APP_SECRET", "DROPBOX_REFRESH_TOKEN",
  "OBS_AQIDB_SUPABASE_URL", "OBS_AQIDB_SECRET_KEY",
  "UK_AQ_DROPBOX_ROOT", "UK_AQ_R2_HISTORY_DROPBOX_DIR", "UK_AQ_R2_HISTORY_VERSION",
  "UK_AQ_R2_HISTORY_CHECKPOINT_BATCH_UNITS", "UK_AQ_R2_HISTORY_CHECKPOINT_FLUSH_SECONDS"];
export function postgresCAFile(c, p) {
  try {
    const filename = c.postgres_ca_file;
    const certs = path.join(path.dirname(p.config), "certs");
    const ingestdb = path.join(certs, "ingestdb");
    requireSafe(typeof filename === "string" && path.isAbsolute(filename)
      && path.resolve(filename) === filename && !/[\x00-\x1f\x7f]/.test(filename)
      && path.dirname(filename) === ingestdb);
    for (const dir of [p.root, path.dirname(p.config), certs, ingestdb]) privatePath(dir, true);
    privatePath(filename);
    const pem = fs.readFileSync(filename, "utf8");
    // One public CA certificate only; reject bundles, private keys and trailing data.
    requireSafe(/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem));
    const certificate = new X509Certificate(pem);
    requireSafe(certificate.ca && Date.parse(certificate.validFrom) <= Date.now()
      && Date.now() < Date.parse(certificate.validTo));
    return filename;
  } catch { requireSafe(false, "postgres_ca_file_invalid"); }
}
export function renderLaunchAgent(c, p) {
  const template = fs.readFileSync(new URL("./LaunchAgent.plist.template", import.meta.url), "utf8");
  const values = { LABEL: p.label, NODE: fs.realpathSync(process.execPath),
    SUPERVISOR: fileURLToPath(new URL("./supervisor.mjs", import.meta.url)),
    ENVIRONMENT: p.environment, CONFIG: p.config, REPO: repo, OUTPUT: p.output,
    POSTGRESCA: postgresCAFile(c, p) };
  return template.replace(/__([A-Z]+)__/g, (_, key) => values[key].replace(/[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]));
}
export function load(p) {
  privatePath(p.root, true); privatePath(path.dirname(p.config), true);
  privatePath(p.config);
  const c = JSON.parse(fs.readFileSync(p.config, "utf8"));
  requireSafe(c.schema_version === 1 && c.environment === p.environment);
  requireSafe(Object.keys(c).every((k) => ["schema_version", "environment", "identity", "env",
    "rclone_bin", "rclone_config", "postgres_ca_file", "max_attempts", "live_activation_authorized"].includes(k)));
  postgresCAFile(c, p);
  requireSafe(c.env && Object.keys(c.env).every((k) => requiredEnv.includes(k)));
  for (const key of requiredEnv) requireSafe(typeof c.env[key] === "string" && c.env[key].trim() === c.env[key]
    && c.env[key].length > 0 && !/[\r\n\0]/.test(c.env[key]));
  requireSafe(c.env.UK_AQ_R2_HISTORY_VERSION === "v3");
  const id = c.identity;
  requireSafe(id && Object.keys(id).sort().join(",") === "dropbox_directory,dropbox_root,obs_aqidb_project_ref,postgres_project_ref,r2_bucket,r2_endpoint");
  requireSafe(c.env.CFLARE_R2_BUCKET === id.r2_bucket && /^[a-z0-9][a-z0-9.-]+$/.test(id.r2_bucket));
  const endpoint = new URL(c.env.CFLARE_R2_ENDPOINT);
  requireSafe(endpoint.href === `${id.r2_endpoint}/` && endpoint.protocol === "https:"
    && /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname)
    && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
  // Preserve the stable-session database boundary; transaction poolers are ineligible.
  let db, username, password;
  try {
    db = new URL(c.env.SUPABASE_DB_URL);
    username = decodeURIComponent(db.username);
    password = decodeURIComponent(db.password);
  } catch { requireSafe(false); } // Never expose a malformed credential-bearing URL.
  const direct = db.hostname === `db.${id.postgres_project_ref}.supabase.co`
    && (!db.port || db.port === "5432");
  const sessionPooler = /^aws-[0-9]+-[a-z]{2}(?:-[a-z]+)+-[0-9]+\.pooler\.supabase\.com$/.test(db.hostname)
    && db.port === "5432" && username === `postgres.${id.postgres_project_ref}`;
  // pg accepts query overrides for identity and TLS, including uselibpqcompat.
  // Permit one secure sslmode only, so the URL checked here is the URL pg uses.
  requireSafe(["postgres:", "postgresql:"].includes(db.protocol)
    && /^[a-z0-9]{20}$/.test(id.postgres_project_ref)
    && (direct || sessionPooler) && username.trim() && password.trim()
    && !/[\s#]/.test(c.env.SUPABASE_DB_URL) && !/[\x00-\x1f\x7f]/.test(username + password)
    && db.pathname === "/postgres" && db.searchParams.size === 1
    && db.searchParams.get("sslmode") === "verify-full");
  requireSafe(c.env.UK_AQ_DROPBOX_ROOT === id.dropbox_root
    && c.env.UK_AQ_R2_HISTORY_DROPBOX_DIR === id.dropbox_directory);
  // Explicit environment partition; no fallback to another environment's destination.
  requireSafe(id.dropbox_root.split("/")[0] === p.environment);
  for (const value of [id.dropbox_root, id.dropbox_directory]) requireSafe(typeof value === "string"
    && value.split("/").every((part) => /^[A-Za-z0-9_. -]+$/.test(part) && part !== "." && part !== ".."));
  for (const key of ["UK_AQ_R2_HISTORY_CHECKPOINT_BATCH_UNITS", "UK_AQ_R2_HISTORY_CHECKPOINT_FLUSH_SECONDS"]) {
    requireSafe(/^[1-9]\d*$/.test(c.env[key]) && Number.isSafeInteger(Number(c.env[key])));
  }
  requireSafe(Number.isInteger(c.max_attempts) && c.max_attempts >= 1 && c.max_attempts <= 20);
  requireSafe(path.isAbsolute(c.rclone_bin) && path.isAbsolute(c.rclone_config));
  requireSafe(path.dirname(c.rclone_config) === path.dirname(p.config));
  privatePath(c.rclone_config);
  fs.accessSync(c.rclone_bin, fs.constants.X_OK);
  requireSafe(/^[a-z0-9]{20}$/.test(id.obs_aqidb_project_ref));
  requireSafe(c.env.OBS_AQIDB_SUPABASE_URL === `https://${id.obs_aqidb_project_ref}.supabase.co`, "health_identity");
  const source = `uk_aq_r2:${resolveHistoryBackupR2(c.env).bucket}`;
  const destination = configuredHistoryDropboxRoot(c.env);
  assertHistoryBackupSource(source, c.env); assertHistoryBackupDestination(destination, c.env);
  // Credential/CA rotation does not change the durable operation identity.
  const identity = { environment: p.environment, installation_root: p.root, source, destination, ...id, generation: "v3",
    binding_mode: "pack", parquet_mode: "full", max_days: 0,
    checkpoint_batch_units: c.env.UK_AQ_R2_HISTORY_CHECKPOINT_BATCH_UNITS,
    checkpoint_flush_seconds: c.env.UK_AQ_R2_HISTORY_CHECKPOINT_FLUSH_SECONDS,
    max_attempts: c.max_attempts, rclone_config: c.rclone_config };
  return { ...c, source, destination, identity, fingerprint: hash(JSON.stringify(identity)) };
}
export function childEnvironment(c, p) {
  const env = {};
  for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
    "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const backupEnv = Object.fromEntries(Object.entries(c.env).filter(([key]) =>
    !["OBS_AQIDB_SUPABASE_URL", "OBS_AQIDB_SECRET_KEY"].includes(key)));
  return { ...env, ...backupEnv, PATH: `${path.dirname(process.execPath)}:${path.dirname(c.rclone_bin)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    NODE_EXTRA_CA_CERTS: postgresCAFile(c, p),
    RCLONE_CONFIG: c.rclone_config, UK_AQ_R2_HISTORY_BACKUP_RCLONE_BIN: c.rclone_bin,
    UKAQ_ENV_NAME: p.environment };
}
export function remoteConfiguration(c, env) {
  let remotes;
  try {
    // Reuse canonical provider-schema and exact secret/source/destination guards.
    // Capture the same local dump solely to seed output redaction, never print it.
    assertHistoryBackupRemotes({ rcloneBin: c.rclone_bin, env,
      run(command, argv, options) {
        const result = spawnSync(command, argv, options);
        if (argv[1] === "dump" && result.status === 0) remotes = JSON.parse(result.stdout);
        return result;
      } });
  } catch { requireSafe(false, "remote_identity"); }
  requireSafe(Object.keys(remotes).sort().join(",") === "uk_aq_dropbox,uk_aq_r2", "remote_identity");
  const dropbox = remotes.uk_aq_dropbox, token = JSON.parse(dropbox.token);
  requireSafe(token.refresh_token && token.access_token && token.expiry, "rclone_configuration");
  return [c.env.SUPABASE_DB_URL, decodeURIComponent(new URL(c.env.SUPABASE_DB_URL).password),
    c.env.CFLARE_R2_ACCESS_KEY_ID, c.env.CFLARE_R2_SECRET_ACCESS_KEY,
    dropbox.client_id, dropbox.client_secret, token.refresh_token, token.access_token];
}
export function active(p) {
  const s = read(p.active);
  if (s) requireSafe(s.schema_version === 1 && /^[a-f0-9-]{36}$/.test(s.operation_id)
    && s.environment === p.environment && Number.isInteger(s.attempts) && s.attempts >= 0
    && Number.isInteger(s.attempts_since_review) && s.attempts_since_review >= 0
    && /^[a-f0-9]{64}$/.test(s.configuration_identity)
    && ["ready", "running", "retrying", "blocked", "completed"].includes(s.status), "state_invalid");
  if (s?.status === "completed") requireSafe(s.successful_completion?.operation_id === s.operation_id
    && s.successful_completion.configuration_identity === s.configuration_identity
    && s.last_accepted_report?.operation_id === s.operation_id
    && /^[a-f0-9]{64}$/.test(s.last_accepted_report?.report_identity)
    && s.successful_completion.report_identity === s.last_accepted_report.report_identity
    && Number.isFinite(Date.parse(s.completed_at)), "completion_marker_invalid");
  if (s?.health) requireSafe(s.health.version === 2 && s.health.operation_id === s.operation_id
    && s.health.configuration_identity === s.configuration_identity
    && s.health.input?.task_key === "ops.r2_history_dropbox_backup_mbpro"
    && (!s.health.run_id || s.health.run_id === s.operation_id)
    && s.health.input?.platform_run_id === s.operation_id
    && s.health.input.started_at === s.started_at
    && s.health.input.scheduled_for_date === s.started_at.slice(0, 10)
    && ["pending", "started", "blocked", "confirmed"].includes(s.health.status)
    && (!s.health.terminal || ["finished", "failed"].includes(s.health.terminal.kind)), "health_state_invalid");
  return s;
}
export function bootId() {
  const r = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 5000 });
  requireSafe(r.status === 0 && r.stdout.trim(), "boot_identity");
  return r.stdout.trim();
}
export function mutex(p) {
  const boot = bootId();
  try { fs.mkdirSync(p.mutex, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    privatePath(p.mutex, true);
    const owner = read(path.join(p.mutex, "owner.json"));
    // A crash between mkdir and owner publication requires operator review, not guessing.
    requireSafe(owner && Number.isInteger(owner.pid) && owner.pid > 0, "local_lock_review");
    if (owner.boot === boot) {
      try { process.kill(owner.pid, 0); requireSafe(false, "already_running"); }
      catch (e) { if (e.code !== "ESRCH") throw e; }
    }
    fs.unlinkSync(path.join(p.mutex, "owner.json")); fs.rmdirSync(p.mutex);
    fs.mkdirSync(p.mutex, { mode: 0o700 });
  }
  atomic(path.join(p.mutex, "owner.json"), { pid: process.pid, boot });
  return () => { fs.unlinkSync(path.join(p.mutex, "owner.json")); fs.rmdirSync(p.mutex); };
}
