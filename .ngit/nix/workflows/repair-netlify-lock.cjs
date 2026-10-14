// Restore omitted metadata without changing Netlify's locked versions.
const fs = require("node:fs");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const metadata = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const [location, pkg] of Object.entries(lock.packages)) {
  if (!location || pkg.inBundle || pkg.link || (pkg.resolved && pkg.integrity))
    continue;
  const name = pkg.name ?? location.split("node_modules/").at(-1);
  const pinned = metadata[`${name}@${pkg.version}`];
  pkg.resolved ??= pinned.resolved;
  pkg.integrity ??= pinned.integrity;
}
fs.writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
