// Local captured-data fixture and report receiver; never publishes to relays.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { nip19 } from "nostr-tools";
import { createJourneyFixture } from "./direct-entry-fixture.mjs";
mkdirSync("perf-reports/direct-entry", { recursive: true });
const c = process.env.BENCH_CORPUS
  ? JSON.parse(gunzipSync(readFileSync(process.env.BENCH_CORPUS)))
  : createJourneyFixture({ outbox: process.env.BENCH_OUTBOX === "1" });
c.events.sort(
  (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
);
const roots = c.events.filter((e) => [1618, 1617, 1621].includes(e.kind));
const rootIds = new Set(roots.map((e) => e.id));
const references = (event, id, tags) =>
  event.tags.some((t) => tags.includes(t[0]) && t[1] === id);
const fixture = {
  corpusHash: createHash("sha256")
    .update(JSON.stringify(c.events.map(({ sig: _sig, ...event }) => event)))
    .digest("hex"),
  repositoryComments: c.events
    .filter(
      (e) =>
        e.kind === 1111 &&
        e.tags.some((t) => t[0] === "E" && rootIds.has(t[1])),
    )
    .map((e) => e.id),
  ...c,
  basePath:
    "/" +
    nip19.npubEncode(c.owner) +
    "/" +
    encodeURIComponent(c.coordinate.split(":").slice(2).join(":")),
  cases: roots.map((e) => ({
    id: e.id,
    kind: e.kind,
    title: e.tags.find((t) => t[0] === "subject")?.[1],
    suffix: (e.kind === 1621 ? "/issues/" : "/prs/") + e.id,
    updates: c.events
      .filter((child) => child.kind === 1619 && references(child, e.id, ["E"]))
      .map((child) => child.id),
    essentials: c.events
      .filter(
        (child) =>
          [1630, 1631, 1632, 1633, 1985, 5].includes(child.kind) &&
          references(child, e.id, ["e"]),
      )
      .map((child) => child.id),
    comments: c.events
      .filter(
        (child) =>
          child.kind === 1111 &&
          child.tags.some((t) => t[0] === "E" && t[1] === e.id),
      )
      .map((child) => child.id),
  })),
};
createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/fixture") return res.end(JSON.stringify(fixture));
  if (req.url === "/build-meta")
    return res.end(readFileSync("perf-reports/direct-entry/build-meta.json"));
  if (req.url === "/config")
    return res.end(readFileSync("perf-reports/direct-entry/config.json"));
  if (req.method === "POST" && /^\/report\/[\w-]+$/.test(req.url)) {
    let body = "";
    for await (const chunk of req) body += chunk;
    JSON.parse(body);
    writeFileSync(
      "perf-reports/direct-entry/" + req.url.slice(8) + ".json",
      body,
    );
    return res.end("{}");
  }
  res.writeHead(404);
  res.end("{}");
}).listen(4190, "127.0.0.1");
