import { createHash, timingSafeEqual } from "node:crypto";

export const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
export const DISPATCH_AUTH_HEADER = "x-uk-aq-dispatch-secret";

function securelyMatches(suppliedValue, expectedValue) {
  const supplied = String(suppliedValue || "").trim();
  const expected = String(expectedValue || "").trim();
  if (!supplied || !expected) {
    return false;
  }

  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

export function validateRunAuth(req, env = process.env) {
  const upstreamValid = securelyMatches(
    req.headers[UPSTREAM_AUTH_HEADER],
    env.UK_AQ_EDGE_UPSTREAM_SECRET,
  );
  const dispatchValid = securelyMatches(
    req.headers[DISPATCH_AUTH_HEADER],
    env.UK_AQ_CLOUD_RUN_DISPATCH_SECRET,
  );

  if (upstreamValid || dispatchValid) {
    return { ok: true };
  }

  return { ok: false, status: 403, error: "Forbidden." };
}
