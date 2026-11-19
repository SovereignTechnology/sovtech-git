// Compare the actual list models and populated-store queries with a fixed public snapshot.
// node --expose-gc benchmarks/repository-models.mjs <v6-root> <v7-root> <patched-root>
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
if (!process.env.BENCH_CORPUS)
  throw new Error(
    "Set BENCH_CORPUS to a captured repository snapshot (.json.gz)",
  );
const fixture = resolve(process.env.BENCH_CORPUS);
const worker = `
import { EventStore } from 'applesauce-core';
import { fakeVerifyEvent } from 'applesauce-core/helpers';
import { firstValueFrom, take, timeout, combineLatest, ReplaySubject, filter } from 'rxjs';
import { IssueListModel } from './src/models/IssueListModel';
import { PRListModel } from './src/models/PRListModel';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const corpus = JSON.parse(gunzipSync(readFileSync(process.argv[2])));
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const rows = [], filters = new Map();
const store = new EventStore(); store.verifyEvent = fakeVerifyEvent;
for (const event of corpus.events) store.add(event);
const original = store.getByFilters.bind(store);
store.getByFilters = (...args) => { for(const f of [args[0]].flat()) filters.set(JSON.stringify(f),f); return original(...args); };
for (let repeat=0; repeat<12; repeat++) {
  global.gc?.(); const before = process.cpuUsage(); const start = performance.now();
  const outputs = await Promise.all([IssueListModel,PRListModel].map(model => firstValueFrom(model(corpus.coordinate)(store).pipe(take(1),timeout(5000)))));
  const cpu = process.cpuUsage(before);
  rows.push({scenario:'list-models',repeat,ms:performance.now()-start,cpuMs:(cpu.user+cpu.system)/1000,counts:outputs.map(x=>x.length),hash:digest(outputs.map(items=>items.map(({id,status,commentCount,currentSubject,lastActivityAt,labels})=>({id,status,commentCount,currentSubject,lastActivityAt,labels})).sort((a,b)=>a.id.localeCompare(b.id))))});
}
// These are the filter shapes actually opened by the list models, not an invented width.
const actualFilters = [...filters.values()];
const roots=corpus.events.filter(e=>[1617,1618,1621].includes(e.kind)).map(e=>e.id);
const cases=[...actualFilters.map((f,i)=>({name:'model-filter-'+i,f})),{name:'all-root-comments',f:{kinds:[1111], '#E':roots}},{name:'all-root-essentials',f:{kinds:[1621,1622,1623,1624,1985,5], '#e':roots}},{name:'limited-comments',f:{kinds:[1111], '#E':roots,limit:20}}];
for(let repeat=0;repeat<12;repeat++) for(const {name,f} of cases){
  global.gc?.(); const before=process.cpuUsage(),start=performance.now(); let result;
  for(let i=0;i<100;i++) result=original(f);
  const cpu=process.cpuUsage(before);
  rows.push({scenario:name,repeat,ms:performance.now()-start,cpuMs:(cpu.user+cpu.system)/1000,count:result.length,hash:digest(result.map(e=>e.id).sort())});
  if(store.getSyncPairs){ const start=performance.now();let pairs;for(let i=0;i<100;i++)pairs=store.getSyncPairs(f);rows.push({scenario:'sync-'+name,repeat,ms:performance.now()-start,count:pairs.length,hash:digest(pairs.map(e=>e.id).sort())}); }
}
store.dispose();
if(process.env.BENCH_STREAMING === '1') for(let repeat=0;repeat<12;repeat++) {
 const live = new EventStore(); live.verifyEvent=fakeVerifyEvent;
 const seed=e=>[1617,1618,1621,30617].includes(e.kind);
 for(const event of corpus.events.filter(seed)) live.add(event);
 const output=new ReplaySubject(1);let emissions=0,last;
 const project=outputs=>outputs.map(items=>items.map(({id,status,commentCount,currentSubject,lastActivityAt,labels})=>({id,status,commentCount,currentSubject,lastActivityAt,labels})).sort((a,b)=>a.id.localeCompare(b.id)));
 const sub=combineLatest([IssueListModel(corpus.coordinate),PRListModel(corpus.coordinate)].map(model=>model(live))).subscribe(value=>{emissions++;last=value;output.next(value);});
 await firstValueFrom(output.pipe(take(1),timeout(5000)));
 const target=rows.find(r=>r.scenario==='list-models').hash;
 global.gc?.();const before=process.cpuUsage(),start=performance.now();
 for(const event of corpus.events.filter(e=>!seed(e)))live.add(event);
 const insertMs=performance.now()-start;
 // Validate after ingestion so repeated hashing is not charged as model work.
 const settled=firstValueFrom(output.pipe(filter(value=>digest(project(value))===target),take(1),timeout(20000)));
 await settled;const cpu=process.cpuUsage(before);
 rows.push({scenario:'streaming-models',repeat,ms:performance.now()-start,insertMs,cpuMs:(cpu.user+cpu.system)/1000,emissions,counts:last.map(x=>x.length),hash:digest(project(last))});
 sub.unsubscribe();output.complete();live.dispose();
}
console.log(JSON.stringify({rows,filters:cases}));
`;
const report = {
  created: new Date().toISOString(),
  streaming: process.env.BENCH_STREAMING === "1",
  fixtureSha256: createHash("sha256")
    .update(readFileSync(fixture))
    .digest("hex"),
  limitations:
    "Fixed public snapshot, not global relay completeness. Node CPU and elapsed time; signatures preverified during capture, verification excluded here. Model elapsed includes its 100ms audit. Twelve repetitions; first included. Streaming mode seeds roots and measures insertion with live models, then waits for the full resolved snapshot. Final hashing runs after ingestion. Elapsed includes scheduler delays. No browser or network claims.",
  variants: [],
};
for (const input of process.argv.slice(2)) {
  const root = resolve(input),
    require = createRequire(join(root, "package.json"));
  const esbuild = createRequire(require.resolve("vite"))("esbuild");
  const out = join(root, "perf-reports/repository-models-worker.mjs");
  mkdirSync(join(root, "perf-reports"), { recursive: true });
  await esbuild.build({
    stdin: {
      contents: worker,
      resolveDir: root,
      sourcefile: "repository-models-worker.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: out,
    alias: { "@": join(root, "src") },
  });
  const p = spawnSync(process.execPath, ["--expose-gc", out, fixture], {
    encoding: "utf8",
    maxBuffer: 20e6,
  });
  if (p.status !== 0) throw new Error(p.stderr);
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const data = JSON.parse(p.stdout);
  report.variants.push({
    root,
    commit: git("rev-parse", "HEAD"),
    trackedDiffSha256: createHash("sha256")
      .update(git("diff", "HEAD", "--"))
      .digest("hex"),
    core: JSON.parse(
      readFileSync(join(root, "node_modules/applesauce-core/package.json")),
    ).version,
    ...data,
  });
}
for (const v of report.variants) {
  const groups = {};
  for (const row of v.rows) (groups[row.scenario] ??= []).push(row);
  v.summary = Object.fromEntries(
    Object.entries(groups).map(([key, rows]) => {
      const values = rows.map((r) => r.ms).sort((a, b) => a - b);
      return [
        key,
        {
          medianMs: (values[5] + values[6]) / 2,
          minMs: values[0],
          maxMs: values.at(-1),
          hashes: [...new Set(rows.map((r) => r.hash))],
          count: rows[0].count ?? rows[0].counts,
        },
      ];
    }),
  );
}
for (const scenario of Object.keys(report.variants[0].summary)) {
  if (scenario === "limited-comments") continue; // v6 ignores limit without a time bound.
  const hashes = report.variants.map((v) => v.summary[scenario].hashes);
  assert(
    hashes.every((h) => h.length === 1 && h[0] === hashes[0][0]),
    scenario,
  );
}
assert.deepEqual(
  report.variants[1].summary["limited-comments"].hashes,
  report.variants[2].summary["limited-comments"].hashes,
);
assert.equal(report.variants[2].summary["limited-comments"].count, 20);
writeFileSync(
  "perf-reports/repository-models.json",
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    report.variants.map(({ core, summary }) => ({ core, summary })),
    null,
    2,
  ),
);
