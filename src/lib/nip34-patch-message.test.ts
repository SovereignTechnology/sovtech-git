import type { NostrEvent } from "nostr-tools";
import { describe, expect, it } from "vitest";
import {
  extractPatchBody,
  extractPatchMessage,
  extractPatchSubject,
} from "@/lib/nip34";

const subject = "Keep the commit message";
const credit = "Co-authored-by: Jo <jo@example.org>";
const headers =
  "From: Author <author@example.org>\nSubject: [PATCH] " + subject;
const notesMail =
  headers +
  "\n\nBody\n\n" +
  credit +
  "\n---\n\nNotes:\n    reviewer note\n\n file | 1 +\ndiff --git a/file b/file\n";

describe("plain-text format-patch message boundaries (Git 2.54 mailinfo)", () => {
  it("keeps the credit before the divider and excludes format-patch --notes", () => {
    expect(extractPatchMessage(notesMail)).toBe(
      subject + "\n\nBody\n\n" + credit,
    );
  });

  it.each(["---", "--- \t", "--- a/file", "Index: file", "diff --cc file"])(
    "stops at %j even without a diffstat",
    (marker) => {
      const mail = [headers, "", "Body", marker, credit, ""].join("\n");
      expect(extractPatchMessage(mail)).toBe(subject + "\n\nBody");
    },
  );

  it("keeps diffstat-like prose, quoted separators, and ordinary hyphens", () => {
    const body =
      "Discuss the output:\n file | 2 ++\n ---\n----\n---  two spaces\n" +
      credit;
    expect(extractPatchMessage(headers + "\n\n" + body + "\n---\n")).toBe(
      subject + "\n\n" + body,
    );
  });

  it("unfolds the subject and excludes subsequent mail headers", () => {
    const mail =
      "Subject: [PATCH 1/2] Folded\r\n title\r\nX-Mailer: git\r\n\r\nBody\r\n---\r\n";
    expect(extractPatchMessage(mail)).toBe("Folded title\n\nBody");
  });

  it("uses the mail fallback only when the description lacks a body", () => {
    const event: NostrEvent = {
      kind: 1617,
      pubkey: "a".repeat(64),
      id: "b".repeat(64),
      sig: "c".repeat(128),
      created_at: 1,
      content: notesMail,
      tags: [["description", subject]],
    };
    expect(extractPatchSubject(event)).toBe(subject);
    expect(extractPatchBody(event)).toBe("Body\n\n" + credit);
    event.tags = [["description", subject + "\n\nBody\n---\n" + credit]];
    expect(extractPatchBody(event)).toBe("Body\n---\n" + credit);
  });
});
