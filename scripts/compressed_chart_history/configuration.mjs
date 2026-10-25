import fs from "node:fs/promises";
import { canonicalText, validatePilotConfig, COMPRESSED_CHART_LIMITS, COMPRESSED_CHART_PARAMETERS, validAlgorithm } from "../../workers/shared/uk_aq_compressed_chart_pilot.mjs";
import { AQI_ALGORITHM_VERSION, DAQI_PM_ROLLING24H_WINDOW_HOURS, DAQI_PM_ROLLING24H_REQUIRED_HOURS } from "../../lib/aqi/aqi_levels.mjs";
import { sha256, requireCondition as check } from "./source_reader.mjs";
export const canonicalJson = value => Buffer.from(canonicalText(value));
export async function readLocalBounded(file, maxBytes) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, "Local input size/type bound");
    const body = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < body.length) {
      const read = await handle.read(body, length, body.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    check(length === stat.size, "Local input changed or exceeded size bound");
    return body.subarray(0, length);
  } finally { await handle.close(); }
}
export async function loadPilotConfig(file, sampleId = null) {
  const config = validatePilotConfig(JSON.parse(await readLocalBounded(file, COMPRESSED_CHART_LIMITS.metadata_bytes)), process.env.UK_AQ_ENV_NAME);
  const sample = sampleId === null ? null : config.samples.find(entry => entry.id === sampleId);
  check(sampleId === null || sample, "Sample ID absent from finite configuration");
  return { config, sample, configSha: sha256(canonicalJson(config)) };
}
export async function calculationIdentity() {
  check(DAQI_PM_ROLLING24H_WINDOW_HOURS === COMPRESSED_CHART_PARAMETERS.pm_window_hours
    && DAQI_PM_ROLLING24H_REQUIRED_HOURS === COMPRESSED_CHART_PARAMETERS.pm_min_valid_hours, "Shared AQI parameter identity changed");
  const algorithm = { version: AQI_ALGORITHM_VERSION, parameters: COMPRESSED_CHART_PARAMETERS,
    implementation_sha256: sha256(await fs.readFile(new URL("../../lib/aqi/aqi_levels.mjs", import.meta.url))),
    orchestration_sha256: sha256(await fs.readFile(new URL("../../workers/uk_aq_station_history/src/calculated_history.mjs", import.meta.url))) };
  check(validAlgorithm(algorithm), "Unsupported shared calculation identity");
  return algorithm;
}
export function parsePairs(args, names, flags = []) {
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index].replace(/^--/, "");
    check(args[index] === `--${name}` && !Object.hasOwn(values, name), "Invalid/repeated argument");
    if (flags.includes(name)) values[name] = true;
    else { check(names.includes(name) && index + 1 < args.length, "Unknown argument/missing value"); values[name] = args[++index]; }
  }
  return values;
}
