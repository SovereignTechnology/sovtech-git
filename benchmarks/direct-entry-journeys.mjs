// Serialised into browser-session's runner; keep this function self-contained.
export async function runJourney({
  page,
  config,
  fixture,
  selected,
  releaseUpdates,
  transportState,
}) {
  const phases = [];
  const interactions = [];
  const phaseMs = config.phaseMs ?? 6000;
  const expectations = fixture.journey;
  const now = () => page.evaluate(() => performance.now());
  const navigate = async (suffix) => {
    const start = await now();
    await page.evaluate(
      (path) => {
        history.pushState(null, "", path);
        window.dispatchEvent(new PopStateEvent("popstate"));
      },
      suffix.startsWith("/") && suffix === "/about"
        ? suffix
        : fixture.basePath + suffix,
    );
    return start;
  };
  const observeUntil = (end) =>
    page.waitForFunction((target) => performance.now() >= target, end, {
      timeout: phaseMs + 15000,
    });
  const phase = async (
    name,
    start,
    expected,
    listKind,
    requireDetail = false,
    duration = phaseMs,
  ) => {
    // Passage of time is the observation workload, not evidence of completion.
    await observeUntil(start + duration);
    const result = await page.evaluate(
      ({
        name,
        start,
        expected,
        listKind,
        requireDetail,
        selectedSuffix,
        newestId,
      }) => {
        const b = window.__detailBench;
        const end = performance.now();
        const canonical = (rows) =>
          rows &&
          JSON.stringify([...rows].sort((a, c) => a.id.localeCompare(c.id)));
        const equalRows = (a, c) => !!a && canonical(a) === canonical(c);
        const windowRows = (name) => {
          const all = b.transitions[name];
          const prior = all.findLast((r) => r.at <= start);
          return [
            ...(prior ? [{ ...prior, at: start }] : []),
            ...all.filter((r) => r.at > start && r.at <= end),
          ];
        };
        const convergence = (rows, matches) => {
          const lastWrong = rows.findLastIndex((row) => !matches(row.value));
          const correct = rows.filter((row) => matches(row.value));
          const complete = !!rows.length && matches(rows.at(-1).value);
          return {
            status: complete ? "complete" : "incomplete",
            firstCorrectMs: correct.length ? correct[0].at - start : null,
            correctThroughEndMs: complete
              ? rows[lastWrong + 1].at - start
              : null,
            final: rows.at(-1)?.value ?? null,
          };
        };
        const repoRows = windowRows("repository");
        const repository = convergence(
          repoRows,
          (v) =>
            v &&
            equalRows(v.prs, expected.prs) &&
            equalRows(v.issues, expected.issues),
        );
        const openMembership = convergence(
          repoRows,
          (v) =>
            v &&
            ["prs", "issues"].every((kind) =>
              equalRows(
                v[kind]?.filter((r) => r.status === "open"),
                expected[kind].filter((r) => r.status === "open"),
              ),
            ),
        );
        const detailRows = windowRows("detail").filter((r) =>
          r.path.endsWith(selectedSuffix),
        );
        function essentials(v) {
          return (
            !!v &&
            ["id", "title", "status", "tip"].every(
              (k) => v[k] === expected.detail[k],
            )
          );
        }
        const detail = requireDetail
          ? convergence(detailRows, essentials)
          : null;
        const essentialFields = requireDetail
          ? Object.fromEntries(
              ["title", "status", "tip"].map((key) => [
                key,
                convergence(
                  detailRows,
                  (v) =>
                    v?.id === expected.detail.id &&
                    v[key] === expected.detail[key],
                ),
              ]),
            )
          : null;
        const cover = requireDetail
          ? convergence(detailRows, (v) => v?.cover === expected.detail.cover)
          : null;
        const listRows = windowRows("list");
        const list = listKind
          ? convergence(
              listRows,
              (v) =>
                v?.kind === listKind &&
                equalRows(
                  v.rows,
                  expected[listKind].filter(
                    (r) =>
                      r.status === "open" ||
                      (listKind === "prs" && r.status === "draft"),
                  ),
                ),
            )
          : null;
        let removals = 0,
          additions = 0,
          reorderTransitions = 0;
        let previous;
        // These are DOM-order changes, not a claim about visible pixels/layout shift.
        for (const { value } of listRows) {
          if (value?.kind !== listKind) {
            previous = undefined;
            continue;
          }
          const ids = value.rows.map((r) => r.id);
          if (previous) {
            removals += previous.filter((id) => !ids.includes(id)).length;
            additions += ids.filter((id) => !previous.includes(id)).length;
            const oldCommon = previous.filter((id) => ids.includes(id));
            const newCommon = ids.filter((id) => previous.includes(id));
            if (JSON.stringify(oldCommon) !== JSON.stringify(newCommon))
              reorderTransitions++;
          }
          previous = ids;
        }
        const firstRows = listRows.find(
          (r) => r.value?.kind === listKind && r.value.rows.length > 0,
        );
        const newest = listRows.find((r) =>
          r.value?.rows.some((item) => item.id === newestId),
        );
        return {
          name,
          start,
          end,
          repository,
          openMembership,
          detail,
          essentialFields,
          cover,
          list,
          firstRowsMs: firstRows ? firstRows.at - start : null,
          newestIssueDOMMs: newest ? newest.at - start : null,
          churn: { additions, removals, reorderTransitions },
          requests: b.requests.filter((r) => r.at >= start && r.at <= end)
            .length,
          longTasks: b.longTasks.filter((t) => t.at >= start && t.at <= end),
        };
      },
      {
        name,
        start,
        expected,
        listKind,
        requireDetail,
        selectedSuffix: selected.suffix,
        newestId: expectations.newestId,
      },
    );
    result.transport = transportState();
    phases.push(result);
    return result;
  };
  const probe = async (kind) => {
    const input = page.getByPlaceholder(
      kind === "prs" ? /^Search PRs,/ : /^Search issues,/,
    );
    const start = await now();
    await input.fill("zzzxbenchmarknomatchzzz", { timeout: 10000 });
    await page
      .getByText(
        kind === "prs"
          ? "No PRs match your filters"
          : "No issues match your filters",
        { exact: true },
      )
      .waitFor({ timeout: 10000 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const end = await now();
    await input.fill("");
    await page
      .getByText(
        kind === "prs"
          ? "No PRs match your filters"
          : "No issues match your filters",
        { exact: true },
      )
      .waitFor({ state: "hidden", timeout: 10000 });
    interactions.push({
      action: `filter-${kind}`,
      start,
      ms: end - start,
      meaning:
        "Automation through empty-result DOM and two animation frames; not INP",
    });
  };
  try {
    if (config.journey === "cold") {
      // An explicit user action offset, independent of comment or count readiness.
      const navigateAt = config.navigateAtMs ?? 1200;
      await phase(
        "cold-detail",
        0,
        expectations.initial,
        null,
        true,
        navigateAt,
      );
      const at = await now();
      const before = await page.evaluate(() => ({
        received: window.__detailBench.events.size,
        repository:
          window.__detailBench.transitions.repository.at(-1)?.value ?? null,
        detail: window.__detailBench.transitions.detail.at(-1)?.value ?? null,
      }));
      const start = await now();
      await page.locator('nav a[href$="/prs"]').click({ timeout: 10000 });
      await page.getByPlaceholder(/^Search PRs,/).waitFor({ timeout: 10000 });
      interactions.push({
        action: "cold-detail-to-list",
        start,
        ms: (await now()) - start,
        before,
        scheduledAt: navigateAt,
        actualAt: at,
      });
      await probe("prs");
      // Exclude deliberate filtering from churn/convergence measurements.
      await phase("cold-list", await now(), expectations.initial, "prs");
      const back = await navigate(selected.suffix);
      await phase("warm-detail", back, expectations.initial, null, true);
    } else {
      const primed = await phase("prime", 0, expectations.initial, null, true);
      if (
        [primed.repository, primed.detail, primed.cover].some(
          (v) => v.status !== "complete",
        )
      )
        throw Error(
          "Initial fixture did not converge; return visit would not be a valid warm comparison",
        );
      await navigate("/about");
      await page.waitForFunction(
        () => !document.querySelector('nav a[href$="/prs"]'),
        null,
        { timeout: 10000 },
      );
      releaseUpdates();
      const returned = await navigate("/prs");
      await page.getByPlaceholder(/^Search PRs,/).waitFor({ timeout: 10000 });
      await phase("return-prs", returned, expectations.updated, "prs");
      const issues = await navigate("/issues");
      await page
        .getByPlaceholder(/^Search issues,/)
        .waitFor({ timeout: 10000 });
      await phase("return-issues", issues, expectations.updated, "issues");
      await probe("issues");
      const detail = await navigate(selected.suffix);
      await phase("updated-detail", detail, expectations.updated, null, true);
    }
    const failed = phases.filter(
      (p) =>
        p.name !== "cold-detail" &&
        [p.repository, p.openMembership, p.detail, p.cover, p.list].some(
          (v) => v && v.status !== "complete",
        ),
    );
    return {
      phases,
      interactions,
      failure: failed.length
        ? `Incomplete checkpoints: ${failed.map((p) => p.name).join(", ")}`
        : null,
    };
  } catch (error) {
    return { phases, interactions, failure: String(error) };
  }
}
