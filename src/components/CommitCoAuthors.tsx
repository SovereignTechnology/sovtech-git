/**
 * CommitCoAuthors — the co-authors cell of a commit header card, next to the
 * author and committer. parseCommitMessage in @/lib/commitTrailers supplies
 * the credits and documents the Git trailer rules used to extract them.
 */
import { Users } from "lucide-react";
import type { CommitCoAuthor } from "@/lib/commitTrailers";

interface CommitCoAuthorsProps {
  coAuthors: CommitCoAuthor[];
}

export function CommitCoAuthors({ coAuthors }: CommitCoAuthorsProps) {
  if (coAuthors.length === 0) return null;

  return (
    <div className="flex items-start gap-2">
      <Users className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">
          {coAuthors.length === 1 ? "Co-author" : "Co-authors"}
        </p>
        <ul className="space-y-1">
          {coAuthors.map(({ name, email }) => (
            <li key={`${name}\n${email ?? ""}`}>
              <p className="text-sm font-medium break-words">{name}</p>
              {email && (
                <p className="text-xs text-muted-foreground break-all">
                  {email}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
