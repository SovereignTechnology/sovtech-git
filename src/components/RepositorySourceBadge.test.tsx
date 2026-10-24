import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { relayEventPresence } from "@/lib/relayEventPresence";
import { RepositorySourceBadge } from "./RepositorySourceBadge";

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

function badge(id: string) {
  return (
    <TooltipProvider>
      <RepositorySourceBadge eventId={id} />
    </TooltipProvider>
  );
}

describe("repository source labels", () => {
  it("distinguishes unknown provenance and reacts to confirmation and completed withdrawal", () => {
    render(badge("source-label-transition"));
    expect(screen.getByText("Unconfirmed")).toBeInTheDocument();
    act(() =>
      relayEventPresence.observe(
        "source-label-transition",
        "wss://outbox.test",
      ),
    );
    expect(screen.getByText("Outbox only")).toBeInTheDocument();
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
