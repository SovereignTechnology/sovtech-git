// Public fixture keys only. All events stay inside the intercepted local replay.
import { finalizeEvent, getPublicKey } from "nostr-tools";

export function createJourneyFixture({ outbox = false } = {}) {
  const key = new Uint8Array(32);
  key[31] = 1;
  const owner = getPublicKey(key);
  const coordinate = `30617:${owner}:journey-fixture`;
  const relay = "wss://fixture.invalid";
  const events = [];
  let time = 1790000000;
  const add = (kind, tags, content = "") => {
    const event = finalizeEvent(
      { kind, tags, content, created_at: time++ },
      key,
    );
    events.push(event);
    return event;
  };
  add(0, [], JSON.stringify({ name: "Journey maintainer" }));
  add(10002, [["r", outbox ? "wss://outbox.fixture.test" : relay]]);
  add(30617, [
    ["d", "journey-fixture"],
    ["name", "Journey fixture"],
    ["maintainers", owner],
    ["relays", relay],
  ]);
  const initial = { prs: [], issues: [] };
  let selected;
  for (const [kind, name] of [
    [1618, "prs"],
    [1621, "issues"],
  ]) {
    for (let i = 0; i < 12; i++) {
      const title = `Journey ${name} ${i}`;
      const root = add(
        kind,
        [
          ["a", coordinate],
          ["subject", title],
          ...(kind === 1618 ? [["c", "1".repeat(40)]] : []),
        ],
        `Body for ${title}.`,
      );
      const status = i % 2 ? "closed" : "open";
      if (status === "closed")
        add(1632, [
          ["e", root.id, "", "root"],
          ["a", coordinate],
        ]);
      initial[name].push({ id: root.id, title, status });
      for (let j = 0; j < 6; j++)
        add(
          1111,
          [
            ["E", root.id],
            ["K", String(kind)],
            ["P", owner],
            ["e", root.id],
            ["k", String(kind)],
            ["p", owner],
          ],
          `Comment ${j} on ${title}. ` + "Replay payload. ".repeat(20),
        );
      if (kind === 1618 && i === 0) selected = root;
    }
  }
  const renamed = "Journey PR renamed";
  add(1985, [
    ["e", selected.id],
    ["L", "#subject"],
    ["l", renamed, "#subject"],
  ]);
  add(
    1619,
    [
      ["E", selected.id],
      ["c", "2".repeat(40)],
    ],
    "Updated revision",
  );
  const cover = add(
    1624,
    [
      ["e", selected.id, "", "root"],
      ["p", owner],
      ["k", "1618"],
    ],
    "Review this cover note before the discussion.",
  );
  initial.prs[0].title = renamed;
  // Exercise deletion-of-essential coverage without deleting the root.
  const withdrawn = add(1632, [
    ["e", selected.id, "", "root"],
    ["a", coordinate],
  ]);
  add(5, [
    ["e", withdrawn.id],
    ["k", "1632"],
  ]);
  const detail = {
    id: selected.id,
    title: renamed,
    status: "open",
    tip: "2".repeat(40),
    cover: cover.id,
    body: selected.content,
    coverText: cover.content,
  };
  const beforeUpdates = events.length;
  const updated = structuredClone(initial);
  add(1632, [
    ["e", selected.id, "", "root"],
    ["a", coordinate],
  ]);
  updated.prs[0].status = "closed";
  add(1630, [
    ["e", initial.prs[1].id, "", "root"],
    ["a", coordinate],
  ]);
  updated.prs[1].status = "open";
  const newest = add(
    1621,
    [
      ["a", coordinate],
      ["subject", "Newest journey issue"],
    ],
    "New work on return.",
  );
  updated.issues.push({
    id: newest.id,
    title: "Newest journey issue",
    status: "open",
  });
  return {
    owner,
    coordinate,
    events,
    journey: {
      itemId: selected.id,
      updateIds: events.slice(beforeUpdates).map((e) => e.id),
      // Independently authored expected states, not computed by application models.
      initial: { ...initial, detail },
      updated: { ...updated, detail: { ...detail, status: "closed" } },
      newestId: newest.id,
    },
  };
}
