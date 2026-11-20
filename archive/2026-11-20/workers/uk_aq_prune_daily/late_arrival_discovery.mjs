const DAY_MS = 86_400_000;
export const MAX_LATE_ARRIVAL_WINDOWS_PER_RUN = 14;
export const MAX_LATE_ARRIVAL_DIRECT_DELETE_DAYS_PER_RUN = 14;
export const LATE_ARRIVAL_LIMITS = Object.freeze({
  pageDays: 31, maxPages: 8, maxRequests: 10, maxMilliseconds: 120_000,
  requestMilliseconds: 20_000, repairDays: MAX_LATE_ARRIVAL_WINDOWS_PER_RUN,
  directDeleteDays: MAX_LATE_ARRIVAL_DIRECT_DELETE_DAYS_PER_RUN,
});

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw new Error("Invalid UTC discovery timestamp");
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0, 19) !== value.slice(0, 19)) throw new Error("Invalid UTC discovery timestamp");
  return normalized;
}

function day(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value)
    || value < "0001-01-01" || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid UTC discovery date");
  }
  return value;
}
const midnight = (value) => `${day(value)}T00:00:00.000Z`;
export const addDiscoveryDays = (value, count) => new Date(Date.parse(midnight(value)) + count * DAY_MS).toISOString().slice(0, 10);
const dayCount = (from, to) => Math.round((Date.parse(midnight(to)) - Date.parse(midnight(from))) / DAY_MS);

export function validatePresenceResponse(payload, from, to, now = Date.now()) {
  const count = dayCount(from, to);
  if (count < 1 || count > 366 || !payload || payload.schema_version !== 1 || payload.complete !== true
    || payload.from_day_utc !== from || payload.to_day_utc_exclusive !== to
    || payload.checked_day_count !== count || !Array.isArray(payload.days) || payload.days.length !== count) {
    throw new Error("Incomplete or mismatched observation-day presence response");
  }
  const checked = timestamp(payload.checked_at_utc);
  if (day(payload.current_day_utc) !== checked.slice(0, 10)
    || Math.abs(Date.parse(checked) - now) > 300_000 || to > addDiscoveryDays(payload.current_day_utc, 1)) {
    throw new Error("Untrustworthy observation-day presence timestamp");
  }
  for (let index = 0; index < count; index++) {
    if (payload.days[index]?.day_utc !== addDiscoveryDays(from, index)
      || typeof payload.days[index]?.present !== "boolean") {
      throw new Error("Malformed observation-day presence entries");
    }
  }
  return payload.days;
}

export function createLateArrivalReader(ingestClient) {
  return {
    async earliest(cutoff, from, timeout) {
      let query = ingestClient.schema("uk_aq_public").from("observations")
        .select("observed_at").lt("observed_at", cutoff).order("observed_at", { ascending: true }).limit(1);
      if (from) query = query.gte("observed_at", midnight(from));
      const { data, error } = await query.abortSignal(AbortSignal.timeout(timeout));
      if (error) throw new Error(`Late-arrival timestamp seek failed: ${error.message}`);
      if (!Array.isArray(data) || data.length > 1) throw new Error("Malformed timestamp seek response");
      if (!data.length) return null;
      // PostgREST timestamps may use +00:00 instead of Z.
      const observed = timestamp(String(data[0].observed_at).replace(/\+00:00$/, "Z"));
      if (observed >= cutoff || (from && observed < midnight(from))) throw new Error("Timestamp seek escaped bounds");
      return observed;
    },
    async presence(from, to, timeout) {
      const { data, error } = await ingestClient.schema("uk_aq_public")
        .rpc("uk_aq_rpc_observation_day_presence_v1", { p_from_day_utc: from, p_to_day_utc_exclusive: to })
        .abortSignal(AbortSignal.timeout(timeout));
      if (error) throw new Error(`Late-arrival day presence failed: ${error.message}`);
      return data;
    },
  };
}

function validateState(state, now) {
  if (!state) return;
  if (state.schema_version !== 1 || !/^\d+$/.test(String(state.progress_version))
    || typeof state.sweep_complete !== "boolean") throw new Error("Unsupported discovery progress state");
  if (state.sweep_cutoff !== null && Date.parse(timestamp(state.sweep_cutoff)) > now) throw new Error("Future discovery cutoff");
  if (state.sweep_complete) {
    if (state.next_day_utc !== null) throw new Error("Completed discovery cursor is inconsistent");
  } else if (!state.sweep_cutoff || midnight(state.next_day_utc) >= timestamp(state.sweep_cutoff)) {
    throw new Error("Discovery cursor escaped frozen sweep");
  }
}

