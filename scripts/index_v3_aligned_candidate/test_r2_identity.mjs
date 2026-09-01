import fs from "node:fs";

const ENVIRONMENT_CATALOG = new URL("../../env-vars-master.csv", import.meta.url);
const REQUIRED_TEST_VALUES = Object.freeze([
  "CFLARE_R2_ENDPOINT",
  "CFLARE_R2_BUCKET",
]);

function parseCsvRow(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted && character === '"' && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("environment catalogue contains an unterminated CSV value");
  values.push(value);
  return values;
}

export function alignedV2TestR2Authority() {
  const lines = fs.readFileSync(ENVIRONMENT_CATALOG, "utf8").split(/\r?\n/);
  const header = parseCsvRow(lines[0]);
  const envVarIndex = header.indexOf("Env Var");
  const testValueIndex = header.indexOf("Test Value");
  if (envVarIndex < 0 || testValueIndex < 0) {
    throw new Error("environment catalogue lacks Env Var/Test Value authority columns");
  }
  const values = Object.fromEntries(lines.slice(1).map(parseCsvRow)
    .filter((row) => REQUIRED_TEST_VALUES.includes(row[envVarIndex]))
    .map((row) => [row[envVarIndex], String(row[testValueIndex] || "").trim()]));
  for (const name of REQUIRED_TEST_VALUES) {
    if (!values[name]) throw new Error(`environment catalogue lacks TEST ${name}`);
  }
  return Object.freeze({ endpoint: values.CFLARE_R2_ENDPOINT, bucket: values.CFLARE_R2_BUCKET });
}

function normalizedEndpoint(value) {
  const url = new URL(String(value || ""));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("CFLARE_R2_ENDPOINT must be an HTTPS origin");
  }
  return url.origin;
}

export function assertAlignedV2TestR2Identity(env) {
  if (String(env.UKAQ_ENV_NAME || "").trim().toUpperCase() !== "TEST") {
    throw new Error("UKAQ_ENV_NAME must equal TEST");
  }
  const expected = alignedV2TestR2Authority();
  const actualEndpoint = normalizedEndpoint(env.CFLARE_R2_ENDPOINT);
  const actualBucket = String(env.CFLARE_R2_BUCKET || "").trim();
  if (actualEndpoint !== normalizedEndpoint(expected.endpoint)) {
    throw new Error("configured R2 endpoint does not match the repository TEST authority");
  }
  if (actualBucket !== expected.bucket) {
    throw new Error("configured R2 bucket does not match the repository TEST authority");
  }
  return expected;
}
