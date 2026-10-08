import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/awtrix-rescue.sh", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pixd49-hardening-rescue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const temp = join(root, "temp");
  await mkdir(bin);
  await mkdir(temp);
  // Entirely synthetic source file; the real credential path is never read.
  const credentials = join(root, "wifi.sh");
  await writeFile(credentials, "HOMEWIFI_SSID='rescue-test-network'\nHOMEWIFI_PASS='rescue-test-placeholder'\n", { mode: 0o600 });
  await writeFile(join(bin, "ping"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  const state = join(root, "state.json");
  await writeFile(join(bin, "curl"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.some((arg) => arg.endsWith("/version"))) {
  process.stdout.write("1.0");
} else {
  const response = args[args.indexOf("-o") + 1];
  const password = args.find((arg) => arg.startsWith("password=<")).slice("password=<".length);
  fs.writeFileSync(process.env.RESCUE_STATE, JSON.stringify({
    password, response,
    passwordMode: fs.statSync(password).mode & 0o777,
    responseMode: fs.statSync(response).mode & 0o777,
    passwordCorrect: fs.readFileSync(password, "utf8") === "rescue-test-placeholder",
    secretInArgv: args.some((arg) => arg.includes("rescue-test-placeholder")),
  }));
  fs.writeFileSync(response, "synthetic response");
  process.stdout.write(process.env.RESCUE_HTTP_CODE || "200");
}
`, { mode: 0o700 });
  return {
    root, bin, temp, state,
    options: { env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: temp,
      HOMEWIFI_ENV: credentials,
      RESCUE_STATE: state,
      AP_HOST: "127.0.0.1",
    } },
  };
}

test("rescue uses private unique password/response files and cleans them on success", async (t) => {
  const { temp, state, options } = await fixture(t);
  const result = await run("bash", [script], options);
  const staged = JSON.parse(await readFile(state, "utf-8"));
  assert.equal(staged.passwordMode, 0o600);
  assert.equal(staged.responseMode, 0o600);
  assert.equal(staged.passwordCorrect, true);
  assert.equal(staged.secretInArgv, false);
  assert.notEqual(staged.password, staged.response);
  assert.match(staged.password, /awtrix-rescue-password\./);
  assert.match(staged.response, /awtrix-rescue-response\./);
  assert.doesNotMatch(result.stdout + result.stderr, /rescue-test-placeholder/);
  assert.deepEqual(await readdir(temp), []);
});

test("rescue removes both private files when the POST fails", async (t) => {
  const { temp, state, options } = await fixture(t);
  options.env.RESCUE_HTTP_CODE = "500";
  await assert.rejects(run("bash", [script], options), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /HTTP 500/);
    assert.doesNotMatch(error.stdout + error.stderr, /rescue-test-placeholder/);
    return true;
  });
  const staged = JSON.parse(await readFile(state, "utf-8"));
  assert.equal(staged.passwordMode, 0o600);
  assert.equal(staged.responseMode, 0o600);
  assert.deepEqual(await readdir(temp), []);
});

test("rescue cleans the password file if response allocation fails", async (t) => {
  const { bin, temp, options } = await fixture(t);
  await writeFile(join(bin, "mktemp"), `#!/usr/bin/env bash
case "$1" in
  *awtrix-rescue-response.*) exit 1 ;;
esac
exec /usr/bin/mktemp "$@"
`, { mode: 0o700 });
  await assert.rejects(run("bash", [script], options), { code: 1 });
  assert.deepEqual(await readdir(temp), []);
});