// Pure orchestration with injected I/O; all authority stays in processDay's
// existing Prune paths. A checkpoint is evidence of consideration, never deletion.
export async function discoverAndProcessLateArrivals({
  cutoff, dryRun, progress, reader, processDay, classifyDay, runId,
  now = Date.now, limits = LATE_ARRIVAL_LIMITS,
}) {
  const started = now();
  const deadline = started + limits.maxMilliseconds;
  let cursor = progress.state ? { ...progress.state } : null;
  let lastAcknowledgedCursor = cursor ? { ...cursor } : null;
  let validated = false;
  const report = {
    run_id: runId, enabled: true, skipped: false, dry_run: dryRun,
    progress_persisted: false, status: "running", attention_required: false,
    scanned_page_count: 0, discovery_request_count: 0, discovered_day_count: 0,
    examined_day_count: 0, absent_day_count: 0, processed_day_count: 0,
    direct_delete_day_count: 0, repair_day_count: 0, blocked_day_count: 0,
    failed_day_count: 0, deferred_day_count: 0, outcomes: [], wraparound: false,
    persisted_cursor_start: cursor?.next_day_utc ?? null,
    persisted_next_day_utc: cursor?.next_day_utc ?? null,
  };
  const batchSummaries = [];
  let knownPositiveDays = [];
  function position() {
    report.cutoff_window_start = cursor?.sweep_cutoff ?? cutoff;
    report.next_day_utc = cursor?.next_day_utc ?? null;
    report.sweep_complete = cursor?.sweep_complete ?? false;
    report.remaining_work = !report.sweep_complete;
    report.remaining_calendar_day_count = validated && report.next_day_utc
      ? Math.ceil((Date.parse(report.cutoff_window_start) - Date.parse(midnight(report.next_day_utc))) / DAY_MS)
      : report.sweep_complete ? 0 : null;
    report.remaining_positive_day_count = report.remaining_work ? null : 0;
    report.simulated_next_day_utc = dryRun ? report.next_day_utc : null;
  }
  async function checkpoint() {
    position();
    if (!dryRun) {
      try {
        await progress.save(cursor, { ...report, progress_persisted: true, persisted_next_day_utc: cursor.next_day_utc });
      } catch (error) {
        report.checkpoint_outcome_unknown = true;
        cursor = lastAcknowledgedCursor;
        throw error;
      }
      lastAcknowledgedCursor = { ...cursor };
      report.persisted_next_day_utc = cursor.next_day_utc;
      report.progress_persisted = true;
    }
  }
  function budgetReason() {
    if (now() >= deadline) return "runtime_budget";
    if (report.discovery_request_count >= limits.maxRequests) return "request_budget";
    return null;
  }
  async function request(callback) {
    const reason = budgetReason();
    if (reason) throw new Error(`Discovery request attempted after ${reason}`);
    await progress.assertOwned();
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Discovery deadline expired before request");
    report.discovery_request_count++;
    return callback(Math.max(1, Math.min(limits.requestMilliseconds, remaining)));
  }
  try {
    cutoff = timestamp(cutoff);
    if (Date.parse(cutoff) > started) throw new Error("Future discovery cutoff");
    validateState(cursor, started);
    validated = true;
    // A retention/max-hours configuration change may make the old cutoff unsafe.
    // Restart conservatively; never process dates outside the current window.
    if (!cursor || cursor.sweep_complete || timestamp(cursor.sweep_cutoff) > cutoff) {
      if (budgetReason()) {
        report.stop_reason = budgetReason();
      } else {
        report.wraparound = Boolean(cursor?.sweep_complete && cursor?.sweep_cutoff);
        report.restarted_for_earlier_cutoff = Boolean(cursor && !cursor.sweep_complete && cursor.sweep_cutoff > cutoff);
        const earliest = await request((timeout) => reader.earliest(cutoff, null, timeout));
        const first = earliest === null ? null : timestamp(earliest);
        if (first !== null && first >= cutoff) throw new Error("Earliest timestamp escaped discovery cutoff");
        cursor = { schema_version: 1, sweep_cutoff: cutoff, next_day_utc: first?.slice(0, 10) ?? null, sweep_complete: first === null };
        report.empty_sweep = first === null;
        await checkpoint();
      }
    }
    while (cursor && !cursor.sweep_complete && !report.stop_reason) {
      report.stop_reason = budgetReason();
      if (report.stop_reason) break;
      const from = cursor.next_day_utc;
      const cutoffDay = cursor.sweep_cutoff.slice(0, 10);
      let days;
      if (from === cutoffDay) {
        const observed = await request((timeout) => reader.earliest(cursor.sweep_cutoff, from, timeout));
        if (observed !== null && (timestamp(observed) < midnight(from) || timestamp(observed) >= cursor.sweep_cutoff)) {
          throw new Error("Boundary timestamp escaped discovery cutoff");
        }
        days = [{ day_utc: from, present: observed !== null }];
      } else {
        if (report.scanned_page_count >= limits.maxPages) { report.stop_reason = "page_budget"; break; }
        const to = [addDiscoveryDays(from, limits.pageDays), cutoffDay].sort()[0];
        const payload = await request((timeout) => reader.presence(from, to, timeout));
        days = validatePresenceResponse(payload, from, to, now());
        report.scanned_page_count++;
      }
      knownPositiveDays = days.filter((entry) => entry.present).map((entry) => entry.day_utc);
      report.discovered_day_count += knownPositiveDays.length;
      for (const entry of days) {
        if (now() >= deadline) { report.stop_reason = "runtime_budget"; break; }
        await progress.assertOwned();
        if (entry.present) {
          const route = classifyDay(entry.day_utc);
          if (!["direct_delete", "repair"].includes(route)) throw new Error("Unknown late-arrival route");
          const field = route === "repair" ? "repair_day_count" : "direct_delete_day_count";
          const maximum = route === "repair" ? limits.repairDays : limits.directDeleteDays;
          if (report[field] >= maximum) { report.stop_reason = `${route}_day_budget`; break; }
          report[field]++;
          let result;
          try {
            result = await processDay(entry.day_utc, route, report.direct_delete_day_count + report.repair_day_count);
          } catch (error) {
            report.failed_day_count++;
            report.outcomes.push({ day_utc: entry.day_utc, route, outcome: "failed", error: String(error.message || error).slice(0, 500) });
            throw error;
          }
          if (!result || typeof result !== "object") throw new Error("Missing late-arrival day outcome");
          batchSummaries.push(result);
          const errors = Number(result.delete_error_count || 0) + Number(result.delete_after_repair_error_count || 0)
            + Number(result.repair_replay_error_count || 0) + Number(result.error_count || 0) + (result.error ? 1 : 0);
          const blocked = Number(result.alert_condition_count || 0) > 0
            || Number(result.connector_history_gate_blocked_bucket_count || 0) > 0
            || Number(result.connector_history_gate_blocked_after_repair_bucket_count || 0) > 0
            || Number(result.source_identity_blocked_bucket_count || 0) > 0;
          report.outcomes.push({ day_utc: entry.day_utc, route, run_id: result.run_id ?? null,
            outcome: errors ? "failed" : blocked ? "blocked" : "processed",
            gate_blocked_bucket_count: Number(result.connector_history_gate_blocked_bucket_count || 0),
            alert_condition_count: Number(result.alert_condition_count || 0),
            blocked_preview: (result.connector_history_gate_blocked_buckets_preview || result.source_identity_blocked_buckets_preview || [])
              .slice(0, 3).map((item) => ({ connector_id: item.connector_id,
                reason: String(item.reason || item.blocked_reason || "gate_or_source_blocked").slice(0, 200) })) });
          if (errors) {
            report.failed_day_count++;
            throw new Error(`Ambiguous/failed late-arrival processing for ${entry.day_utc}; cursor retained`);
          }
          report.processed_day_count++;
          if (blocked) report.blocked_day_count++;
          knownPositiveDays = knownPositiveDays.filter((value) => value !== entry.day_utc);
        } else {
          report.absent_day_count++;
        }
        report.examined_day_count++;
        const next = addDiscoveryDays(entry.day_utc, 1);
        cursor = { ...cursor, next_day_utc: midnight(next) < cursor.sweep_cutoff ? next : null,
          sweep_complete: midnight(next) >= cursor.sweep_cutoff };
        await checkpoint();
      }
    }
    report.status = cursor?.sweep_complete ? "complete" : "deferred";
    report.stop_reason ||= report.empty_sweep ? "empty_sweep" : "sweep_complete";
    report.deferred_day_count = knownPositiveDays.length;
    report.attention_required = report.status === "deferred" || report.blocked_day_count > 0;
    if (cursor) await checkpoint();
  } catch (error) {
    report.status = "failed";
    report.attention_required = true;
    report.error_count = 1;
    report.error = String(error.message || error).slice(0, 1000);
    report.stop_reason = "failure";
    report.deferred_day_count = knownPositiveDays.length;
    // Never retry an ambiguous checkpoint or advance on RPC/processing failure.
    // last successful checkpoint remains durable; failure is in the run report.
  }
  position();
  report.elapsed_ms = Math.max(0, now() - started);
  report.target_day_count = report.direct_delete_day_count + report.repair_day_count;
  return { report, batchSummaries };
}
