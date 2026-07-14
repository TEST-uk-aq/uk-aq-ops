// Repository-root anchored Parquet dependency loader.
//
// The Integrity coordinator may launch this specialist from a deployed
// checkout or an unrelated current working directory. Resolve the packages
// from the selected ops repository's installed dependency tree rather than
// relying on the process cwd or a global installation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const repositoryRoot = path.resolve(
  String(process.env.UK_AQ_OPS_REPO_ROOT || moduleRoot),
);

function dependencyEntry(packageName, relativeEntry) {
  const packageRoot = path.join(repositoryRoot, "node_modules", packageName);
  const packageJson = path.join(packageRoot, "package.json");
  const entry = path.join(packageRoot, relativeEntry);
  if (!fs.existsSync(packageJson) || !fs.existsSync(entry)) {
    throw new Error(
      `${packageName} is not installed under ${repositoryRoot}/node_modules; `
      + `run npm ci --prefix ${repositoryRoot} before starting Integrity`,
    );
  }
  return pathToFileURL(entry).href;
}

const hyparquet = await import(dependencyEntry("hyparquet", "src/node.js"));
const compressorsModule = await import(dependencyEntry("hyparquet-compressors", "src/index.js"));

export const {
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
} = hyparquet;
export const { compressors } = compressorsModule;
