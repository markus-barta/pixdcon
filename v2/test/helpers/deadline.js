/**
 * Hard deadline, the part inside every test file's process.
 *
 * The three test kinds have a budget of 60 s together (phase-2 decision). A
 * run that hangs must not hold the gate: a broker that did not start, a
 * display fake that never answers, a handle somebody forgot to close.
 *
 * test/helpers/run.js starts the run, picks one absolute time for all of it
 * (start + 55 s) and passes it in PIXDCON2_TEST_DEADLINE_AT. This module is
 * preloaded into every test file's process (`node --import`; Node loads
 * preloads in the test files' processes, not in the runner). At that time
 * the process exits with code 1, which the runner reports as a failed file.
 * A process that cannot even run a timer any more (a loop that never
 * yields) is killed by run.js a moment later, together with everything else
 * the run started.
 *
 * Started without run.js (`node --test` by hand), a file gets 55 s from its
 * own start. The timer never keeps a finished process alive.
 */

const BUDGET_MS = 55_000;

const started = Date.now();
const given = Number(process.env.PIXDCON2_TEST_DEADLINE_AT);
const deadlineAt =
  Number.isFinite(given) && given > 0 ? given : started + BUDGET_MS;

const timer = setTimeout(
  () => {
    process.stderr.write(
      `\n[test] hard deadline: this test file is still running at the end of the run's time budget ` +
        `(${Math.round((Date.now() - started) / 100) / 10} s after it started). ` +
        `The three test kinds must finish inside 60 s; something hangs or was not closed. Exiting with code 1.\n`,
    );
    process.exit(1);
  },
  Math.max(0, deadlineAt - started),
);
timer.unref();

export { deadlineAt };
