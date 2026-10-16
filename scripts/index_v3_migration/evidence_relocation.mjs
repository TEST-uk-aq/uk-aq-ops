import fs from "node:fs";
import path from "node:path";

function assertAbsoluteNormalized(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0")) {
    throw new Error(`${label} must be an absolute, normalized path`);
  }
  return value;
}

function assertInside(root, target, label) {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return target;
  }
  throw new Error(`${label} escapes the selected evidence root`);
}

function assertNoSymlinkPath(root, target, label) {
  assertInside(root, target, label);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic-link escape: ${current}`);
  }
  return target;
}

function requirePrivateEvidenceRoot(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Selected evidence root is not a regular directory: ${root}`);
  }
}

// The historical checkpoint directory is the only relocation namespace. The
// caller selects the extracted run directory explicitly; no arbitrary
// historical-to-local path map is accepted.
export function createEvidenceRelocation({ historicalCheckpointPath, localCheckpointPath, evidenceRoot = null }) {
  const historical = assertAbsoluteNormalized(historicalCheckpointPath, "Historical checkpoint path");
  const local = path.resolve(localCheckpointPath);
  const historicalRoot = path.dirname(historical);
  const localRoot = path.dirname(local);
  let selectedRoot = null;

  if (evidenceRoot !== null && evidenceRoot !== undefined) {
    selectedRoot = path.resolve(evidenceRoot);
    requirePrivateEvidenceRoot(selectedRoot);
    if (localRoot !== selectedRoot) {
      throw new Error("Selected evidence root must be the extracted migration run directory containing the checkpoint");
    }
    assertNoSymlinkPath(selectedRoot, local, "Relocated checkpoint");
  } else if (historical !== local) {
    throw new Error("Relocated evidence requires an explicitly selected evidence root");
  }

  const mapHistoricalPath = (historicalPath, label = "Relocated evidence path") => {
    const source = assertAbsoluteNormalized(historicalPath, `${label} historical path`);
    const relative = path.relative(historicalRoot, source);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`${label} is outside the historical checkpoint directory`);
    }
    const target = path.resolve(localRoot, relative);
    if (selectedRoot) assertNoSymlinkPath(selectedRoot, target, label);
    else if (target !== source) throw new Error(`${label} does not preserve the historical path`);
    return target;
  };

  if (mapHistoricalPath(historical, "Checkpoint") !== local) {
    throw new Error("Relocated checkpoint does not preserve the historical checkpoint relationship");
  }
  return Object.freeze({
    historical_checkpoint_path: historical,
    local_checkpoint_path: local,
    historical_root: historicalRoot,
    local_root: localRoot,
    evidence_root: selectedRoot,
    relocated: historical !== local,
    mapHistoricalPath,
  });
}
