#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const COORDINATOR_LIVENESS_FD = 3;
const FORCED_EXIT_DELAY_MS = 10_000;

function parseCommand(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error("Locked child supervisor requires -- followed by a command");
  }
  return Object.freeze({
    command: argv[separator + 1],
    commandArgs: Object.freeze(argv.slice(separator + 2)),
  });
}

function signalProcessGroup(signal) {
  try {
    process.kill(-process.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export async function superviseLockedCommand({
  command,
  commandArgs = [],
  env = process.env,
  livenessFd = COORDINATOR_LIVENESS_FD,
  spawnProcess = spawn,
} = {}) {
  if (process.platform === "win32") {
    throw new Error("Observations global operation child supervision requires POSIX process groups");
  }

  let finished = false;
  let stoppingSignal = null;
  let forceTimer = null;
  let child = null;

  const emergencyStop = () => {
    try {
      signalProcessGroup("SIGKILL");
    } catch (_error) {
      child?.kill?.("SIGKILL");
      process.kill(process.pid, "SIGKILL");
    }
  };

  const liveness = fs.createReadStream(null, {
    fd: livenessFd,
    autoClose: true,
  });
  liveness.once("end", emergencyStop);
  liveness.once("close", emergencyStop);
  liveness.once("error", emergencyStop);
  liveness.resume();
  process.once("disconnect", emergencyStop);

  const reportResult = (result) => {
    if (!process.send || !process.connected) {
      signalProcessGroup("SIGKILL");
      return;
    }
    process.send({ type: "uk_aq_locked_command_result", ...result }, (error) => {
      if (error) signalProcessGroup("SIGKILL");
    });
  };

  const requestControlledStop = (signal) => {
    if (finished || stoppingSignal) return;
    stoppingSignal = signal;
    // The coordinator signals this entire process group, so the protected
    // child has already received the same controlled cancellation signal.
    forceTimer = setTimeout(() => signalProcessGroup("SIGKILL"), FORCED_EXIT_DELAY_MS);
    forceTimer.unref?.();
  };
  const onSigint = () => requestControlledStop("SIGINT");
  const onSigterm = () => requestControlledStop("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  // After reporting the target result, remain alive until the coordinator
  // kills this whole process group and confirms no descendants survived.
  return await new Promise(() => {
    child = spawnProcess(command, commandArgs, {
      env,
      stdio: "inherit",
      detached: false,
    });
    child.once("error", (error) => {
      finished = true;
      if (forceTimer) clearTimeout(forceTimer);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      reportResult({ error: error instanceof Error ? error.message : String(error) });
    });
    child.once("exit", (code, signal) => {
      finished = true;
      if (forceTimer) clearTimeout(forceTimer);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      reportResult({
        exit_code: Number(code || 0),
        target_signal: signal || null,
        stopping_signal: stoppingSignal,
      });
    });
  });
}

export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseCommand(argv);
  return await superviseLockedCommand({ ...args, env });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((code) => {
    process.exit(code);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
