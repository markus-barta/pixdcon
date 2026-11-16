#!/usr/bin/env node
/**
 * Test runner entry: `node test/helpers/run.js <test file patterns…>`.
 *
 * Starts Node's own test runner with the two preloads every test file needs
 * (dev/net-guard.js: only loopback is reachable; test/helpers/deadline.js:
 * the file ends itself at the deadline) and holds the whole run to a hard
 * deadline inside the 60 s budget of the three test kinds:
 *
 *   start            the run gets one absolute deadline, start + 55 s
 *   a test > 20 s    cancelled by the runner, by name (--test-timeout)
 *   tests finished   the file's process exits even when a handle was left
 *                    open (--test-force-exit): a leak must not stall the gate
 *   deadline         every test file's process exits with code 1 (deadline.js)
 *   deadline + 1.5 s whatever is still alive is killed, also a process that
 *                    cannot run a timer any more, and this script exits 1
 *
 * The run is its own process group, so "whatever is still alive" is exactly
 * the runner and the processes it started, and nothing of the caller.
 *
 * PIXDCON2_TEST_DEADLINE_MS and PIXDCON2_TEST_DEADLINE_GRACE_MS change the two
 * times; the harness's own test uses short ones.
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const v2Root = resolve(here, "../..");

const budgetMs = Number(process.env.PIXDCON2_TEST_DEADLINE_MS) || 55_000;
const graceMs = Number(process.env.PIXDCON2_TEST_DEADLINE_GRACE_MS) || 1_500;
const patterns = process.argv.slice(2);
if (patterns.length === 0) {
  process.stderr.write(
    "usage: node test/helpers/run.js <test file patterns…>\n",
  );
  process.exit(2);
}

const started = Date.now();
const runner = spawn(
  process.execPath,
  [
    "--import",
    resolve(v2Root, "dev/net-guard.js"),
    "--import",
    resolve(here, "deadline.js"),
    "--test",
    "--test-timeout=20000",
    "--test-force-exit",
    ...patterns,
  ],
  {
    cwd: v2Root,
    stdio: "inherit",
    detached: true, // its own process group: the deadline can end all of it
    env: {
      ...process.env,
      PIXDCON2_TEST_DEADLINE_AT: String(started + budgetMs),
    },
  },
);

/** @param {NodeJS.Signals} signal */
const signalRun = (signal) => {
  if (runner.pid === undefined) return;
  try {
    process.kill(-runner.pid, signal);
  } catch {
    runner.kill(signal);
  }
};

const backstop = setTimeout(() => {
  process.stderr.write(
    `\n[test] hard deadline: the test run is still alive ${Math.round((Date.now() - started) / 100) / 10} s after it started. ` +
      "Killing what is left of it and exiting with code 1.\n",
  );
  signalRun("SIGKILL");
  process.exit(1);
}, budgetMs + graceMs);

// The run is not in the terminal's foreground group: pass Ctrl-C and a stop on.
process.on("SIGINT", () => signalRun("SIGINT"));
process.on("SIGTERM", () => signalRun("SIGTERM"));

runner.on("error", (error) => {
  clearTimeout(backstop);
  process.stderr.write(
    `[test] could not start the test runner: ${error.message}\n`,
  );
  process.exit(1);
});
runner.on("exit", (code, signal) => {
  clearTimeout(backstop);
  process.exit(signal ? 1 : (code ?? 1));
});
