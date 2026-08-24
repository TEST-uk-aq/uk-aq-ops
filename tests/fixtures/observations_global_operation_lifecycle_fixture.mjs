import fs from "node:fs";

import {
  runChildWhileLockHeld,
} from "../../scripts/operations/uk_aq_with_observations_global_operation_lock.mjs";

const [statePath, heartbeatPath] = process.argv.slice(2);
if (!statePath || !heartbeatPath) {
  throw new Error("state and heartbeat paths are required");
}

const targetSource = `
  const fs = require("node:fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, process_group_id: process.ppid }));
  setInterval(() => fs.appendFileSync(process.argv[2], "x"), 25);
`;

process.exitCode = await runChildWhileLockHeld({
  command: process.execPath,
  commandArgs: ["-e", targetSource, statePath, heartbeatPath],
  env: process.env,
});
