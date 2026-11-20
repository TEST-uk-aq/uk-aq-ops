import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const SHELL_LIFETIME_MS = 10_800_000;
const WORK_LIFETIME_MS = 10_680_000;
const LAUNCH_FLAG = "--actions-worker-origin";
const CHILD_FLAG = "--actions-worker-child";
const CLOCK = "linux_proc_uptime";
// /proc/uptime is rounded down to centiseconds. The launch uses the lower
// bound and admission uses the upper bound, so rounding cannot extend work.
function parseUptime(value) {
  if (typeof value !== "string" || !/^\d{1,10}\.\d{2}$/.test(value)) {
    throw new Error("Invalid Linux monotonic worker clock");
  }
  const [seconds, hundredths] = value.split(".");
  return Number(seconds) * 1000 + Number(hundredths) * 10;
}

function uptimeMs() {
  return parseUptime(readFileSync("/proc/uptime", "utf8").split(" ", 1)[0]);
}

function procArgs(pid) {
  return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1);
}

function parentOf(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  return Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]);
}

function sameArgs(actual, expected) {
  return actual.length === expected.length && expected.every((part, index) => part === actual[index]);
}

function assertLauncher(pid, jobPath, launchArgs) {
  const [executable, ...args] = procArgs(pid);
  if (args[3]) args[3] = resolve(args[3]);
  if (basename(executable) !== "timeout"
    || !sameArgs(args, ["--kill-after=30s", "180m", "node", jobPath, ...launchArgs])) {
    throw new Error("wrong launcher");
  }
}

export function createWorkerBudget(originMs, clock = uptimeMs) {
  const nowMs = () => clock() + 10;
  const deadlineMs = originMs + WORK_LIFETIME_MS;
  const shellDeadlineMs = originMs + SHELL_LIFETIME_MS;
  let deferred = null;
  let deletionAttempted = false;
  let failure = null;
  const fits = (allowanceMs) => Number.isSafeInteger(allowanceMs) && allowanceMs > 0
    && nowMs() + allowanceMs < deadlineMs;
  return Object.freeze({
    originMs, nowMs, deadlineMs, shellDeadlineMs, fits,
    admit(stage, allowanceMs) {
      if (fits(allowanceMs)) return true;
      deferred ??= { status: "deferred_budget", stage, allowance_ms: allowanceMs,
        remaining_ms: Math.max(0, deadlineMs - nowMs()) };
      return false;
    },
    markDeletionAttempted() { deletionAttempted = true; },
    recordFailure(error) { failure ??= error; },
    failure() { return failure; },
    report() {
      return { clock: CLOCK, launch_ms: originMs, work_cutoff_ms: deadlineMs,
        shell_cutoff_ms: shellDeadlineMs, deferred, deletion_attempted: deletionAttempted };
    },
  });
}

export function resolveWorkerLaunch({ argv, env, lockContext, jobPath }) {
  const actions = env.GITHUB_ACTIONS === "true" && env.GITHUB_WORKFLOW === "UK AQ Prune Daily";
  if (!actions && argv.length === 0) return null;
  try {
    if (!actions) throw new Error("private origin outside supervised Actions");
    const [mode, origin, runId] = argv;
    const originMs = parseUptime(origin);
    const current = uptimeMs();
    if (originMs > current || current - originMs >= SHELL_LIFETIME_MS) {
      throw new Error("implausible origin");
    }
    const launchArgs = [LAUNCH_FLAG, origin];
    if (!lockContext.held) {
      if (!sameArgs(argv, launchArgs)) throw new Error("invalid launch arguments");
      assertLauncher(process.ppid, jobPath, launchArgs);
    } else {
      const supervisor = procArgs(process.ppid);
      const coordinatorPid = parentOf(process.ppid);
      const coordinator = procArgs(coordinatorPid);
      if (mode !== CHILD_FLAG || argv.length !== 3 || !lockContext.valid
        || runId !== lockContext.run_id || !process.connected
        || basename(supervisor[1] || "") !== "uk_aq_observations_global_operation_child_supervisor.mjs"
        || !sameArgs(supervisor.slice(-4), [jobPath, ...argv])
        || !sameArgs(coordinator.slice(-2), launchArgs) || resolve(coordinator[1] || "") !== jobPath) {
        throw new Error("wrong original-operation child");
      }
      assertLauncher(parentOf(coordinatorPid), jobPath, launchArgs);
    }
    return Object.freeze({
      budget: createWorkerBudget(originMs),
      childArgs: (originalRunId) => [CHILD_FLAG, origin, originalRunId],
    });
  } catch (cause) {
    const error = new Error("Prune Daily could not validate its supervised monotonic launch origin", { cause });
    error.code = "UK_AQ_PRUNE_WORKER_TIMING_AUTHORITY_INVALID";
    throw error;
  }
}

export class PruneWorkBudgetDeferred extends Error {
  constructor() {
    super("Prune Daily deferred work at the worker cutoff");
  }
}

export function requirePruneWork(budget, stage, allowanceMs) {
  if (budget && !budget.admit(stage, allowanceMs)) throw new PruneWorkBudgetDeferred();
}
