export interface CommitCoAuthor {
  name: string;
  email?: string;
}

function parseIdentity(value: string): CommitCoAuthor | undefined {
  const match = /<([^<>]+)>$/.exec(value);
  if (!match) return value ? { name: value } : undefined;

  const email = match[1].trim();
  const name = value.slice(0, match.index).trim();
  return name && email ? { name, email } : { name: name || email || value };
}

const SCISSORS = "# ------------------------ >8 ------------------------";
const BLANK = /^[ \t\r]*$/;

/** Git's ignored_log_message_bytes() excludes a trailing run of comments,
 * empty lines and legacy conflict paths, or everything below scissors.
 * https://github.com/git/git/blob/v2.54.0/commit.c
 */
function logMessageEnd(lines: string[]): number {
  let end = 0;
  let inConflicts = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const terminated = i + 1 < lines.length;
    if (terminated && line === SCISSORS) break;
    if (terminated && line === "Conflicts:") {
      inConflicts = true;
      continue;
    }
    if (!line || line.startsWith("#") || (inConflicts && line.startsWith("\t")))
      continue;
    inConflicts = false;
    end = i + 1;
  }
  return end;
}

/**
 * Co-author extraction follows Git 2.54's default trailer rules for committed
 * messages (git interpret-trailers --parse --no-divider). See
 * find_trailer_block_start() for paragraph recognition and unfold_value()
 * for continuation lines. The browser uses the default separator and comment
 * prefix. Deduplication applies only to the separate list of co-authors.
 * https://github.com/git/git/blob/v2.54.0/trailer.c#L858-L1010
 */
export function parseCommitMessage(message: string) {
  const lines = message.split("\n");
  const subject = lines[0].replace(/\r$/, "");
  const coAuthors: CommitCoAuthor[] = [];
  let end = logMessageEnd(lines);
  while (
    end > 0 &&
    (BLANK.test(lines[end - 1]) || lines[end - 1].startsWith("#"))
  )
    end--;
  let start = end;
  while (start > 0 && !BLANK.test(lines[start - 1])) start--;

  if (start > 0) {
    let trailers = 0;
    let prose = 0;
    let hasGitTrailer = false;
    const seen = new Set<string>();

    for (let i = start; i < end; ) {
      const first = i;
      const line = lines[i++];
      if (line.startsWith("#")) continue;
      const cherryPick = line.startsWith("(cherry picked from commit ");
      if (line.startsWith("Signed-off-by: ") || cherryPick) {
        hasGitTrailer = true;
      }
      const match = /^([a-z\d-]+)[ \t]*:([\s\S]*)$/i.exec(line);
      if (!match && !cherryPick) {
        prose++;
        continue;
      }
      trailers++;
      while (i < end && /^[ \t\r]/.test(lines[i])) i++;
      if (match?.[1].toLowerCase() !== "co-authored-by") continue;
      const value = [match[2], ...lines.slice(first + 1, i)]
        .join("\n")
        .replace(/\n[ \t\r]*/g, " ")
        .replace(/^[ \t\r]+|[ \t\r]+$/g, "");
      const author = parseIdentity(value);
      if (!author) continue;
      const key = JSON.stringify([author.name, author.email?.toLowerCase()]);
      if (!seen.has(key)) {
        seen.add(key);
        coAuthors.push(author);
      }
    }

    // A mixed paragraph qualifies only with a Git-generated trailer and
    // at least one trailer for every three ordinary lines.
    if (prose && !(hasGitTrailer && trailers * 3 >= prose)) {
      coAuthors.length = 0;
    }
  }
  return {
    subject,
    body: lines.slice(1).join("\n").trim(),
    coAuthors,
  };
}
