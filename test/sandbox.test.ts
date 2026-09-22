import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { sandboxedSpawn } from "../src/sandbox.js";

// Deliberately outside /tmp: sandboxedSpawn mounts a fresh tmpfs over /tmp inside the sandbox,
// which would otherwise shadow a working directory created under the OS default tmpdir().
const SCRATCH_ROOT = resolve(process.cwd(), "data", "sandbox-test-tmp");

const bwrapAvailable = spawnSync("bwrap", ["--version"]).status === 0;

test("sandboxedSpawn wraps the worker in bwrap with a read-only script dir and a writable working dir", () => {
  const { command, args } = sandboxedSpawn("/opt/venv/bin/python", "/app/services/kryptotron/bot.py", "/data/instances/kry_abc");
  assert.equal(command, "bwrap");
  assert.deepEqual(args.slice(-2), ["/opt/venv/bin/python", "/app/services/kryptotron/bot.py"]);
  const pairs: string[][] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "--ro-bind" || args[i] === "--bind") pairs.push([args[i]!, args[i + 1]!, args[i + 2]!]);
  assert.deepEqual(pairs.find((p) => p[1] === "/app/services/kryptotron"), ["--ro-bind", "/app/services/kryptotron", "/app/services/kryptotron"]);
  assert.deepEqual(pairs.find((p) => p[1] === "/data/instances/kry_abc"), ["--bind", "/data/instances/kry_abc", "/data/instances/kry_abc"]);
  assert.equal(pairs.some((p) => p[0] === "--ro-bind" && p[1] === "/data/instances/kry_abc"), false);
  assert.ok(args.includes("--unshare-pid"));
  assert.ok(args.includes("--die-with-parent"));
});

test("sandboxedSpawn binds the venv root, not just the python binary, for a virtualenv interpreter", (t) => {
  // A real directory, since sandboxedSpawn only binds paths that actually exist.
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const fakeVenv = mkdtempSync(join(SCRATCH_ROOT, "fake-venv-"));
  t.after(() => rmSync(fakeVenv, { recursive: true, force: true }));
  mkdirSync(join(fakeVenv, "bin"), { recursive: true });
  const pythonPath = join(fakeVenv, "bin", "python");

  const { args } = sandboxedSpawn(pythonPath, "/app/services/kryptotron/bot.py", "/data/instances/kry_abc");
  const index = args.indexOf(fakeVenv);
  assert.ok(index > 0);
  assert.equal(args[index - 1], "--ro-bind");
  assert.equal(args[index + 1], fakeVenv);
});

test("sandboxedSpawn skips a venv bind for a bare PATH-resolved interpreter", () => {
  const { args } = sandboxedSpawn("python3", "/app/services/kryptotron/bot.py", "/data/instances/kry_abc");
  assert.equal(args.filter((a) => a === "python3").length, 1);
});

test("bwrap actually isolates a sibling instance directory (skipped if bwrap is unavailable)", { skip: !bwrapAvailable }, (t) => {
  // Mirrors production topology: the app's source tree and the per-instance working
  // directories are separate subtrees, so binding one never exposes the other.
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const base = mkdtempSync(join(SCRATCH_ROOT, "ocean-sandbox-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const scriptsDir = join(base, "app", "services", "kryptotron");
  const instancesDir = join(base, "data", "instances");
  const instanceA = join(instancesDir, "kry_a");
  const instanceB = join(instancesDir, "kry_b");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(instanceA, { recursive: true });
  mkdirSync(instanceB, { recursive: true });
  writeFileSync(join(instanceA, "state.json"), "a-secret");
  writeFileSync(join(instanceB, "state.json"), "b-secret");
  const script = join(scriptsDir, "probe.py");
  writeFileSync(script, [
    "import os",
    "print(open('state.json').read())",
    "print(os.path.exists('../kry_b/state.json'))",
    "print(os.path.exists('/etc/hostname'))",
  ].join("\n"));

  const { command, args } = sandboxedSpawn("python3", script, instanceA);
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines[0], "a-secret");
  assert.equal(lines[1], "False");
  assert.equal(lines[2], "False");
});
