import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  getR2HistoryProfile,
  resolveR2HistoryProfile,
  assertR2HistoryProfile
} from "../workers/shared/uk_aq_r2_history_profile.mjs";

test("R2 History Profile Tests", async (t) => {
  await t.test("exact v1 profile", () => {
    const p = getR2HistoryProfile("v1");
    assert.equal(p.version, "v1");
    assert.equal(p.observations_prefix, "history/v1/observations");
    assert.equal(p.aqilevels_hourly_data_prefix, "history/v1/aqilevels/hourly");
    assert.equal(p.aqilevels_hourly_debug_prefix, null);
    assert.equal(p.core_prefix, "history/v1/core");
    assert.equal(p.observations_runs_prefix, "history/v1/_ops/observations/runs");
    assert.equal(p.index_root_prefix, "history/_index");
    assert.equal(p.observations_timeseries_index_prefix, "history/_index/observations_timeseries");
    assert.equal(p.aqilevels_timeseries_index_prefix, "history/_index/aqilevels_timeseries");
    assert.equal(p.timeseries_binding_index_prefix, null);
  });

  await t.test("exact v2 profile", () => {
    const p = getR2HistoryProfile("v2");
    assert.equal(p.version, "v2");
    assert.equal(p.observations_prefix, "history/v2/observations");
    assert.equal(p.aqilevels_hourly_data_prefix, "history/v2/aqilevels/hourly/data");
    assert.equal(p.aqilevels_hourly_debug_prefix, "history/v2/aqilevels/hourly/debug");
    assert.equal(p.core_prefix, "history/v2/core");
    assert.equal(p.observations_runs_prefix, "history/v2/_ops/observations/runs");
    assert.equal(p.index_root_prefix, "history/_index_v2");
    assert.equal(p.observations_timeseries_index_prefix, "history/_index_v2/observations_timeseries");
    assert.equal(p.aqilevels_timeseries_index_prefix, "history/_index_v2/aqilevels_hourly_data_timeseries");
    assert.equal(p.timeseries_binding_index_prefix, "history/_index_v2/timeseries_binding");
  });

  await t.test("exact v3 observation and core generation profile", () => {
    const p = getR2HistoryProfile("v3");
    assert.equal(p.version, "v3");
    assert.equal(p.observations_prefix, "history/v3/observations");
    assert.equal(p.core_prefix, "history/v3/core");
    assert.equal(p.index_root_prefix, "history/_index_v3");
    assert.equal(
      p.observations_timeseries_index_prefix,
      "history/_index_v3/observations_timeseries",
    );
    assert.equal(
      p.timeseries_binding_index_prefix,
      "history/_index_v3/timeseries_binding",
    );
  });

  await t.test("missing and invalid version", () => {
    assert.throws(() => getR2HistoryProfile("v4"), /Invalid R2 history version: v4/);
    assert.throws(() => getR2HistoryProfile(null), /Invalid R2 history version: null/);
    
    assert.throws(
      () => resolveR2HistoryProfile({}),
      /Observation history generation must be exactly v2 or v3/,
    );
    assert.throws(
      () => resolveR2HistoryProfile({ UK_AQ_R2_HISTORY_VERSION: "v4" }),
      /Observation history generation must be exactly v2 or v3/,
    );
    assert.equal(
      resolveR2HistoryProfile({ UK_AQ_R2_HISTORY_VERSION: "v3" }).core_prefix,
      "history/v3/core",
    );
  });

  await t.test("deprecated split variables", () => {
    assert.throws(
      () => resolveR2HistoryProfile({ UK_AQ_R2_HISTORY_VERSION: "v2", UK_AQ_R2_HISTORY_READ_VERSION: "v1" }),
      /Observation history generation no longer supports UK_AQ_R2_HISTORY_READ_VERSION\. Use UK_AQ_R2_HISTORY_VERSION=v1\|v2 and delete the old split read\/write\/backup vars\./
    );
  });

  await t.test("immutability", () => {
    const p = getR2HistoryProfile("v1");
    assert.throws(() => { p.version = "v3"; }, TypeError);
    assert.equal(p.version, "v1");
  });

  await t.test("null fields", () => {
    const p = getR2HistoryProfile("v1");
    assert.equal(p.aqilevels_hourly_debug_prefix, null);
    assert.equal(p.timeseries_binding_index_prefix, null);
  });

  await t.test("CLI JSON output", () => {
    const stdout = execFileSync("node", ["scripts/uk_aq_r2_history_profile.mjs", "--version", "v2", "--format", "json"], { encoding: "utf8" });
    const p = JSON.parse(stdout);
    assert.equal(p.version, "v2");
    assert.equal(p.observations_prefix, "history/v2/observations");
  });

  await t.test("CLI env output", () => {
    const stdout = execFileSync("node", ["scripts/uk_aq_r2_history_profile.mjs", "--version", "v1", "--format", "env"], { encoding: "utf8" });
    assert.match(stdout, /UK_AQ_R2_HISTORY_PROFILE_VERSION=v1\n/);
    assert.match(stdout, /UK_AQ_R2_HISTORY_PROFILE_CORE_PREFIX=history\/v1\/core\n/);
    assert.doesNotMatch(stdout, /AQILEVELS_HOURLY_DEBUG_PREFIX/);
  });
  
  await t.test("CLI missing/invalid version exact error messages", () => {
    const v3Stdout = execFileSync(
      "node",
      ["scripts/uk_aq_r2_history_profile.mjs", "--version", "v3", "--format", "json"],
      { encoding: "utf8" },
    );
    assert.equal(JSON.parse(v3Stdout).core_prefix, "history/v3/core");
    assert.throws(
      () => execFileSync("node", ["scripts/uk_aq_r2_history_profile.mjs", "--version", "v4"], { encoding: "utf8" }),
      (err) => err.stderr.includes('Invalid --version="v4"; expected v1 or v2.') || err.stdout.includes('Invalid --version="v4"; expected v1 or v2.')
    );
    assert.throws(
      () => execFileSync("node", ["scripts/uk_aq_r2_history_profile.mjs"], { encoding: "utf8" }),
      (err) => err.stderr.includes('Missing --version; set --version=v1 or --version=v2.') || err.stdout.includes('Missing --version; set --version=v1 or --version=v2.') || err.stderr.includes('Missing required option') || err.message.includes('Missing required option')
    );
  });
});
