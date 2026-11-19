import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { relayEventPresence } from "@/lib/relayEventPresence";
import { RepositorySourceBadge } from "./RepositorySourceBadge";
import { RepositorySourceNotice } from "./RepositorySourceNotice";
import { TestApp } from "@/test/TestApp";

const state = vi.hoisted(() => ({
  repo: { isPrivate: false, relays: ["wss://repo.test"] },
  mode: "outbox",
}));
vi.mock("@/pages/repo/RepoContext", () => ({
  useOptionalRepoContext: () => ({ resolved: { repo: state.repo } }),
}));
vi.mock("@/hooks/useRepositoryCuration", () => ({
  useRepositoryCuration: () => ({ mode: state.mode }),
}));

beforeEach(() => {
  state.mode = "outbox";
  state.repo.isPrivate = false;
  state.repo.relays = ["wss://repo.test"];
});

function badge(id: string) {
  return (
    <TooltipProvider>
      <RepositorySourceBadge eventId={id} />
    </TooltipProvider>
  );
}

describe("repository source labels", () => {
  it("waits for completed repository absence instead of labelling early outbox receipt", () => {
    render(badge("source-label-transition"));
    expect(screen.queryByText("Unconfirmed")).not.toBeInTheDocument();
    act(() => relayEventPresence.acceptCached(["source-label-transition"]));
    expect(screen.queryByText("Cached")).not.toBeInTheDocument();
    act(() =>
      relayEventPresence.observe(
        "source-label-transition",
        "wss://outbox.test",
      ),
    );
    expect(screen.queryByText("Outbox only")).not.toBeInTheDocument();
    act(() =>
      relayEventPresence.observe("source-label-transition", "wss://repo.test"),
    );
    expect(screen.queryByText("Outbox only")).not.toBeInTheDocument();
    act(() =>
      relayEventPresence.reconcile(
        "wss://repo.test",
        ["source-label-transition"],
        new Set(),
        relayEventPresence.begin(),
      ),
    );
    expect(screen.getByText("Outbox only")).toBeInTheDocument();
  });

  it("stays quiet in curated and private repository views", () => {
    state.mode = "repo";
    const view = render(badge("source-label-hidden"));
    expect(view.container).toBeEmptyDOMElement();
    state.mode = "outbox";
    state.repo.isPrivate = true;
    view.rerender(badge("source-label-hidden"));
    expect(view.container).toBeEmptyDOMElement();
    state.repo.isPrivate = false;
  });
});

it("keeps the detail message and action absent until every repository relay confirms absence", () => {
  const id = "detail-confirmed-absence";
  state.mode = "repo";
  state.repo.relays = ["wss://repo.test", "wss://second.test"];
  const expand = vi.fn();
  const notice = () => (
    <TestApp>
      <RepositorySourceNotice eventId={id} onExpand={expand} />
    </TestApp>
  );
  const view = render(notice());
  expect(view.container).toBeEmptyDOMElement();
  act(() => {
    relayEventPresence.acceptCached([id]);
    relayEventPresence.observe(id, "wss://outbox.test");
    relayEventPresence.reconcile(
      "wss://repo.test",
      [id],
      new Set(),
      relayEventPresence.begin(),
    );
  });
  expect(view.container).toBeEmptyDOMElement();
  act(() =>
    relayEventPresence.reconcile(
      "wss://second.test",
      [id],
      new Set(),
      relayEventPresence.begin(),
    ),
  );
  expect(
    screen.getByText(
      "This item was found on other relays, but not on the repository relays.",
    ),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Include outbox relays" }),
  );
  expect(expand).toHaveBeenCalledTimes(1);
  state.mode = "outbox";
  view.rerender(<TestApp>{badge(id)}</TestApp>);
  expect(screen.getByText("Outbox only")).toBeVisible();
  act(() => relayEventPresence.observe(id, "wss://repo.test"));
  expect(screen.queryByText("Outbox only")).not.toBeInTheDocument();
  state.mode = "repo";
  view.rerender(notice());
  expect(view.container).toBeEmptyDOMElement();
});

it("withdraws the detail prompt when the relay scope expands and stays quiet for private repositories", () => {
  const id = "detail-relay-scope";
  state.mode = "repo";
  relayEventPresence.observe(id, "wss://outbox.test");
  relayEventPresence.reconcile(
    "wss://repo.test",
    [id],
    new Set(),
    relayEventPresence.begin(),
  );
  const notice = () => (
    <TestApp>
      <RepositorySourceNotice eventId={id} onExpand={() => {}} />
    </TestApp>
  );
  const view = render(notice());
  expect(
    screen.getByRole("button", { name: "Include outbox relays" }),
  ).toBeVisible();
  state.repo.relays = ["wss://repo.test", "wss://new.test"];
  view.rerender(notice());
  expect(view.container).toBeEmptyDOMElement();
  act(() =>
    relayEventPresence.reconcile(
      "wss://new.test",
      [id],
      new Set(),
      relayEventPresence.begin(),
    ),
  );
  expect(
    screen.getByRole("button", { name: "Include outbox relays" }),
  ).toBeVisible();
  state.repo.isPrivate = true;
  view.rerender(notice());
  expect(view.container).toBeEmptyDOMElement();
});
