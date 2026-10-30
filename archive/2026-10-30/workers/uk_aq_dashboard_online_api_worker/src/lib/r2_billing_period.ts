import type { WorkerEnv } from "./upstream";

type JsonObject = Record<string, unknown>;
export const R2_PERIOD_SOURCE = "cloudflare_r2_subscription_v1";
const OPS_VALUES = [
  "class_a_used_requests", "class_b_used_requests", "class_a_percent_of_free_tier",
  "class_b_percent_of_free_tier", "class_ops_unclassified_requests",
  "class_ops_window_start_utc", "class_ops_window_end_utc",
];

export function billingTimestamp(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/);
  if (!parts) return Number.NaN;
  const [, y, m, d, h, minute, second, , offsetHour, offsetMinute] = parts;
  const days = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
  if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > days
    || Number(h) > 23 || Number(minute) > 59 || Number(second) > 59
    || Number(offsetHour || 0) > 23 || Number(offsetMinute || 0) > 59) return Number.NaN;
  return Date.parse(value);
}

function configuration(env: WorkerEnv): { account: string; subscription: string } {
  const account = String(env.UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const subscription = String(env.UK_AQ_R2_BILLING_SUBSCRIPTION_ID || "");
  if (!/^[a-fA-F0-9]{32}$/.test(account)) throw new Error("R2 billing requires a valid configured R2 Cloudflare account ID");
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(subscription)) {
    throw new Error("Missing or invalid UK_AQ_R2_BILLING_SUBSCRIPTION_ID (verified R2 subscription required)");
  }
  return { account, subscription };
}

export function billingConfigurationKey(env: WorkerEnv): string {
  return [env.UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_ACCOUNT_ID,
    env.UK_AQ_R2_BILLING_SUBSCRIPTION_ID].map(value => String(value || "")).join("|");
}

export function billingConfigurationValid(env: WorkerEnv): boolean {
  try { configuration(env); return true; }
  catch { return false; }
}

export function billingPeriodError(usage: JsonObject | null, env: WorkerEnv, now = Date.now()): string | null {
  let config: ReturnType<typeof configuration>;
  try { config = configuration(env); }
  catch (error) { return (error as Error).message; }
  if (!usage) return "R2 billing period unavailable";
  if (usage.billing_period_source !== R2_PERIOD_SOURCE) {
    return String(usage.billing_period_error || "Verified R2 billing period missing");
  }
  if (usage.billing_period_account_id !== config.account
    || usage.billing_period_subscription_id !== config.subscription) {
    return "Verified R2 billing period missing or configuration changed";
  }
  const start = billingTimestamp(usage.billing_period_start_utc);
  const end = billingTimestamp(usage.billing_period_end_utc);
  const verified = billingTimestamp(usage.billing_period_verified_at_utc);
  if (!(start <= verified && verified <= now && start <= now && now < end)) {
    return "R2 billing period expired or invalid; authoritative subscription refresh required";
  }
  return null;
}

export function r2OperationsError(usage: JsonObject | null, env: WorkerEnv, now = Date.now()): string | null {
  const error = billingPeriodError(usage, env, now);
  if (error || !usage) return error;
  const start = billingTimestamp(usage.billing_period_start_utc);
  const cutoff = billingTimestamp(usage.class_ops_window_end_utc);
  if (billingTimestamp(usage.class_ops_window_start_utc) !== start || !(start <= cutoff && cutoff <= now)) {
    return "R2 operations measurement does not match the verified billing period";
  }
  return null;
}

export function guardR2Usage(usage: JsonObject | null, env: WorkerEnv, now = Date.now()): JsonObject | null {
  if (!usage) return usage;
  const error = r2OperationsError(usage, env, now);
  if (!error) return usage;
  const result = { ...usage };
  for (const key of OPS_VALUES) result[key] = null;
  result.class_ops_unclassified_action_types = [];
  result.billing_period_error = billingPeriodError(usage, env, now);
  result.class_ops_error = result.billing_period_error || usage.class_ops_error || error;
  return result;
}

async function getMetadata(account: string, path: string, token: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new Error("R2 billing metadata request failed"); }
  if (!response.ok) throw new Error(`R2 billing metadata HTTP ${response.status}; Account Billing Read is required`);
  let body: JsonObject;
  try { body = await response.json() as JsonObject; }
  catch { throw new Error("R2 billing metadata returned invalid JSON"); }
  if (!body || body.success !== true || (body.errors && (!Array.isArray(body.errors) || body.errors.length))) {
    throw new Error("Cloudflare R2 billing metadata request was unsuccessful");
  }
  return body.result;
}

export async function fetchR2BillingPeriod(env: WorkerEnv, account: string, analyticsToken: string): Promise<JsonObject> {
  const config = configuration(env);
  if (account !== config.account) throw new Error("R2 billing account does not match the metrics account");
  const token = env.UK_AQ_R2_BILLING_API_TOKEN === undefined
    ? analyticsToken : env.UK_AQ_R2_BILLING_API_TOKEN.trim();
  if (!token) throw new Error("R2 billing requires an Account Billing Read token");
  const result = await getMetadata(account, `subscriptions/${encodeURIComponent(config.subscription)}`, token) as JsonObject | null;
  if (!result || result.id !== config.subscription || result.frequency !== "monthly"
    || !["Paid", "Provisioned", "Trial", "AwaitingPayment"].includes(String(result.state))) {
    throw new Error("Configured R2 subscription is missing, inactive or not monthly");
  }
  const start = billingTimestamp(result.current_period_start);
  const end = billingTimestamp(result.current_period_end);
  if (!(start <= Date.now() && Date.now() < end)) {
    throw new Error("Cloudflare subscription did not return valid current-period timestamps");
  }
  // Generic subscription metadata does not prove R2 ownership or its usage period.
  const rows = await getMetadata(account, "billable-usage", token);
  const r2Rows = Array.isArray(rows) ? rows.filter(row => row && typeof row === "object"
    && row.BillingAccountId === account && row.SubscriptionId === config.subscription
    && row.ServiceFamilyName === "R2") : [];
  if (!r2Rows.length || r2Rows.some(row => billingTimestamp(row.BillingPeriodStart) !== start)) {
    throw new Error("R2 subscription/period could not be verified against current Billable Usage (data may lag)");
  }
  const period: JsonObject = {
    billing_period_start_utc: new Date(start).toISOString(), billing_period_end_utc: new Date(end).toISOString(),
    billing_period_verified_at_utc: new Date().toISOString(), billing_period_source: R2_PERIOD_SOURCE,
    billing_period_account_id: account, billing_period_subscription_id: config.subscription, billing_period_error: null,
  };
  const error = billingPeriodError(period, env);
  if (error) throw new Error(error);
  return period;
}
