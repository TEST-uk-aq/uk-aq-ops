import type { WorkerEnv } from "./upstream";

type JsonObject = Record<string, unknown>;
export const R2_PERIOD_SOURCE = "cloudflare_r2_billable_usage_v1";
const END_SOURCE = "cloudflare_account_monthly_subscriptions_v1";
const USABLE_STATES = new Set(["Paid", "Provisioned", "Trial", "AwaitingPayment"]);
const RETIRED_STATES = new Set(["Cancelled", "Expired", "Failed"]);
const DAY_MS = 86400_000;
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
  const freshUntil = billingTimestamp(usage.billing_period_fresh_until_utc);
  const anchor = billingTimestamp(usage.billing_period_anchor_utc);
  const lifecycle = billingTimestamp(usage.billing_period_subscription_start_utc);
  if (!(anchor <= start && lifecycle <= start && start <= verified && verified <= now && verified < freshUntil
    && freshUntil <= verified + (Number.isFinite(end) ? 3600_000 : 300_000) && now < freshUntil && now - start <= 31 * DAY_MS)) {
    return "R2 billing metadata stale or invalid; renewal refresh required";
  }
  if (usage.billing_period_end_utc === null || usage.billing_period_end_utc === undefined) {
    return String(usage.billing_period_error || "R2 end boundary unavailable; current operations withheld until renewal is verified");
  }
  const ids = usage.billing_period_end_subscription_ids;
  if (usage.billing_period_end_source !== END_SOURCE || !Array.isArray(ids) || !ids.length
    || ids.some(value => typeof value !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(value))
    || new Set(ids).size !== ids.length || !(start <= now && now < end)
    || end - start > 31 * DAY_MS || freshUntil > end) {
    return "R2 billing end expired or unverified; renewal refresh required";
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
  if (now >= billingTimestamp(usage.billing_period_fresh_until_utc)) result.billing_period_status = "stale";
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
  // Info has no product family; bind its exact ID to R2 via same-account usage rows.
  const info = await getMetadata(account, "billable-usage/info", token) as JsonObject | null;
  const matches = Array.isArray(info?.subscriptions) ? (info.subscriptions as JsonObject[])
    .filter(row => row && row.id === config.subscription) : [];
  if (info?.covered !== true || matches.length !== 1) {
    throw new Error("R2 Billable Usage coverage/subscription metadata missing or ambiguous");
  }
  const metadata = matches[0];
  const lifecycle = billingTimestamp(metadata.start_timestamp);
  const anchor = billingTimestamp(metadata.billing_cycle_anchor_timestamp);
  const now = Date.now();
  if (!(lifecycle <= now && anchor <= now) || metadata.end_timestamp != null) {
    throw new Error("R2 Billable Usage subscription inactive or lifecycle/anchor metadata invalid");
  }
  const rows = await getMetadata(account, "billable-usage", token);
  const starts = Array.isArray(rows) ? (rows as JsonObject[])
    .filter(row => row && row.BillingAccountId === account && row.SubscriptionId === config.subscription
      && row.ServiceFamilyName === "R2")
    .map(row => billingTimestamp(row.BillingPeriodStart))
    .filter(value => lifecycle <= value && anchor <= value && value <= now) : [];
  if (!starts.length) throw new Error("R2 billing start missing for configured account/subscription and metadata");
  const start = starts.reduce((latest, value) => Math.max(latest, value));
  let end: number | null = null;
  let endIds: string[] = [];
  let endError = "No unambiguous matching monthly account subscription period";
  try {
    const accountRows = await getMetadata(account, "subscriptions", token);
    if (!Array.isArray(accountRows) || !accountRows.length) throw new Error(endError);
    const periods: { id: string; end: number }[] = [];
    for (const row of accountRows as JsonObject[]) {
      if (!row || typeof row !== "object") throw new Error(endError);
      if (["weekly", "quarterly", "yearly", "not-applicable"].includes(String(row.frequency)) || RETIRED_STATES.has(String(row.state))) continue;
      const rowStart = billingTimestamp(row.current_period_start);
      const rowEnd = billingTimestamp(row.current_period_end);
      if (row.frequency !== "monthly" || !USABLE_STATES.has(String(row.state))
        || typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(row.id)
        || rowStart !== start || !(start <= now && now < rowEnd) || rowEnd - start > 31 * DAY_MS) {
        throw new Error(endError);
      }
      periods.push({ id: row.id, end: rowEnd });
    }
    if (!periods.length || new Set(periods.map(row => row.end)).size !== 1
      || new Set(periods.map(row => row.id)).size !== periods.length) throw new Error(endError);
    end = periods[0].end;
    endIds = periods.map(row => row.id).sort();
  } catch (error) { endError = (error as Error).message; }
  const verified = Date.now();
  const freshUntil = Math.min(verified + (end === null ? 300_000 : 3600_000), start + 31 * DAY_MS, end ?? Infinity);
  return {
    billing_period_start_utc: new Date(start).toISOString(),
    billing_period_end_utc: end === null ? null : new Date(end).toISOString(),
    billing_period_verified_at_utc: new Date(verified).toISOString(),
    billing_period_fresh_until_utc: new Date(freshUntil).toISOString(),
    billing_period_source: R2_PERIOD_SOURCE, billing_period_account_id: account,
    billing_period_subscription_id: config.subscription, billing_period_anchor_utc: new Date(anchor).toISOString(),
    billing_period_subscription_start_utc: new Date(lifecycle).toISOString(),
    billing_period_end_source: end === null ? null : END_SOURCE, billing_period_end_subscription_ids: endIds,
    billing_period_status: verified >= freshUntil ? "stale" : end === null ? "start_only" : "verified",
    billing_period_error: verified >= freshUntil ? "R2 billing metadata stale; renewal refresh required"
      : end === null ? `R2 end/renewal unavailable; current operations withheld: ${endError}` : null,
  };
}
