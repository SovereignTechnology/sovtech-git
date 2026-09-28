/**
 * SovTech Git's 404. It shadows src/pages/NotFound.tsx through
 * ci/sovtech/shadow-map.tsv. NIP19Page, CICoordinatorPage, CIProviderPage,
 * RelayPage and RepoCoordinatorsPage also render it for bad identifiers, so
 * the copy stays generic.
 */
import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useSeoMeta } from "@unhead/react";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/constants";

Reflect.set(globalThis, Symbol.for("sovtech.overlay.NotFound"), true);

/** How much of the path the terminal box shows. */
const MAX_PATH = 80;

/** A search for the path's last segment, decoded once. */
function searchPath(pathname: string): string {
  const segment = pathname.split("/").filter(Boolean).at(-1);
  if (!segment) return "/search";
  let query = segment;
  try {
    query = decodeURIComponent(segment);
  } catch {
    // A malformed escape: search for the segment as it is.
  }
  return `/search?q=${encodeURIComponent(query)}`;
}

export default function NotFound() {
  const location = useLocation();

  useSeoMeta({
    title: `Page not found — ${APP_NAME}`,
    description:
      "The page you are looking for could not be found. Return to the home page to continue browsing.",
    robots: "noindex",
  });

  useEffect(() => {
    console.error(
      "404 Error: User attempted to access non-existent route:",
      location.pathname,
    );
  }, [location.pathname]);

  const path = location.pathname.slice(0, MAX_PATH);

  return (
    <div className="container max-w-screen-md px-4 md:px-8 py-24 text-center">
      <p aria-hidden="true" className="font-mono text-6xl font-bold text-brand">
        404
      </p>
      <h1 className="mt-4 font-mono text-2xl font-bold tracking-tight">
        Nothing lives at this path
      </h1>

      <div className="mt-8 rounded-md bg-muted px-4 py-3 text-left font-mono text-sm">
        <p className="truncate">{`$ git checkout ${path}`}</p>
        <p className="truncate text-muted-foreground">
          {`error: pathspec '${path}' did not match any file(s) known to git`}
        </p>
      </div>

      <p className="mt-8 text-muted-foreground">
        {
          "The link may be mistyped, or what it points to has not reached the relays we asked yet."
        }
      </p>

      <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
        <Button asChild>
          <Link to="/">Go home</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to={searchPath(location.pathname)}>Search repositories</Link>
        </Button>
      </div>
    </div>
  );
}
