// npm does not apply pnpm.patchedDependencies. Reuse the same reviewed patches.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

if (!process.env.npm_config_user_agent?.startsWith("pnpm/")) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json")));
  for (const [spec, patch] of Object.entries(
    manifest.pnpm?.patchedDependencies ?? {},
  )) {
    const separator = spec.lastIndexOf("@");
    const name = spec.slice(0, separator),
      version = spec.slice(separator + 1);
    const directory = `node_modules/${name}`;
    const installed = JSON.parse(
      readFileSync(resolve(root, directory, "package.json")),
    );
    if (installed.version !== version)
      throw new Error(
        `Patch ${spec} does not match installed ${installed.version}`,
      );
    const run = (...args) =>
      spawnSync("git", ["apply", `--directory=${directory}`, ...args, patch], {
        cwd: root,
        encoding: "utf8",
      });
    if (run("--reverse", "--check").status === 0) continue;
    const check = run("--check");
    if (check.status !== 0)
      throw new Error(`Cannot apply ${patch}: ${check.error ?? check.stderr}`);
    const applied = run();
    if (applied.status !== 0)
      throw new Error(
        `Cannot apply ${patch}: ${applied.error ?? applied.stderr}`,
      );
    console.log(`Applied ${patch}`);
  }
}
