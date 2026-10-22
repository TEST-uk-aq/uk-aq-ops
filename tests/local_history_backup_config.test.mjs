import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { Client } from "pg";
import { childEnvironment, load, locations, postgresCAFile, renderLaunchAgent } from "../local/history_dropbox_backup/config.mjs";

// Synthetic local configuration only; no PostgreSQL connection or backup runs.
const project = "a".repeat(20), otherProject = "b".repeat(20);
const direct = `postgresql://postgres:synthetic%3Apassword@db.${project}.supabase.co:5432/postgres`;
const pooler = `postgresql://postgres.${project}:synthetic%3Apassword@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`;

const publicCA = rootCertificates.find((pem) => {
  const c = new X509Certificate(pem);
  return c.ca && Date.parse(c.validFrom) <= Date.now() && Date.now() < Date.parse(c.validTo);
});
function fixture(t, environment = "TEST") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backup config & '-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, environment, "config/backup.json");
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  const p = locations(environment, config);
  const c = JSON.parse(fs.readFileSync(new URL("../local/history_dropbox_backup/config.example.json", import.meta.url)));
  c.environment = environment;
  c.identity = {
    r2_endpoint: `https://${"0".repeat(32)}.r2.cloudflarestorage.com`,
    r2_bucket: "history-sandbox", postgres_project_ref: project,
    obs_aqidb_project_ref: otherProject, dropbox_root: environment, dropbox_directory: "history",
  };
  Object.assign(c.env, {
    CFLARE_R2_ENDPOINT: c.identity.r2_endpoint, CFLARE_R2_BUCKET: c.identity.r2_bucket,
    OBS_AQIDB_SUPABASE_URL: `https://${otherProject}.supabase.co`,
    UK_AQ_DROPBOX_ROOT: environment, UK_AQ_R2_HISTORY_DROPBOX_DIR: "history",
  });
  c.rclone_bin = process.execPath; // load only checks executable access.
  c.rclone_config = path.join(path.dirname(config), "rclone.conf");
  fs.writeFileSync(c.rclone_config, "", { mode: 0o600 });
  c.postgres_ca_file = path.join(path.dirname(config), "certs/ingestdb/approved.crt");
  fs.mkdirSync(path.dirname(c.postgres_ca_file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(c.postgres_ca_file, publicCA, { mode: 0o600 });
  return Object.assign((url = `${pooler}?sslmode=verify-full`) => {
    c.env.SUPABASE_DB_URL = url;
    fs.writeFileSync(config, JSON.stringify(c), { mode: 0o600 });
    return load(p);
  }, { c, p, root });
}

test("approved direct and session-pooler URLs preserve pinned identity and verified TLS", (t) => {
  const configured = fixture(t);
  const baseline = configured(`${direct}?sslmode=verify-full`);
  for (const base of [direct, direct.replace(":5432/", "/"), pooler]) {
    const url = `${base}?sslmode=verify-full`;
    const c = configured(url);
    assert.equal(c.fingerprint, baseline.fingerprint);
    assert.equal(c.env.SUPABASE_DB_URL, url);
    const { connectionParameters: pg } = new Client({ connectionString: url });
    assert.equal(pg.database, "postgres");
    assert.equal(pg.port, 5432);
    assert.equal(pg.password, "synthetic:password");
    assert.equal(pg.host, new URL(url).hostname);
    assert.equal(pg.user, base === pooler ? `postgres.${project}` : "postgres");
    assert.equal(typeof pg.ssl, "object");
    assert.notEqual(pg.ssl.rejectUnauthorized, false);
    assert.equal(pg.ssl.checkServerIdentity, undefined);
  }
});

test("identity, session port, database and credentials fail closed without leaking URLs", (t) => {
  const configured = fixture(t);
  const invalid = [
    pooler.replace(":5432/", ":6543/"), direct.replace(":5432/", ":6543/"),
    pooler.replace(":5432/", "/"), pooler.replace(":5432/", ":5433/"),
    pooler.replace(project, otherProject), direct.replace(project, otherProject),
    pooler.replace(`postgres.${project}`, "postgres"),
    pooler.replace("aws-0-eu-west-2", "unapproved"),
    pooler.replace("pooler.supabase.com", "pooler.supabase.com.attacker.invalid"),
    pooler.replace("pooler.supabase.com", "pooler.supabase.co"),
    pooler.replace("/postgres", "/another_database"),
    pooler.replace("synthetic%3Apassword", ""),
    pooler.replace(`postgres.${project}`, ""),
    pooler.replace("synthetic%3Apassword", "%00"),
    pooler.replace("synthetic%3Apassword", "%ZZ"),
    pooler.replace("synthetic%3Apassword", "unencoded password"),
    pooler.replace("postgresql:", "https:"),
    "postgresql://postgres:synthetic-password@[malformed",
  ];
  for (const base of invalid) {
    assert.throws(() => configured(`${base}?sslmode=verify-full`), (error) => {
      assert.equal(error.message, "configuration");
      assert.equal(error.input, undefined);
      return true;
    });
  }
});

test("only one explicit secure SSL mode is allowed; pg target and TLS overrides are refused", (t) => {
  const configured = fixture(t);
  for (const base of [direct, pooler]) {
    for (const query of ["", "?sslmode=require", "?sslmode=disable", "?sslmode=prefer", "?sslmode=no-verify",
      "?sslmode=require&sslmode=disable", "?sslmode=disable&sslmode=require",
      "?sslmode=verify-full&uselibpqcompat=true", "?sslmode=verify-full&ssl=0",
      "?sslmode=verify-full&host=attacker.invalid", "?sslmode=verify-full&port=6543",
      `?sslmode=verify-full&user=postgres.${otherProject}`, "?sslmode=verify-full&password=override",
      "?sslmode=verify-full#fragment"]) {
      assert.throws(() => configured(`${base}${query}`), /^Error: configuration$/);
    }
  }
});

test("CA validation refuses missing, noncanonical, cross-environment, insecure and symlinked paths", (t) => {
  for (const environment of ["TEST", "LIVE"]) {
    const configured = fixture(t, environment), { c, p } = configured;
    const filename = c.postgres_ca_file;
    const baseline = configured().fingerprint;
    const rejected = () => assert.throws(() => configured(), /^Error: (postgres_ca_file_invalid|file_permissions)$/);
    for (const invalid of [undefined, "approved.crt", filename.replace("approved.crt", "../ingestdb/approved.crt"),
      filename.replace(`/${environment}/`, `/${environment === "TEST" ? "LIVE" : "TEST"}/`),
      filename.replace("approved.crt", "missing.crt")]) {
      c.postgres_ca_file = invalid; rejected();
    }
    c.postgres_ca_file = filename;
    for (const entry of [p.root, path.dirname(p.config), path.dirname(path.dirname(filename)), path.dirname(filename), filename]) {
      const original = fs.statSync(entry).mode & 0o777;
      fs.chmodSync(entry, original | 0o044); rejected(); fs.chmodSync(entry, original);
    }
    for (const entry of [path.dirname(path.dirname(filename)), path.dirname(filename), filename]) {
      fs.renameSync(entry, `${entry}.original`);
      fs.symlinkSync(`${entry}.original`, entry); rejected();
      fs.unlinkSync(entry); fs.renameSync(`${entry}.original`, entry);
    }
    for (const invalid of ["invalid certificate", `${publicCA}\n${publicCA}`,
      `${publicCA}\n-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----`]) {
      fs.writeFileSync(filename, invalid); rejected();
    }
    fs.writeFileSync(filename, publicCA);
    const rotated = path.join(path.dirname(filename), "rotated.crt");
    fs.copyFileSync(filename, rotated); fs.chmodSync(rotated, 0o600);
    c.postgres_ca_file = rotated;
    assert.equal(configured().fingerprint, baseline);
    assert.equal(postgresCAFile(c, p), rotated);
  }
});

test("plist and child environments pin the protected CA and exclude inherited Node overrides and health secrets", (t) => {
  for (const [key, value] of Object.entries({ NODE_EXTRA_CA_CERTS: "/untrusted/inherited.crt",
    NODE_OPTIONS: "--inspect", NODE_TLS_REJECT_UNAUTHORIZED: "0" })) {
    const original = process.env[key];
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
    process.env[key] = value;
  }
  for (const environment of ["TEST", "LIVE"]) {
    const configured = fixture(t, environment), c = configured(), { p } = configured;
    const env = childEnvironment(c, p);
    assert.equal(env.NODE_EXTRA_CA_CERTS, c.postgres_ca_file);
    for (const key of ["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "OBS_AQIDB_SECRET_KEY", "OBS_AQIDB_SUPABASE_URL"]) {
      assert.equal(env[key], undefined);
    }
    const plist = renderLaunchAgent(c, p);
    assert.ok(plist.includes('<key>EnvironmentVariables</key>'));
    assert.ok(plist.includes(`<key>NODE_EXTRA_CA_CERTS</key><string>${c.postgres_ca_file.replaceAll("&", "&amp;").replaceAll("'", "&apos;")}</string>`));
    assert.ok(!/__([A-Z]+)__/.test(plist));
    assert.ok(!plist.includes(c.env.SUPABASE_DB_URL) && !plist.includes("BEGIN CERTIFICATE"));
  }
});
