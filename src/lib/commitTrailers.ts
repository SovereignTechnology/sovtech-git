/**
 * Co-authors named in a git commit message.
 *
 * Git credits co-authors with `Co-authored-by:` trailers, one `Name <email>`
 * per line, in the last paragraph of the message. Like the author and
 * committer, they are unverified claims.
 */

export interface CommitCoAuthor {
  name: string;
  email?: string;
}

const CO_AUTHOR_TRAILER = /^co-authored-by:(.*)$/i;
const NAME_AND_EMAIL = /^(.*?)\s*<([^<>]*)>$/;

function parseCoAuthorLine(line: string): CommitCoAuthor | undefined {
  const value = CO_AUTHOR_TRAILER.exec(line.trim())?.[1].trim();
  if (!value) return undefined;

  const match = NAME_AND_EMAIL.exec(value);
  const email = match?.[2].trim() || undefined;
  const name = (match ? match[1].trim() : value) || email;
  if (!name) return undefined;
  return email && email !== name ? { name, email } : { name };
}

/**
 * Split a full commit message into lines and find where its last paragraph
 * starts. A start of 0 means the message is only a subject paragraph, which
 * holds no trailers.
 */
function lastParagraph(message: string): { lines: string[]; start: number } {
  const lines = message.trimEnd().split(/\r?\n/);
  let start = lines.length;
  while (start > 0 && lines[start - 1].trim() !== "") start--;
  return { lines, start };
}

/**
 * Parse the `Co-authored-by:` trailers of a full commit message (subject
 * included). Only the last paragraph is read, as git does for trailers, so a
 * line quoting the convention earlier in the body is not taken as a co-author.
 * Repeated entries are returned once, in message order.
 */
export function parseCoAuthors(message: string): CommitCoAuthor[] {
  const { lines, start } = lastParagraph(message);
  if (start === 0) return [];

  const coAuthors: CommitCoAuthor[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(start)) {
    const coAuthor = parseCoAuthorLine(line);
    if (!coAuthor) continue;

    const key = `${coAuthor.name}\n${coAuthor.email?.toLowerCase() ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    coAuthors.push(coAuthor);
  }
  return coAuthors;
}

/**
 * The commit message without the `Co-authored-by:` trailers that end it, for
 * display next to a list of the co-authors. Only lines that
 * {@link parseCoAuthors} returns are removed, and only while they are the
 * last lines: co-author trailers followed by another trailer are kept, so the
 * remaining trailer block reads as it was written.
 */
export function withoutTrailingCoAuthors(message: string): string {
  const { lines, start } = lastParagraph(message);
  if (start === 0) return message;

  let end = lines.length;
  while (end > start && parseCoAuthorLine(lines[end - 1])) end--;
  if (end === lines.length) return message;
  return lines.slice(0, end).join("\n").trimEnd();
}
