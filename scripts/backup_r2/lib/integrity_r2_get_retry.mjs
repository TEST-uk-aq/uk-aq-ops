import {
  isRetryableR2Status,
} from "../../../workers/shared/r2_sigv4.mjs";

export const INTEGRITY_R2_GET_MAX_ATTEMPTS = 5;
export const INTEGRITY_R2_GET_RETRY_BASE_MS = 1_000;
export const INTEGRITY_R2_GET_RETRY_MAX_MS = 8_000;
export const INTEGRITY_R2_GET_RETRY_JITTER_RATIO = 0.2;

const ERROR_CAUSE_MAX_DEPTH = 8;
const TRANSIENT_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function errorField(error, field) {
  try {
    const value = error?.[field];
    return typeof value === "string" || typeof value === "number"
      ? String(value).trim()
      : "";
  } catch {
    return "";
  }
}

function errorChain(error) {
  const values = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth < ERROR_CAUSE_MAX_DEPTH; depth += 1) {
    if (current === null || current === undefined) break;
    if (typeof current === "object" || typeof current === "function") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    values.push(current);
    try {
      current = current?.cause;
    } catch {
      break;
    }
  }
  return values;
}

export function classifyIntegrityR2GetError(error) {
  const chain = errorChain(error);
  for (const current of chain) {
    const statusRaw = errorField(current, "status")
      || errorField(current, "statusCode");
    const status = /^\d{3}$/.test(statusRaw) ? Number(statusRaw) : null;
    if (status !== null) {
      return {
        retryable: isRetryableR2Status(status),
        category: isRetryableR2Status(status)
          ? "transient_http_status"
          : "permanent_http_status",
        status,
        code: errorField(current, "code") || null,
        timeout: status === 408,
      };
    }
  }

  for (const current of chain) {
    const name = errorField(current, "name");
    const code = errorField(current, "code").toUpperCase();
    const message = errorField(current, "message");
    if (name === "AbortError" || code === "ABORT_ERR") {
      return {
        retryable: true,
        category: "request_timeout_or_abort",
        status: null,
        code: code || name,
        timeout: true,
      };
    }
    if (TRANSIENT_CODES.has(code)) {
      return {
        retryable: true,
        category: code === "EAI_AGAIN"
          ? "temporary_dns_failure"
          : code.includes("TIMEOUT") || code === "ETIMEDOUT"
          ? "request_timeout"
          : "temporary_connection_failure",
        status: null,
        code,
        timeout: code.includes("TIMEOUT") || code === "ETIMEDOUT",
      };
    }
    if (name === "TypeError" && message.toLowerCase() === "fetch failed") {
      return {
        retryable: true,
        category: "temporary_connection_failure",
        status: null,
        code: null,
        timeout: false,
      };
    }
  }

  // Legacy callers and test adapters may not expose a structured HTTP status.
  const description = chain.map((current) => [
    errorField(current, "name"),
    errorField(current, "message"),
    errorField(current, "code"),
  ].filter(Boolean).join(" ")).join(" | ");
  const httpMatch = description.match(/R2 GET failed \((408|429|500|502|503|504)\)/i);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    return {
      retryable: true,
      category: "transient_http_status",
      status,
      code: null,
      timeout: status === 408,
    };
  }
  return {
    retryable: false,
    category: "permanent_or_validation_failure",
    status: null,
    code: null,
    timeout: false,
  };
}

export function integrityR2GetRetryDelayMs(
  attempt,
  random = Math.random,
) {
  const base = Math.min(
    INTEGRITY_R2_GET_RETRY_MAX_MS,
    INTEGRITY_R2_GET_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)),
  );
  const jitter = (Number(random()) * 2 - 1)
    * INTEGRITY_R2_GET_RETRY_JITTER_RATIO;
  return Math.max(0, Math.round(base * (1 + jitter)));
}

function defaultLog(event) {
  process.stderr.write(
    `UK_AQ_INTEGRITY_PROGRESS ${JSON.stringify(event)}\n`,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getIntegrityR2ObjectWithRetry({
  getObject,
  r2,
  key,
  phase = "canonical_apply_r2_get",
  maxAttempts = INTEGRITY_R2_GET_MAX_ATTEMPTS,
  log = defaultLog,
  sleepFn = sleep,
  random = Math.random,
  now = () => Date.now(),
}) {
  if (typeof getObject !== "function") {
    throw new TypeError("Integrity R2 GET retry requires a getObject adapter");
  }
  const boundedMaxAttempts = Number.isSafeInteger(Number(maxAttempts))
    && Number(maxAttempts) > 0
    ? Number(maxAttempts)
    : INTEGRITY_R2_GET_MAX_ATTEMPTS;
  const startedAt = now();
  for (let attempt = 1; attempt <= boundedMaxAttempts; attempt += 1) {
    try {
      const result = await getObject({
        r2,
        key,
        // The shared SigV4 helper must make one transport attempt here; this
        // Integrity wrapper owns the bounded, observable retry lifecycle.
        max_attempts: 1,
      });
      if (attempt > 1) {
        log({
          phase,
          event: "r2_get_recovered",
          object_key: key,
          attempt,
          max_attempts: boundedMaxAttempts,
          elapsed_ms: Math.max(0, now() - startedAt),
        });
      }
      return result;
    } catch (error) {
      const classification = classifyIntegrityR2GetError(error);
      if (!classification.retryable || attempt >= boundedMaxAttempts) {
        if (classification.retryable) {
          log({
            phase,
            event: "r2_get_retry_exhausted",
            object_key: key,
            attempt,
            max_attempts: boundedMaxAttempts,
            category: classification.category,
            http_status: classification.status,
            error_code: classification.code,
            timeout: classification.timeout,
            elapsed_ms: Math.max(0, now() - startedAt),
          });
        }
        throw error;
      }
      const backoffMs = integrityR2GetRetryDelayMs(attempt, random);
      log({
        phase,
        event: "r2_get_retry",
        object_key: key,
        attempt,
        next_attempt: attempt + 1,
        max_attempts: boundedMaxAttempts,
        category: classification.category,
        http_status: classification.status,
        error_code: classification.code,
        timeout: classification.timeout,
        backoff_ms: backoffMs,
        elapsed_ms: Math.max(0, now() - startedAt),
      });
      await sleepFn(backoffMs);
    }
  }
  throw new Error("Integrity R2 GET retry loop exhausted unexpectedly");
}
