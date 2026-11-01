import { requireValid as check } from '../schema.mjs';
import { authenticatedTerminalSourceDay } from './currentness.mjs';
import { failureReason, rethrowInvocationFault } from './failures.mjs';

const DAY = 86_400_000;
const midnight = month => `${month}-01T00:00:00.000Z`;
const nextMonth = month => {
  const date = new Date(midnight(month));
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString();
};

export function selectMonths(value, nowUtc, maxDays) {
  check(/^\d{4}-(?:0[1-9]|1[0-2])(?::\d{4}-(?:0[1-9]|1[0-2]))?$/.test(value || ''),
    '--months must be YYYY-MM or inclusive YYYY-MM:YYYY-MM');
  const [first, last = first] = value.split(':');
  const currentMonth = nowUtc.slice(0, 7);
  check(first <= last, '--months range is reversed');
  check(last <= currentMonth, '--months cannot select a future UTC month');
  const start = midnight(first), end = nextMonth(last);
  // Reserve all selected calendar days before any source work, including the
  // open month's possible days. Discovery cannot enlarge the admitted budget.
  check((Date.parse(end) - Date.parse(start)) / DAY <= maxDays, 'month range exceeds max-days budget');
  const periods = [];
  for (let cursor = start; cursor < end; cursor = nextMonth(cursor.slice(0, 7))) {
    const month = cursor.slice(0, 7), monthEnd = nextMonth(month);
    periods.push({ month_utc: month, month_start_utc: cursor, month_end_exclusive_utc: monthEnd,
      requested_start_utc: cursor, requested_end_exclusive_utc: month === currentMonth ? null : monthEnd,
      partial_month: month === currentMonth,
      selection_mode: month === currentMonth ? 'automatic_current_month' : 'complete_historical_month' });
  }
  return { requested: value, first_month_utc: first, last_month_utc: last,
    invocation_now_utc: nowUtc, current_month_utc: currentMonth, start, end, periods };
}

// Only selected Dropbox completion evidence chooses E. No canonical R2 result
// can shorten it. The conservative terminal policy uses a completed following
// timestamp-day; authenticated parent omission alone never establishes a day.
export async function resolveMonths(source, selection) {
  const plans = [], periods = [];
  const todayMs = Math.floor(Date.parse(selection.invocation_now_utc) / DAY) * DAY;
  const completedDay = (day, dayUtc) => authenticatedTerminalSourceDay(day, dayUtc)
    && Date.parse(day.copied_at) <= Date.parse(selection.invocation_now_utc);
  for (const requested of selection.periods) {
    if (!requested.partial_month) {
      plans.push({ ...requested, state: 'planned_full_month', cutoff_basis: 'entire_historical_calendar_month' });
      periods.push({ ...requested });
      continue;
    }
    const plan = { ...requested, state: 'incomplete', selected_cutoff_utc: null,
      completed_reporting_days: [], selected_reporting_days: [], terminal_source: null,
      cutoff_basis: 'selected_checkpoint_consecutive_completed_days_and_completed_terminal_day' };
    plans.push(plan);
    if (Date.parse(requested.month_start_utc) === todayMs) {
      plan.reason = 'no_completed_current_month_reporting_days';
      continue;
    }
    try {
      const days = [];
      for (let ms = Date.parse(requested.month_start_utc); ms <= todayMs; ms += DAY)
        days.push(new Date(ms).toISOString().slice(0, 10));
      const snapshot = await source.observationMonthSnapshot(requested.month_utc, days);
      plan.source_month_evidence = snapshot;
      const byDay = new Map(snapshot.selected_days.map(day => [day.day_utc, day]));
      let cutoff = null;
      for (let ms = Date.parse(requested.month_start_utc); ms < todayMs; ms += DAY) {
        const dayUtc = new Date(ms).toISOString().slice(0, 10), day = byDay.get(dayUtc);
        // Reuse the positive copied-after-day-end admission for reporting days.
        if (!completedDay(day, dayUtc)) {
          plan.first_uncompleted_day_utc = dayUtc;
          plan.backup_coverage_stop_reason = 'reporting_day_completion_not_established';
          break;
        }
        plan.completed_reporting_days.push(day);
        const terminalUtc = new Date(ms + DAY).toISOString().slice(0, 10);
        const terminal = byDay.get(terminalUtc);
        if (ms + 2 * DAY <= todayMs && completedDay(terminal, terminalUtc)) {
          cutoff = new Date(ms + DAY).toISOString();
          plan.terminal_source = terminal;
        } else {
          plan.unavailable_next_terminal_day_utc = terminalUtc;
        }
      }
      if (!cutoff) {
        plan.reason = plan.completed_reporting_days.length
          ? 'completed_following_terminal_source_not_available' : 'no_completed_current_month_reporting_days';
        continue;
      }
      plan.state = 'planned_partial_month';
      plan.selected_cutoff_utc = cutoff;
      plan.requested_end_exclusive_utc = cutoff;
      plan.selected_reporting_days = plan.completed_reporting_days.filter(day => day.day_utc < cutoff.slice(0, 10));
      periods.push({ ...requested, requested_end_exclusive_utc: cutoff });
    } catch (error) {
      rethrowInvocationFault(error);
      plan.reason = failureReason(error);
      plan.message = error.message;
    }
  }
  return { ...selection, plans, periods };
}
