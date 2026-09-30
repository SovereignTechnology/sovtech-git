import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TestApp } from "@/test/TestApp";
import { GitCommitLinkContext } from "@/components/CommitLinkContext";
import MarkdownContent from "./MarkdownContent";

const COMMIT = "a".repeat(40);
const BASE_PATH = "/npub1example/relay.example.com/gitworkshop";
const CLONE_URLS = ["https://relay.example.com/npub1example/gitworkshop.git"];

function renderMarkdown(content: string, filePath: string) {
  render(
    <TestApp>
      <GitCommitLinkContext.Provider
        value={{
          cloneUrls: CLONE_URLS,
          basePath: BASE_PATH,
          pool: null,
          privateRepository: false,
        }}
      >
        <MarkdownContent
          content={content}
          cloneUrls={CLONE_URLS}
          commitHash={COMMIT}
          filePath={filePath}
        />
      </GitCommitLinkContext.Provider>
    </TestApp>,
  );
}

describe("MarkdownContent relative links", () => {
  it("keeps a root README link inside the same repository and commit", () => {
    renderMarkdown("[ncontainer.md](ncontainer.md)", "README.md");

    expect(screen.getByRole("link", { name: "ncontainer.md" })).toHaveAttribute(
      "href",
      `${BASE_PATH}/tree/${COMMIT}/ncontainer.md`,
    );
  });

  it("resolves a relative link against the markdown file's directory", () => {
    renderMarkdown("[reference](./api/reference.md)", "docs/guide.md");

    expect(screen.getByRole("link", { name: "reference" })).toHaveAttribute(
      "href",
      `${BASE_PATH}/tree/${COMMIT}/docs/api/reference.md`,
    );
  });

  it("resolves a parent-directory link", () => {
    renderMarkdown("[readme](../README.md)", "docs/guide.md");

    expect(screen.getByRole("link", { name: "readme" })).toHaveAttribute(
      "href",
      `${BASE_PATH}/tree/${COMMIT}/README.md`,
    );
  });

  it("preserves a fragment on a relative link", () => {
    renderMarkdown("[install](docs/guide.md#install)", "README.md");

    expect(screen.getByRole("link", { name: "install" })).toHaveAttribute(
      "href",
      `${BASE_PATH}/tree/${COMMIT}/docs/guide.md#install`,
    );
  });

  it("leaves absolute and in-page links untouched", () => {
    renderMarkdown(
      "[site](https://example.com/page) and [top](#overview)",
      "README.md",
    );

    expect(screen.getByRole("link", { name: "site" })).toHaveAttribute(
      "href",
      "https://example.com/page",
    );
    expect(screen.getByRole("link", { name: "top" })).toHaveAttribute(
      "href",
      "#overview",
    );
  });
});
