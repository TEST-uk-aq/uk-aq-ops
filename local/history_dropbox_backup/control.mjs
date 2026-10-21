#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { active, atomic, atomicText, childEnvironment, load, locations, mutex, now,
  prepare, read, remoteConfiguration, repo, requireSafe } from "./config.mjs";

process.umask(0o077);
const usage = "Usage: node local/history_dropbox_backup/control.mjs <install|start|status|stop|retry|new|uninstall> --environment TEST|LIVE --config /absolute/.../TEST/config/backup.json [--operation UUID]";
const [command, ...argv] = process.argv.slice(2);
let p;
function launchctl(args, allowFailure = false) {
  const r = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 15000 });
  if (!allowFailure) requireSafe(!r.error && r.status === 0, "launchctl_failed");
  return !r.error && r.status === 0;
}
function configured() {
  const c = load(p);
  remoteConfiguration(c, childEnvironment(c, p));
  requireSafe(p.environment !== "LIVE" || c.live_activation_authorized === true, "live_inactive");
  return c;
}
function fresh(c) {
  return { schema_version: 1, operation_id: randomUUID(), environment: p.environment,
    created_at: now(), configuration_identity: c.fingerprint, identity: c.identity,
    attempts: 0, attempts_since_review: 0, status: "ready", started_at: null, completed_at: null,
    last_failure_category: null, last_accepted_report: null, successful_completion: null,
    next_attempt_at: null, current_invocation: null };
}
function xml(value) { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]); }
function loaded() { return launchctl(["print", `gui/${process.getuid()}/${p.label}`], true); }
function launch() {
  requireSafe(fs.existsSync(p.plist), "install_required");
  if (!loaded()) launchctl(["bootstrap", `gui/${process.getuid()}`, p.plist]);
  else launchctl(["kickstart", `gui/${process.getuid()}/${p.label}`]);
}
async function stop() {
  prepare(p);
  // Publish intent before bootout so a reboot/SIGKILL cannot re-arm this operation.
  const state = active(p);
  if (state) atomic(p.stop, { operation_id: state.operation_id, requested_at: now() });
  if (loaded()) launchctl(["bootout", `gui/${process.getuid()}/${p.label}`]);
  // Wait for graceful lock release. Never use kickstart -k or force recovery.
  const deadline = Date.now() + 45000;
  while (true) {
    let release;
    try {
      release = mutex(p);
      const current = active(p);
      if (current && current.status !== "completed") {
        current.status = "blocked"; current.next_attempt_at = null;
        current.last_failure_category = "operator_stopped"; atomic(p.active, current);
      }
      release(); return;
    } catch (e) {
      if (release) release();
      requireSafe(e.category === "already_running" && Date.now() < deadline, "stop_requires_review");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
try {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    requireSafe(["--environment", "--config", "--operation"].includes(argv[i])
      && argv[i + 1] && !options[argv[i]], "arguments");
    options[argv[i]] = argv[i + 1];
  }
  requireSafe(["install", "start", "status", "stop", "retry", "new", "uninstall"].includes(command)
    && options["--environment"] && options["--config"], "arguments");
  p = locations(options["--environment"], options["--config"]);
  if (command === "status") {
    if (!fs.existsSync(p.config)) console.log("Not configured");
    else {
      let state, configError = null;
      try {
        state = active(p);
        const c = load(p);
        requireSafe(!state || c.fingerprint === state.configuration_identity, "configuration_changed");
        requireSafe(p.environment !== "LIVE" || c.live_activation_authorized === true, "live_inactive");
        requireSafe(state?.status === "completed" || !read(p.block), "supervision_review");
      } catch (e) { configError = e.category || "configuration_or_state_invalid"; }
      const stopRequested = fs.existsSync(p.stop) && read(p.stop)?.operation_id === state?.operation_id;
      let status = configError ? "Blocked" : state ? state.status[0].toUpperCase() + state.status.slice(1) : "Ready";
      if (!configError && state?.status === "running" && process.platform === "darwin") {
        const service = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${p.label}`], { encoding: "utf8", timeout: 5000 });
        if (!/state = running/.test(service.stdout || "")) status = stopRequested ? "Blocked" : "Retrying";
      }
      console.log(JSON.stringify({ status, environment: p.environment, operation_id: state?.operation_id || null,
        attempts: state?.attempts || 0, attempts_since_review: state?.attempts_since_review || 0,
        last_error: configError || state?.last_failure_category || null,
        next_attempt_at: state?.next_attempt_at || null, started_at: state?.started_at || null,
        completed_at: state?.completed_at || null,
        completed_report_identity: state?.successful_completion?.report_identity || null,
        last_accepted_report_identity: state?.last_accepted_report?.report_identity || null,
        stop_requested: stopRequested, logs: p.logs, reports: p.reports }, null, 2));
    }
  } else {
    requireSafe(process.platform === "darwin", "macos_required");
    requireSafe(Number(process.versions.node.split(".")[0]) >= 20, "node_20_required");
    if (command === "stop" || command === "uninstall") {
      await stop();
      if (command === "uninstall" && fs.existsSync(p.plist)) {
        const s = fs.lstatSync(p.plist);
        requireSafe(s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid(), "plist_permissions");
        fs.unlinkSync(p.plist);
      }
      console.log(`${command === "stop" ? "Stopped" : "Uninstalled"}; state, reports and logs retained at ${p.root}`);
    } else {
      const c = configured(); prepare(p);
      // Operator state edits are serialised with the supervisor. They cannot reset an active run.
      const release = mutex(p);
      let shouldLaunch = false;
      try {
        const state = active(p);
        if (command === "install") {
          requireSafe(!loaded(), "stop_before_install");
          import.meta.resolve("pg");
          fs.mkdirSync(path.dirname(p.plist), { recursive: true, mode: 0o700 });
          const template = fs.readFileSync(new URL("./LaunchAgent.plist.template", import.meta.url), "utf8");
          const values = { LABEL: p.label, NODE: fs.realpathSync(process.execPath),
            SUPERVISOR: fileURLToPath(new URL("./supervisor.mjs", import.meta.url)),
            ENVIRONMENT: p.environment, CONFIG: p.config, REPO: repo, OUTPUT: p.output };
          const rendered = template.replace(/__([A-Z]+)__/g, (_, key) => xml(values[key]));
          // Validate the exact rendered content before publishing the user's LaunchAgent.
          const candidate = path.join(p.output, "candidate.plist");
          atomicText(candidate, rendered);
          const check = spawnSync("/usr/bin/plutil", ["-lint", candidate], { encoding: "utf8", timeout: 5000 });
          requireSafe(check.status === 0, "plist_invalid");
          atomicText(p.plist, rendered); fs.unlinkSync(candidate);
          console.log(`Installed idle LaunchAgent: ${p.plist}; explicit start required`);
        } else if (command === "start") {
          requireSafe(state?.status === "completed" || !read(p.block), "supervision_review");
          if (!state) atomic(p.active, fresh(c));
          else {
            requireSafe(state.configuration_identity === c.fingerprint, "configuration_changed");
            if (state.status === "completed") {
              console.log(`Completed: ${state.operation_id}; use new --operation UUID for a different one-off`);
            } else requireSafe(state.status !== "blocked" && read(p.stop)?.operation_id !== state.operation_id, "review_then_retry_required");
          }
          shouldLaunch = state?.status !== "completed";
        } else {
          requireSafe(state && state.operation_id === options["--operation"], "operation_confirmation_required");
          requireSafe(["blocked", "completed"].includes(state.status), "stop_before_review");
          if (command === "new") {
            const archive = path.join(p.state, "operations", `${state.operation_id}.json`);
            requireSafe(!fs.existsSync(archive), "state_archive_exists");
            atomic(archive, state); atomic(p.active, fresh(c));
          } else {
            requireSafe(state.status === "blocked" && state.configuration_identity === c.fingerprint, "new_operation_required");
            state.reviews ??= [];
            state.reviews.push({ at: now(), after_attempt: state.attempts, previous_failure: state.last_failure_category });
            state.status = "ready"; state.attempts_since_review = 0; state.next_attempt_at = null;
            atomic(p.active, state);
          }
          if (fs.existsSync(p.stop)) fs.unlinkSync(p.stop);
          if (fs.existsSync(p.block)) fs.unlinkSync(p.block);
          shouldLaunch = true;
        }
      } finally { release(); }
      if (shouldLaunch) { launch(); console.log(`Started: ${active(p).operation_id}; use status to inspect progress`); }
    }
  }
} catch (e) {
  // Exceptions can embed parsed credentials. Expose only bounded categories.
  console.error(`Blocked: ${e.category || "local_configuration_or_io"}`);
  if (!p || e.category === "arguments") console.error(usage);
  process.exitCode = 1;
}
