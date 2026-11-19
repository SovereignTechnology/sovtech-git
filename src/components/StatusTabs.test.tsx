import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { TestApp } from "@/test/TestApp";
import { StatusTabs } from "./StatusTabs";

it("distinguishes unknown counts from a confirmed empty inventory", () => {
  const view = (pending: boolean, open: number) => (
    <TestApp>
      <StatusTabs
        counts={{ open, draft: 0, resolved: 0, closed: 0, deleted: 0 }}
        selected={["open"]}
        onChange={() => {}}
        pending={pending}
      />
    </TestApp>
  );
  const { rerender } = render(view(true, 0));
  expect(screen.getByRole("checkbox", { name: "Open" })).toBeVisible();
  expect(screen.queryByText("0")).not.toBeInTheDocument();
  expect(screen.getByRole("group")).toHaveAttribute("aria-busy", "true");
  rerender(view(false, 0));
  expect(screen.getByRole("checkbox", { name: "Open 0" })).toBeVisible();
  rerender(view(false, 28));
  expect(screen.getByRole("checkbox", { name: "Open 28" })).toBeVisible();
});
