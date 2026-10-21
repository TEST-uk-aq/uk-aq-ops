import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "pg";
import { load, locations } from "../local/history_dropbox_backup/config.mjs";

// Synthetic local configuration only; no PostgreSQL connection or backup runs.
const project = "a".repeat(20), otherProject = "b".repeat(20);
const direct = `postgresql://postgres:synthetic%3Apassword@db.${project}.supabase.co:5432/postgres`;
const pooler = `postgresql://postgres.${project}:synthetic%3Apassword@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backup-config-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "TEST/config/backup.json");
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  const p = locations("TEST", config);
  const c = JSON.parse(fs.readFileSync(new URL("../local/history_dropbox_backup/config.example.json", import.meta.url)));
  c.identity = {
    r2_endpoint: `https://${"0".repeat(32)}.r2.cloudflarestorage.com`,
    r2_bucket: "history-sandbox", postgres_project_ref: project,
    obs_aqidb_project_ref: otherProject, dropbox_root: "TEST", dropbox_directory: "history",
  };
  Object.assign(c.env, {
    CFLARE_R2_ENDPOINT: c.identity.r2_endpoint, CFLARE_R2_BUCKET: c.identity.r2_bucket,
    OBS_AQIDB_SUPABASE_URL: `https://${otherProject}.supabase.co`,
    UK_AQ_DROPBOX_ROOT: "TEST", UK_AQ_R2_HISTORY_DROPBOX_DIR: "history",
  });
  c.rclone_bin = process.execPath; // load only checks executable access.
  c.rclone_config = path.join(path.dirname(config), "rclone.conf");
  fs.writeFileSync(c.rclone_config, "", { mode: 0o600 });
  return (url) => {
    c.env.SUPABASE_DB_URL = url;
    fs.writeFileSync(config, JSON.stringify(c), { mode: 0o600 });
    return load(p);
  };
}

test("approved direct and session-pooler URLs preserve pinned identity and verified TLS", (t) => {
  const configured = fixture(t);
  const baseline = configured(`${direct}?sslmode=require`);
  for (const base of [direct, direct.replace(":5432/", "/"), pooler]) {
    for (const mode of ["require", "verify-full"]) {
      const url = `${base}?sslmode=${mode}`;
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
    assert.throws(() => configured(`${base}?sslmode=require`), (error) => {
      assert.equal(error.message, "configuration");
      assert.equal(error.input, undefined);
      return true;
    });
  }
});

test("only one explicit secure SSL mode is allowed; pg target and TLS overrides are refused", (t) => {
  const configured = fixture(t);
  for (const base of [direct, pooler]) {
    for (const query of ["", "?sslmode=disable", "?sslmode=prefer", "?sslmode=no-verify",
      "?sslmode=require&sslmode=disable", "?sslmode=disable&sslmode=require",
      "?sslmode=require&uselibpqcompat=true", "?sslmode=require&ssl=0",
      "?sslmode=require&host=attacker.invalid", "?sslmode=require&port=6543",
      `?sslmode=require&user=postgres.${otherProject}`, "?sslmode=require&password=override",
      "?sslmode=require#fragment"]) {
      assert.throws(() => configured(`${base}${query}`), /^Error: configuration$/);
    }
  }
});
