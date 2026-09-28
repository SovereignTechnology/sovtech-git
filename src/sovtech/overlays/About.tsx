/**
 * SovTech Git's About page. It shadows src/pages/About.tsx through
 * ci/sovtech/shadow-map.tsv: honest lineage, the licence, the protocol in
 * brief and where feedback goes. Upstream's essay stays in upstream's source.
 *
 * The credit "by DanConwayDev" and UPSTREAM_REPO_PATH (Dan's npub) are the
 * attribution the brand ratchet lists as functional.
 */
import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useSeoMeta } from "@unhead/react";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/constants";
import { DOCUMENTATION_URLS } from "@/lib/documentation";
import {
  LICENSE_PATH,
  NIP34_URL,
  OTHER_CLIENTS,
  SOVTECH_GIT_ISSUES_PATH,
  SOVTECH_GIT_PATH,
  UPSTREAM_REPO_PATH,
} from "@/sovtech/links";

Reflect.set(globalThis, Symbol.for("sovtech.overlay.About"), true);

const DESCRIPTION =
  "SovTech Git is Sovereign Technology's fork of gitworkshop, a git-over-Nostr web client: lineage, licence and feedback.";

const PROSE = "prose prose-neutral dark:prose-invert max-w-none mt-4";
const H2 = "scroll-mt-20 font-mono text-2xl font-bold tracking-tight mt-12";
const LINK =
  "rounded-sm text-brand underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Nothing before the first name, " and " before the last, else ", ". */
function separator(index: number, count: number): string {
  if (index === 0) return "";
  return index === count - 1 ? " and " : ", ";
}

/**
 * Other clients: in-app paths as router links, full URLs as plain links. A
 * "//" prefix is a host, not a path.
 */
function ClientLink({ name, href }: { name: string; href: string }) {
  if (href.startsWith("/") && !href.startsWith("//")) {
    return (
      <Link to={href} className={LINK}>
        {name}
      </Link>
    );
  }
  return (
    <a href={href} className={LINK}>
      {name}
    </a>
  );
}

export default function About() {
  const { hash } = useLocation();

  useSeoMeta({
    title: `About — ${APP_NAME}`,
    description: DESCRIPTION,
    ogImage: "/og-image.png",
    ogImageWidth: 1200,
    ogImageHeight: 630,
    twitterCard: "summary_large_image",
  });

  // ScrollToTop leaves anchors to the page; the sections render with it.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  return (
    <div className="container max-w-screen-md px-4 md:px-8 py-16">
      <h1 className="font-mono text-3xl md:text-4xl font-bold tracking-tight">
        About SovTech Git
      </h1>
      <div className={PROSE}>
        <p className="lead">
          {
            "SovTech Git is Sovereign Technology's build of gitworkshop, the git-over-Nostr web client by DanConwayDev."
          }
        </p>
      </div>

      <h2 id="lineage" className={H2}>
        Lineage
      </h2>
      <div className={PROSE}>
        <p>
          {"It is a fork of "}
          <Link to={UPSTREAM_REPO_PATH} className={LINK}>
            gitworkshop
          </Link>
          {
            " that tracks upstream, with a weekly drift check. Every feature (repositories, issues, patches, pull requests, notifications) is upstream's, and "
          }
          <a href={DOCUMENTATION_URLS.gitworkshop} className={LINK}>
            its documentation
          </a>
          {
            " describes them. We change the look, this shell (header, footer, landing, about, 404 and the preview image) and the default relays and GRASP servers, which you can change in "
          }
          <Link to="/settings" className={LINK}>
            Settings
          </Link>
          {"."}
        </p>
      </div>

      <h2 id="licence" className={H2}>
        Licence
      </h2>
      <div className={PROSE}>
        <p>
          {
            "Upstream's code is MIT licensed and its copyright notice is kept in full. SovTech's changes are MIT licensed too. "
          }
          <a href={LICENSE_PATH} className={LINK}>
            Read the licence
          </a>
        </p>
      </div>

      <h2 id="protocol" className={H2}>
        The protocol
      </h2>
      <div className={PROSE}>
        <p>
          {"SovTech Git is built on "}
          <a href={NIP34_URL} className={LINK}>
            NIP-34
          </a>
          {", git collaboration over Nostr, and "}
          <a href={DOCUMENTATION_URLS.grasp} className={LINK}>
            GRASP
          </a>
          {", the git servers that hold the repositories. "}
          <a href={DOCUMENTATION_URLS.home} className={LINK}>
            ngit
          </a>
          {" publishes and clones them from the command line, and "}
          <a href={DOCUMENTATION_URLS.selfHostGrasp} className={LINK}>
            ngit-grasp
          </a>
          {" is a GRASP server you can run yourself. Other clients include "}
          {OTHER_CLIENTS.map((client, index) => (
            <span key={client.name}>
              {separator(index, OTHER_CLIENTS.length)}
              <ClientLink name={client.name} href={client.href} />
            </span>
          ))}
          {"."}
        </p>
      </div>

      <section
        aria-labelledby="feedback"
        className="mt-12 rounded-lg border border-border bg-muted/40 p-6"
      >
        <h2
          id="feedback"
          className="scroll-mt-20 font-mono text-xl font-bold tracking-tight"
        >
          Feedback
        </h2>
        <p className="mt-2 text-muted-foreground">
          {
            "Found a bug, or something we changed that you don't like? Open an issue on the SovTech Git repository over Nostr."
          }
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button asChild>
            <Link to={SOVTECH_GIT_ISSUES_PATH}>Open an issue</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to={SOVTECH_GIT_PATH}>Browse the source</Link>
          </Button>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          {"For bugs in upstream features, "}
          <Link to={UPSTREAM_REPO_PATH} className={LINK}>
            the upstream repository
          </Link>
          {" is the better place."}
        </p>
      </section>
    </div>
  );
}
