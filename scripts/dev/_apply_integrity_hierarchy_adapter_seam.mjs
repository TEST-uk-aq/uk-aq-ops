import { createHash } from "node:crypto";
import fs from "node:fs";

const integrityPath = "scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs";
const testPath = "scripts/backup_r2/tests/uk_aq_integrity_apply_safety.test.mjs";
const expected = {
  [integrityPath]: "7c5972c95ebd019425913d7d59117cb5e476be10",
  [testPath]: "64bbc39bb9b781c3cca39eb80c5df0599cebbfeb",
};

function blobSha(content) {
  const body = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(Buffer.from(`blob ${body.byteLength}\0`, "utf8"))
    .update(body)
    .digest("hex");
}

function readVerified(path) {
  const content = fs.readFileSync(path, "utf8");
  const actual = blobSha(content);
  if (actual !== expected[path]) {
    throw new Error(`Refusing to patch changed file: ${path}; expected=${expected[path]}; actual=${actual}`);
  }
  return content;
}

function replaceOnce(content, oldValue, newValue, label) {
  const first = content.indexOf(oldValue);
  if (first < 0) throw new Error(`Patch anchor missing: ${label}`);
  if (content.indexOf(oldValue, first + oldValue.length) >= 0) {
    throw new Error(`Patch anchor is not unique: ${label}`);
  }
  return `${content.slice(0, first)}${newValue}${content.slice(first + oldValue.length)}`;
}

let integrity = readVerified(integrityPath);
integrity = replaceOnce(
  integrity,
  `        maxKeys: indexConfig.max_keys || 1000,\n        finalizeExistingIndexes: async () => {`,
  `        maxKeys: indexConfig.max_keys || 1000,\n        hierarchyFinalizerAdapter: adapters.observationsHierarchyFinalizer,\n        finalizeExistingIndexes: async () => {`,
  "Integrity hierarchy adapter seam",
);
fs.writeFileSync(integrityPath, integrity, "utf8");

let tests = readVerified(testPath);
tests = replaceOnce(
  tests,
  `    adapters: {\n      historyWriterClient: {`,
  `    adapters: {\n      observationsHierarchyFinalizer: async ({ affectedDaysUtc }) => {\n        const days = [...new Set(affectedDaysUtc)].sort();\n        return {\n          ok: true,\n          status: "up_to_date",\n          affected_days_utc: days,\n          affected_months: [...new Set(days.map((day) => day.slice(0, 7)))].sort(),\n          affected_years: [...new Set(days.map((day) => day.slice(0, 4)))].sort(),\n          objects: [],\n          execution: { wrote_object_count: 0, writes: [] },\n        };\n      },\n      historyWriterClient: {`,
  "Integrity in-memory hierarchy adapter",
);
fs.writeFileSync(testPath, tests, "utf8");

process.stdout.write("Applied Integrity hierarchy adapter seam.\n");
