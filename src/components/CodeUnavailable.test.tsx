import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UrlErrorKind, UrlState } from "@/lib/git-grasp-pool";
import type { ErrorRetryState } from "@/hooks/useErrorRetry";
import { CodeUnavailable } from "./CodeUnavailable";

const recovery: ErrorRetryState = {
  retry: () => {},
  retrying: false,
  secondsRemaining: null,
  automatic: false,
  exhausted: true,
  waiting: false,
  paused: false,
  pause: () => {},
};

function failed(url: string, kind: UrlErrorKind): UrlState {
  return {
    url,
    status: "permanent-failure",
    infoRefs: null,
    lastError: `Permanent HTTP error for ${url}`,
    lastErrorKind: kind,
  } as unknown as UrlState;
}

function renderWith(urls: Record<string, UrlState>) {
  render(
    <CodeUnavailable
      detail={{ kind: "no-servers" }}
      urls={urls}
      cloneUrls={Object.keys(urls)}
      recovery={recovery}
    />,
  );
}

describe("CodeUnavailable", () => {
  it("labels a server that answered 401/403 as asking for authorization, not as unreachable", () => {
    const url = "https://git.example/npub1owner/private-repo.git";
    renderWith({ [url]: failed(url, "unauthorized") });

    expect(screen.getByText("authorization required")).toBeInTheDocument();
    expect(screen.queryByText("connection error")).not.toBeInTheDocument();
    expect(screen.queryByText("could not connect")).not.toBeInTheDocument();
  });

  it("says the servers require authorization when every announced server answered 401/403", () => {
    const a = "https://git.example/npub1owner/private-repo.git";
    const b = "https://mirror.example/npub1owner/private-repo.git";
    renderWith({
      [a]: failed(a, "unauthorized"),
      [b]: failed(b, "unauthorized"),
    });

    expect(
      screen.getByText("The git server requires authorization"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No git server is serving this repository"),
    ).not.toBeInTheDocument();
  });

  it("keeps the generic headline when only some servers asked for authorization", () => {
    const a = "https://git.example/npub1owner/repo.git";
    const b = "https://down.example/npub1owner/repo.git";
    renderWith({
      [a]: failed(a, "unauthorized"),
      [b]: failed(b, "network"),
    });

    expect(
      screen.getByText("No git server is serving this repository"),
    ).toBeInTheDocument();
    expect(screen.getByText("connection error")).toBeInTheDocument();
    expect(screen.getByText("authorization required")).toBeInTheDocument();
  });
});
