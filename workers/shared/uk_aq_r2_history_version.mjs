export const UK_AQ_R2_HISTORY_VERSION_ENV = "UK_AQ_R2_HISTORY_VERSION";

export const DEPRECATED_R2_HISTORY_VERSION_ENVS = Object.freeze([
  "UK_AQ_R2_HISTORY_READ_VERSION",
  "UK_AQ_R2_HISTORY_WRITE_VERSION",
  "UK_AQ_R2_HISTORY_BACKUP_VERSION",
]);

export const R2_HISTORY_VERSION_VALUES = Object.freeze(["v1", "v2"]);

const R2_HISTORY_VERSION_VALUE_SET = new Set(R2_HISTORY_VERSION_VALUES);

function hasOwnEnv(env, name) {
  return Boolean(env && Object.prototype.hasOwnProperty.call(env, name));
}

export function deprecatedR2HistoryVersionVarsPresent(env = {}) {
  return DEPRECATED_R2_HISTORY_VERSION_ENVS.filter((name) => hasOwnEnv(env, name));
}

export function assertNoDeprecatedR2HistoryVersionVars(env = {}, { context = "R2 history" } = {}) {
  const present = deprecatedR2HistoryVersionVarsPresent(env);
  if (present.length > 0) {
    throw new Error(
      `${context} no longer supports ${present.join(", ")}. `
      + `Use ${UK_AQ_R2_HISTORY_VERSION_ENV}=v1|v2 and delete the old split read/write/backup vars.`,
    );
  }
}

export function parseR2HistoryVersion(raw, {
  varName = UK_AQ_R2_HISTORY_VERSION_ENV,
  required = true,
} = {}) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (R2_HISTORY_VERSION_VALUE_SET.has(value)) {
    return value;
  }
  if (!value && !required) {
    return null;
  }
  if (!value) {
    throw new Error(`Missing ${varName}; set ${varName}=v1 or ${varName}=v2.`);
  }
  throw new Error(`Invalid ${varName}=${JSON.stringify(String(raw))}; expected v1 or v2.`);
}

export function resolveR2HistoryVersion(env = {}, {
  context = "R2 history",
  varName = UK_AQ_R2_HISTORY_VERSION_ENV,
  guardDeprecated = true,
} = {}) {
  if (guardDeprecated) {
    assertNoDeprecatedR2HistoryVersionVars(env, { context });
  }
  return parseR2HistoryVersion(env?.[varName], { varName, required: true });
}
