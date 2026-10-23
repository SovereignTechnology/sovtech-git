// Local, synthetic benchmark fixtures and JSON artifact receiver. Never publishes.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
const out = resolve("perf-reports/pagination-performance");
mkdirSync(out, { recursive: true });
// Publicly known fixture keys, exclusively for local replay. Not user credentials.
const key = (n) =>
  Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
const owner = getPublicKey(key(1)),
  user = getPublicKey(key(2));
const now = 1790000000,
  relay = "wss://fixture.invalid";
const events = [];
function add(kind, tags, content, time, signer = 1) {
  const event = finalizeEvent(
    { kind, tags, content, created_at: time },
    key(signer),
  );
  events.push(event);
  return event;
}
add(0, [], JSON.stringify({ name: "Fixture Maintainer" }), now - 10000);
add(0, [], JSON.stringify({ name: "Fixture Reader" }), now - 10000, 2);
add(10002, [["r", relay]], "", now - 10000);
add(10002, [["r", relay]], "", now - 10000, 2);
for (let i = 0; i < 60; i++)
  add(
    30617,
    [
      ["d", `perf-${String(i).padStart(3, "0")}`],
      ["name", `Performance fixture ${i}`],
      ["description", "Deterministic pagination benchmark repository"],
      ["maintainers", owner],
      ["relays", relay],
    ],
    "",
    now - 9000 - i,
  );
const coordinate = `30617:${owner}:perf-000`;
for (let i = 0; i < 60; i++) {
  const root = add(
    1621,
    [
      ["a", coordinate],
      ["p", owner],
      ["subject", `Fixture issue ${i}`],
    ],
    "Controlled benchmark issue body. ".repeat(8),
    now - 8000 - i * 100,
    2,
  );
  for (let j = 0; j < 10; j++)
    add(
      1111,
      [
        ["E", root.id],
        ["P", user],
        ["K", "1621"],
        ["e", root.id],
        ["p", user],
        ["k", "1621"],
      ],
      `Fixture comment ${i}/${j}. ` + "Payload ".repeat(60),
      root.created_at + j + 1,
    );
}
events.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
let fixture = {
  owner,
  user,
  events,
  repoPath: `/${nip19.npubEncode(owner)}/perf-000/issues`,
  expected: { roots: 60, comments: 600, repositories: 60 },
  defaultRelays: [relay],
};
if (process.env.BENCH_CORPUS) {
  const corpus = JSON.parse(gunzipSync(readFileSync(process.env.BENCH_CORPUS)));
  fixture = {
    owner: corpus.owner,
    user: corpus.owner,
    events: corpus.events,
    repoPath: `/${nip19.npubEncode(corpus.owner)}/gitworkshop/issues`,
    expected: { snapshotEvents: corpus.events.length },
    defaultRelays: [relay],
  };
}
writeFileSync(`${out}/fixture.json`, JSON.stringify(fixture));
createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/fixture") {
    res.end(JSON.stringify(fixture));
    return;
  }
  if (req.url === "/config") {
    res.end(readFileSync(`${out}/browser-config.json`));
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/report/")) {
    const name = req.url.slice(8);
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      res.writeHead(400);
      res.end("{}");
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    JSON.parse(body);
    writeFileSync(`${out}/${name}.json`, body);
    res.end('{"saved":true}');
    return;
  }
  res.writeHead(404);
  res.end("{}");
}).listen(4190, "127.0.0.1");
