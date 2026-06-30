import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("Phase 9 documentation fixes the snapshot and cache contracts", () => {
  const doc = fs.readFileSync(
    path.join(root, "system_docs/uk-aq-network-contract-v2.md"),
    "utf8",
  );
  for (const marker of [
    "latest_snapshots/v2",
    "stations.network_id -> networks.id",
    "/api/aq/networks",
    "metadata cache profile",
    "contract_version: 2",
    "HTTP 400",
  ]) {
    assert.equal(doc.includes(marker), true);
  }
});

test("active runtime and current docs do not depend on retired relations", () => {
  const retired = ["station_network_" + "memberships", "uk_aq_" + "networks"];
  const roots = [
    root,
    path.resolve(root, "../../CIC-test-uk-aq-ingest"),
    path.resolve(root, "../../CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema"),
    path.resolve(root, "../../CIC-UK-AQ Webpage/CIC-test-uk-aq-webpage"),
  ];
  const allowed = new Set([
    "schemas/migrations/v0.2.0/ingestdb/011_remove_legacy_network_relations.sql",
    "docs/v0.2.0_schema_migration_notes.md",
    "system_docs/uk-aq-latest-snapshot.md",
    "workers/uk_aq_latest_snapshot_cloud_run/README.md",
  ]);
  const skipDirs = new Set([".git", "archive", "plans", "node_modules", ".venv", "tmp"]);
  const failures = [];

  function visit(repoRoot, current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(repoRoot, absolute);
        continue;
      }
      const relative = path.relative(repoRoot, absolute);
      if (
        relative.startsWith("tests/") ||
        entry.name.includes("_test.") ||
        entry.name.includes(".test.") ||
        allowed.has(relative)
      ) continue;
      let text;
      try {
        text = fs.readFileSync(absolute, "utf8");
      } catch {
        continue;
      }
      for (const name of retired) {
        if (text.includes(name)) failures.push(`${relative}: ${name}`);
      }
    }
  }

  for (const repoRoot of roots) visit(repoRoot, repoRoot);
  assert.deepEqual(failures, []);
});
