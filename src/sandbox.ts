import { existsSync } from "node:fs";
import { dirname } from "node:path";

export type SandboxSpawn = { command: string; args: string[] };

const READ_ONLY_SYSTEM_PATHS = ["/usr", "/lib", "/lib64", "/bin", "/etc/resolv.conf", "/etc/ssl", "/etc/hosts"];

function pythonRootFor(pythonPath: string) {
  // e.g. /opt/venv/bin/python -> /opt/venv. A bare "python"/"python3" resolved via PATH has no
  // dedicated root of its own to bind beyond what READ_ONLY_SYSTEM_PATHS already covers.
  if (!pythonPath.includes("/")) return null;
  return dirname(dirname(pythonPath));
}

/**
 * Wraps a Kryptotron worker invocation in a bubblewrap (bwrap) sandbox so it can only read the
 * Python runtime and its own source, and can only read+write its own working directory — it
 * cannot see sibling workers' state, the rest of the app, secrets it wasn't given directly, or
 * other processes (own PID namespace). Network is intentionally left shared with the host: the
 * worker still needs to reach Ocean's own 127.0.0.1 internal API and Binance, and isolating
 * network would require real namespace bridging this doesn't attempt.
 */
export function sandboxedSpawn(pythonPath: string, scriptPath: string, workingDirectory: string): SandboxSpawn {
  const args: string[] = [];
  for (const path of READ_ONLY_SYSTEM_PATHS) {
    if (existsSync(path)) args.push("--ro-bind", path, path);
  }
  const pythonRoot = pythonRootFor(pythonPath);
  if (pythonRoot && existsSync(pythonRoot)) args.push("--ro-bind", pythonRoot, pythonRoot);
  const scriptDir = dirname(scriptPath);
  args.push("--ro-bind", scriptDir, scriptDir);
  args.push("--bind", workingDirectory, workingDirectory);
  args.push(
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--die-with-parent",
    "--proc", "/proc",
    "--chdir", workingDirectory,
    "--",
    pythonPath,
    scriptPath,
  );
  return { command: "bwrap", args };
}
