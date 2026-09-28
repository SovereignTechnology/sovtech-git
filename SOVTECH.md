# SovTech Git

SovTech Git is Sovereign Technology's build of
[GitWorkshop](https://gitworkshop.dev), the NIP-34 git-over-Nostr web client
by DanConwayDev. It is served at <https://git.sovtech.pro> and
<https://git.sovit.xyz>.

The fork re-brands the app (theme, header, footer, landing, about, 404, OG
image) and points its defaults at SovTech infrastructure, while leaving
upstream features untouched. The whole design exists to keep upstream merges
cheap.

## Lineage and licence

- Upstream: `nostr://npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/relay.ngit.dev/gitworkshop`.
  The GitHub copy (`DanConwayDev/gitworkshop`) is a stale mirror: never sync
  from it.
- Upstream is MIT (`LICENSE.md`, copyright DanConwayDev). That notice stays.
  SovTech's own changes are also MIT; see `NOTICE.md`.
- The fork base is recorded in `ci/sovtech/UPSTREAM_BASE`.

## Repositories and remotes

- `origin`: GitLab `sovtech/git` (private, canonical). All work lands here
  through MRs.
- GitHub `SovereignTechnology/sovtech-git`: a public, read-only push mirror of
  GitLab `main` and `sovtech-v*` tags.
- `nostr`: the NIP-34 announcement `sovtech-git` under the SovTech npub, a
  subordinate fork of upstream.
- `upstream`: Dan's repository, fetched over `nostr://`, never pushed to.
- `offbox`: the bare backup on ubuntu-server.

## How the overlay works

- New code lives in `src/sovtech/**` and `ci/sovtech/**`.
- Upstream files are touched only at small, cold seams, each listed with a line
  budget in `ci/sovtech/touched-upstream.txt`.
- Shell components are swapped in at build time by a Vite plugin
  (`src/sovtech/vite-plugin.ts`) that shadows upstream modules. Each shadowed
  file's upstream blob is recorded in `ci/sovtech/shadow-map.tsv`, so the sync
  shows exactly what upstream changed there.
- Branding copy in files we must not edit is rewritten at build time by rules
  that must match at least once, and the build fails if upstream branding
  survives in `dist`.

The six shell overlays (header, footer, landing, About, 404 and the OG
image page) live in `src/sovtech/overlays/`, built to the shell spec below.

## Theme and brand assets

- `src/sovtech/theme.css` redefines every palette variable of upstream's
  `src/index.css`, in light and dark, and adds the brand scale `--brand-50`
  to `--brand-950` plus `--brand-foreground`. `src/main.tsx` imports it after
  upstream's CSS, so it wins. The scale is darker in light mode, where
  `pink-500` and `pink-600` are text on white, and centred on `#F7931A` in
  dark mode. The gate fails when upstream changes its palette (the sha256
  in `ci/sovtech/upstream-palette.sha256`) and when theme.css stops being the
  last palette in the built CSS (the theme order check below);
  `src/sovtech/theme.test.ts` fails when the variable set or the import
  order changes. theme.css also carries the `prefers-reduced-motion` guard
  (animations and transitions finish in 0.01ms, no smooth scrolling).
- `src/sovtech/tailwind-brand.ts` points Tailwind's `pink-*` at the brand
  scale, maps `amber-*` to yellow and sets the fonts: Inter Variable for
  text, the system mono stack for headings. `tailwind.config.ts` spreads it
  into `theme.extend`. `rose` is left alone, and the pink label colour
  bucket is fuchsia. The same scale is `brand-*` for fork code, with
  `brand` itself at step 500 (`text-brand`, `border-brand/30`).
- Dark is the default (`public/theme-init.js`, `src/services/settings.ts`):
  a missing `theme` key means dark, and an explicit light or system choice
  is stored and honoured.
- The mark is `src/sovtech/brand/mark.svg`: the chevron-B from
  www.sovtech.pro, `#F7931A` on transparent, with its viewBox centred on the
  ink. `ci/sovtech/gen-brand-assets.py` builds `mark-on-dark.svg` (the mark
  on a `#0A0A0A` tile) and every icon upstream ships in `public/`, under the
  same names and sizes, plus `public/icon.png` (the NIP-11 icon). Maskable
  icons keep the mark inside the central 80% (the script checks every pixel
  outside it), and the apple-touch and maskable icons are opaque. The mark
  is inlined into same-origin SVG files, so the script accepts only plain
  shape elements and presentation attributes in it: no script, handler,
  link, style, entity or comment.
- Regenerate them on the laptop only, with
  `python3 -I ci/sovtech/gen-brand-assets.py`. It rasterises with headless
  Chromium in a throwaway profile and needs nothing but the Python standard
  library. Commit the outputs together with the blob ids it prints for
  `ci/sovtech/asset-swaps.tsv`. The gate runs its `--check` mode, which needs
  no Chromium (see the gate checks below).
- `public/.well-known/nostr.json` names only `sovtech` (the SovTech npub),
  and `public/LICENSE.txt` carries upstream's MIT notice and SovTech's line.

## Shell spec

The six shadowed shell modules, their shared parts and the tokens they use.
Cameron signed the draft off on 2026-09-27 with four decisions, applied
below: the taglines, two repository strips, the footer's legal line and
claims cut down to exact facts. Every other open decision took its default.

### Ground rules

- Files: `src/sovtech/overlays/{AppHeader,AppFooter,LandingPage,About,NotFound,OgImagePreview}.tsx`, plus `src/sovtech/brand/BrandMark.tsx` (a TSX port of sovtech.pro's `BrandMark.jsx`: same paths and viewBox, `stroke="currentColor"`, `aria-hidden`, `focusable="false"`) and `src/sovtech/links.ts` (every fork URL and route, in one place).
- Export shapes match upstream, enforced by tsc in `src/sovtech/contract.ts`: `AppHeader`, `AppFooter` and `LandingPage` are named exports; `About`, `NotFound` and `OgImagePreview` are default exports. None takes props.
- Each overlay sets its sentinel at module scope: `Reflect.set(globalThis, Symbol.for("sovtech.overlay.<Name>"), true)`.
- Each shadow-map marker is a string unique to the upstream file, and the overlay must not contain it:
  - AppHeader: `group transition-opacity hover:opacity-80 shrink-0`
  - AppFooter: `Git collaboration, without the platform.`
  - LandingPage: `hero-fork-gradient`
  - About: `please provide feedback`
  - NotFound: `Oops! Page not found`
  - OgImagePreview: `og-option-5`
- Upstream parts that are not exported (`HeaderSearchBar`, `HeaderSearchIcon`, `FeaturedRepoCard`, `FeaturedReposSkeleton` and the `FeaturedRepos` logic) are copied with their logic unchanged; only classes and copy change, and the skeleton takes a card count. Each copy has a one-line comment naming its source file. The shadow row's drift report covers them.
- `src/sovtech/__tests__/shell.test.ts` checks the rows (acked blobs, sentinels, markers found in their upstream file only) and the header and footer parity: every link target and imported JSX component of the acked upstream file appears in the overlay, or in `src/sovtech/overlays/parity-waivers.tsv` with a reason. A waiver that waives nothing fails too.
- Links to the app itself are relative (`/about`, `/search`). git.sovtech.pro and git.sovit.xyz share one web root, so no link names a host.
- Overlays use semantic colour classes only: `bg-primary`, `text-primary-foreground`, `text-brand`, `border-brand/30`, `bg-brand/10`, `ring-ring`, `text-muted-foreground`.
  - Never a literal `pink-*`, `rose-*`, `gray-*` or `blue-*` class, and never a hex value. The OG page is the one exception: it uses fixed hex and ignores the theme.
  - `brand` is an alias for the remapped scale, with a DEFAULT at step 500, exported by `src/sovtech/tailwind-brand.ts`. That file is fork-owned, so it costs no seam lines.
- Things the shell never uses:
  - new dependencies, framer-motion or JS animation;
  - `dangerouslySetInnerHTML`, `innerHTML`, `eval` or an inline `<script>`;
  - external images or fonts.
- The CSP meta stays byte-identical to upstream. It allows inline `style` attributes, and only the OG page uses them.
- Event-derived text (repo names and descriptions, profile names, the 404 path) renders only as React text. It never reaches an `href`, `src` or `style`.
- Every `href` is a constant, an upstream helper (`useDefaultRepoPath`), or built with `encodeURIComponent`.
- External links open in the same tab, as upstream's do. Any future `target="_blank"` needs `rel="noopener noreferrer"`.
- Brand residue in overlays is limited to the attribution on About (see "Ratchet and gate impact").
  - Dan's key appears only as a literal npub, never assembled at runtime, so the ratchet counts it.
  - Brand strings are never split or encoded to get past the ratchet.

### Claims

Copy states what is true today, and nothing more. Cameron chose "soften to exact facts" on 2026-09-27:

- Hardware: "Served from our own hardware in El Salvador", never "run from El Salvador on hardware we own".
  - The claim appears only on the landing tile "Served from El Salvador", the one place the draft made a hardware claim. Softening never adds the claim anywhere else.
  - The footer tagline, the closing CTA and the OG image keep the draft's "run from El Salvador" or "run in El Salvador": where Sovereign Technology operates, and nothing about hardware.
- Upstream: "Tracks upstream gitworkshop, with a weekly drift check", never "merges upstream every week". The weekly job only reports drift; merges are done by hand. This applies to the landing tile and About.

### Header (`AppHeader`)

Purpose: identity plus the app's global actions. It keeps upstream's controls and adds the SovTech mark, the wordmark and a link to sovtech.pro.

Frame (the same as upstream): `sticky top-0 z-50 h-14 border-b border-border/40 bg-background/80 backdrop-blur-xl`, with a `container max-w-screen-xl px-4 md:px-8` inside.

1. A "Skip to content" link, hidden until focused (`sr-only focus:not-sr-only`).
   - Activating it sets `tabIndex = -1` on `document.querySelector("main")` and focuses that element. AppRouter owns `<main>`, and AppRouter is never edited.
2. A home link to `/` with the accessible name "SovTech Git home".
   - A 32px `rounded-md bg-primary text-primary-foreground` tile holding a 20px BrandMark.
   - Then the wordmark "SovTech" with " Git" in `text-brand`, set in `font-mono font-bold`.
   - The wordmark shows from `sm` up; phones show the mark only.
3. The right cluster (`ml-auto flex items-center gap-2`), in order:
   - A `sovtech.pro` text link with an ArrowUpRight icon, to `https://www.sovtech.pro`, from `lg` up, in `font-mono text-xs text-muted-foreground hover:text-foreground`.
   - Search:
     - From `sm` up, the HeaderSearchBar copy: a form that navigates to `/search?q=<encodeURIComponent(q)>`, or to `/search` when empty. Placeholder "Search repositories…". It mirrors `?q` while on `/search`.
     - Below `sm`, the HeaderSearchIcon copy: an icon toggle that opens the same form, with a "Close search" button.
   - New repository: a Plus icon button with the tooltip "New repository" and `aria-label="Create repository"`. Logged-in only. It opens upstream's `CreateRepoDialog`; the header holds its `isOpen`/`onClose` state.
   - `NavBarNotificationBadge` (links to `/notifications`). Logged-in only.
   - A Settings gear linking to `/settings`, with `aria-label="Settings"`. Logged-out only; logged-in users reach Settings from the AccountSwitcher menu.
   - `<LoginArea className="max-w-60" />`.

- Reuses: `LoginArea`, `NavBarNotificationBadge`, `CreateRepoDialog`, `useActiveAccount`, the ui `Button`, `Input` and `Tooltip`, and `cn`.
- Drops:
  - the `/icons/icon.svg` image, replaced by the inline BrandMark so the header never depends on the asset swap;
  - the search input's 30%-alpha pink focus ring, leaving the Input's full `ring-ring`.
- Link targets: `/`, `/search`, `/search?q=…`, `/settings`, `/notifications` (via the badge) and `https://www.sovtech.pro`. Every upstream target and component is kept, so the header has no parity waiver.

### Footer (`AppFooter`)

Purpose: site map, theme choice, provenance and build identity.

Frame: `mt-24 border-t border-border/40 bg-muted/30`, with the same container as the header.

1. Brand block:
   - a home link to `/` (a 24px tile plus the wordmark);
   - the tagline "Git over Nostr, run from El Salvador.";
   - the legal line "© 2026 Sovereign Technology · MIT".
2. `<nav aria-label="Footer">`, three columns. Each has a mono uppercase `text-xs` label and a real `<ul>`:
   - Get started:
     - Install ngit → `DOCUMENTATION_URLS.install`
     - Quick start → `DOCUMENTATION_URLS.quickstart`
     - About → `/about`
   - Navigate:
     - Dashboard → `/`
     - Landing page → `/landing`
     - Browse repositories → `/search`
   - SovTech:
     - sovtech.pro → `https://www.sovtech.pro`
     - Source on Nostr → `/<SOVTECH_GIT_NADDR>`
     - GitHub mirror → `https://github.com/SovereignTechnology/sovtech-git`
     - Report an issue → `/<SOVTECH_GIT_NADDR>/issues`
3. Theme control: a three-option `ToggleGroup type="single"` with `aria-label="Theme"`, visible at every width.
   - Options: Light (Sun), Dark (Moon) and System (SunMoon), each with a text label; the pressed one is bold as well as filled.
   - It reads `use$(themeMode)` and writes `setThemeMode`.
   - It ignores the empty value that Radix emits when the pressed item is clicked again.
4. Bottom bar (`border-t`, at least `h-10`, wrapping on narrow screens):
   - Left: the build string, exactly as upstream builds it: `Android v<version> · ` or `Web · `, then `<commitDate>+<sha7>`, from `__APP_RELEASE_VERSION__`, `__COMMIT_DATE__` and `__GIT_COMMIT__`. Plain text, in `font-mono text-xs text-muted-foreground`.
   - Right: "Fork of gitworkshop · MIT", linking to `/about#lineage`.

- Reuses: `DOCUMENTATION_URLS`, `themeMode` and `setThemeMode` from `@/services/settings`, `use$`, and the ui `ToggleGroup`.
- Drops:
  - the `gitworkshop.dev` wordmark and upstream's tagline;
  - the cycle button, and with it the ui `Button` (the footer's one parity waiver) and the copied `NEXT_MODE` table, which duplicates `cycleThemeMode`'s order and would drift;
  - `text-muted-foreground/50` on the build string, which fails AA.

### Landing (`LandingPage`)

Purpose: the logged-out home page. It keeps upstream's section skeleton, with one added strip, so drift ports stay line for line.

The page sets no head tags. `Index.tsx` is not shadowed and owns them, and `head.ts` rewrites its title to "SovTech Git — Decentralized Git over Nostr".

1. Hero (the page's h1):
   - A static eyebrow pill, "Sovereign Technology · El Salvador" (mono uppercase `text-xs`, `border-brand/30 bg-brand/10`, foreground text).
   - A 64px BrandMark tile.
   - The h1, in mono, `text-4xl md:text-5xl lg:text-6xl tracking-tight text-balance`: "Your keys. Your code.", then a second line in `text-brand`, "Git over Nostr."
   - The lead paragraph: "SovTech Git is a web client for git collaboration over Nostr and GRASP, run by Sovereign Technology in El Salvador. Browse repositories, open issues and review pull requests, signed with your own keypair. No account to create, no platform to trust."
     - "GRASP" links to `DOCUMENTATION_URLS.grasp`.
   - CTAs:
     - "Browse repositories" → `/search` (primary);
     - "Install ngit" → `DOCUMENTATION_URLS.install` (outline).
   - A static terminal card (mono `text-sm`, a `<figure>` with `aria-label="Example"`):
     - `# publish a repository` and `$ ngit init`;
     - `# propose a change` and `$ git push -u origin pr/my-change`;
     - a caret, `aria-hidden`, blinking only under `motion-safe:`.
   - A footnote in `text-xs text-muted-foreground`: "A fork of gitworkshop, with SovTech defaults. Read the lineage", linking to `/about#lineage`.
2. From SovTech (first of the two strips):
   - The h2 "From SovTech", with the subline "Repositories announced by Sovereign Technology's own key."
   - Only repositories announced by the SovTech npub (`83d8bce2…3434`), from upstream's `useUserRepositories`: the hook and relay query a profile page uses. No new network path.
   - Up to 6 `FeaturedRepoCard`s, with 3 skeletons while the list is empty.
   - The strip hides itself (renders nothing) when the list is still empty 2 s after it last changed, the same settle upstream's strip uses, and comes back if repositories arrive later.
3. Live on the network:
   - The h2 "Live on the network", with the subline "Recent repositories on GRASP servers, straight from the Nostr git index. Published by their authors, not reviewed by SovTech."
   - "Browse all" → `/search` (outline, from `sm` up). On phones, a full-width "Browse all repositories" sits below the grid instead.
   - A grid of 6 `FeaturedRepoCard`s in 1, 2 or 3 columns. Each card shows:
     - the name (h3);
     - the description, clamped to 2 lines;
     - up to 2 maintainers (`UserLink noLink`, `avatarSize="xs"`);
     - the relative time.
   - Each card links to `useDefaultRepoPath(repo)`.
   - Data, unchanged from upstream: `useRepositorySearch("")`, filtered to `graspCloneUrls.length > 0`, first 6, with skeletons until results settle and a 2 s settle before the empty state.
   - The empty state reads "No repositories found yet. Check your relay connections in Settings.", linking to `/settings`.
4. How it works: the h2 "How it works", with the subline "Three steps, no account."
   - Step 01, Install ngit: "One command installs ngit and git-remote-nostr on Linux, macOS or Windows."
     - CTA "Install ngit" → `DOCUMENTATION_URLS.install`.
     - Text link "Quick start" → `DOCUMENTATION_URLS.quickstart`.
   - Step 02, Publish your repo: "Run ngit init in any git repository. It announces the repo on Nostr relays and pushes it to GRASP servers such as git.sovit.xyz. No signup, just your keypair."
   - Step 03, Collaborate in the open: "Issues, patches and pull requests travel as signed Nostr events. Anyone can contribute from any NIP-34 client, this one included."
5. Why SovTech Git: the h2, with the subline "Git that answers to its owners, not to a platform." Six tiles, each an icon, an h3 and one sentence:
   - Key, "Your keys, your identity": "A Nostr keypair is your account. Sign in with a browser extension or a remote signer; there is nothing for anyone to suspend."
   - Shield, "No platform in the middle": "This site is a static client. Your code lives on the GRASP servers and relays you choose, ours in El Salvador among them."
   - GitBranch, "Plain git": "Clone, branch, commit and push as you do today. ngit adds a Nostr transport; it does not replace git."
   - MapPin, "Served from El Salvador": "Served from our own hardware in El Salvador, with defaults that include our own relay and GRASP server."
   - LockOpen, "Open and forkable": "MIT licensed. Tracks upstream gitworkshop, with a weekly drift check; the source is public on Nostr and GitHub."
   - Users, "Interoperable": "Built on NIP-34 and GRASP, so everything you publish here is readable by every Nostr git client."
6. Closing CTA: a panel with `border-brand/30` and a radial tint of at most 10% (`from-brand/10`).
   - The badge "Open source · MIT".
   - The h2 "Your repo. Your keypair. Your rules."
   - "Push code, track issues and review changes over Nostr, from a client run in El Salvador."
   - CTAs: "Install ngit" (primary) and "Browse repositories" (outline).
   - Small print: "Need sovereign infrastructure for your team? Sovereign Technology builds and runs it", linking to `https://www.sovtech.pro`.

- Reuses: `useRepositorySearch`, `useUserRepositories`, `useDefaultRepoPath`, `UserLink`, `formatDistanceToNow`, the `ResolvedRepo` type (a type-only import from `@/lib/nip34`), `DOCUMENTATION_URLS`, and the ui `Button`, `Card`, `Skeleton` and `Badge`.
- Drops:
  - the fork-glyph hero SVG and the pink/rose gradients;
  - the gitgrasp.com link, replaced by `DOCUMENTATION_URLS.grasp`;
  - the "Why ngit?" copy that names gitworkshop.dev;
  - the gradient connector line;
  - `text-[10px]` text: 12px is the floor.

### About (`About`)

Purpose: honest lineage, the licence, the protocol in brief, and where feedback goes.

- Head tags: the title "About — SovTech Git" (built from `APP_NAME`), the description "SovTech Git is Sovereign Technology's fork of gitworkshop, a git-over-Nostr web client: lineage, licence and feedback.", `ogImage` `/og-image.png` at 1200×630, and `twitterCard` `summary_large_image`.
- Layout: `container max-w-screen-md`. Headings are mono and sit outside the prose, since theme.css keeps prose headings in the body font; each paragraph block is `prose prose-neutral dark:prose-invert`. Links are `text-brand underline-offset-2`.
- The page scrolls to `#lineage`, `#licence`, `#protocol` or `#feedback` when the URL names one: ScrollToTop leaves anchors to the page.

1. The h1 "About SovTech Git". Lead: "SovTech Git is Sovereign Technology's build of gitworkshop, the git-over-Nostr web client by DanConwayDev."
2. The h2 "Lineage" (`id="lineage"`): "It is a fork of gitworkshop that tracks upstream, with a weekly drift check. Every feature (repositories, issues, patches, pull requests, notifications) is upstream's, and its documentation describes them. We change the look, this shell (header, footer, landing, about, 404 and the preview image) and the default relays and GRASP servers, which you can change in Settings."
   - "gitworkshop" links to the upstream repository in the app: `/npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/gitworkshop`, held as one constant, `UPSTREAM_REPO_PATH`.
   - "its documentation" → `DOCUMENTATION_URLS.gitworkshop`.
   - "Settings" → `/settings`.
3. The h2 "Licence" (`id="licence"`): "Upstream's code is MIT licensed and its copyright notice is kept in full. SovTech's changes are MIT licensed too."
   - "Read the licence" is a plain `<a href="/LICENSE.txt">`: a static file, not a router link.
4. The h2 "The protocol" (`id="protocol"`): one short paragraph.
   - It links NIP-34 (`https://nips.nostr.com/34`) and GRASP (`DOCUMENTATION_URLS.grasp`).
   - It links the tools ngit (`DOCUMENTATION_URLS.home`) and ngit-grasp (`DOCUMENTATION_URLS.selfHostGrasp`).
   - It keeps upstream's line on other clients (n34, budabit, gitplaza, shakespeare) with upstream's targets, held in `links.ts` as `OTHER_CLIENTS`.
5. The h2 "Feedback" (`id="feedback"`), in a bordered callout (not `role="alert"`): "Found a bug, or something we changed that you don't like? Open an issue on the SovTech Git repository over Nostr."
   - Buttons: "Open an issue" → `/<SOVTECH_GIT_NADDR>/issues`; "Browse the source" → `/<SOVTECH_GIT_NADDR>`.
   - "For bugs in upstream features, the upstream repository is the better place", linking to `UPSTREAM_REPO_PATH`.

- `SOVTECH_GIT_NADDR` (in `links.ts`) is `nip19.naddrEncode({ kind: 30617, pubkey: "83d8bce2f7d6966f306e6f1a712497cf0a2c77d073923136a0e2bb54963b3434", identifier: "sovtech-git", relays: ["wss://git.sovit.xyz", "wss://relay.ngit.dev"] })`.
  - A vitest decodes it back to `30617:83d8bce2…3434:sovtech-git`.
  - The relay hints follow whatever relays the phase 4 announcement uses.
  - Until that announcement exists, these links show upstream's not-found state.
- Reuses: `DOCUMENTATION_URLS`, `APP_NAME`, `useSeoMeta`, `Link` and `Button`.
- Drops:
  - Dan's essay (The Need, The Opportunity, The Philosophy, The Solution, Future Improvements, the CI/CD vision, arjen's runner, the Vercel note). It stays in upstream's source.
  - Both FeedbackAlerts, with Dan's issue naddrs and nprofile.
  - The `role="alert"` misuse.

### 404 (`NotFound`)

Purpose: a dead end that offers a way back. NIP19Page, CICoordinatorPage, CIProviderPage, RelayPage and RepoCoordinatorsPage also render it for bad identifiers, so the copy stays generic.

- Head tags: the title "Page not found — SovTech Git", `robots: "noindex"`, and upstream's description.

A centred block with `py-24`:

1. "404", in mono `text-6xl text-brand`, `aria-hidden`.
2. The h1 "Nothing lives at this path", in mono `text-2xl`.
3. A terminal box (mono `text-sm`, `bg-muted`, `rounded-md`, truncating):
   - `$ git checkout <path>`
   - `error: pathspec '<path>' did not match any file(s) known to git`
   - `<path>` is `location.pathname` as a text node, cut to 80 characters.
4. "The link may be mistyped, or what it points to has not reached the relays we asked yet."
5. Buttons:
   - "Go home" → `/` (a router Link, primary);
   - "Search repositories" → `/search?q=<encodeURIComponent(last path segment, decoded once)>` (outline), or `/search` for `/`.

- Keeps upstream's `console.error` of the path.
- Drops the hard-coded gray and blue colours, and the full page reload of `<a href="/">`.

### OG image (`OgImagePreview`, route `/og-preview`)

Purpose: the source of `public/og-image.png`, which is 1200×630 and listed in `asset-swaps.tsv`.

- The page has a stable element, `id="sovtech-og"`, exactly 1200×630.
  - The element gets `data-og-ready="true"` once the Inter font has loaded and `document.fonts.ready` resolves.
  - The page is a fixed, full-window layer above the app shell, so at a 1200×630 window the element is the whole viewport.
- The capture runs on the laptop, from a CI-built `dist` only: the green MR pipeline's verify `dist` artifact, extracted with a path-safety check into a work directory outside the repository, served on `127.0.0.1` by a standard-library Python server with an SPA fallback, and shot with headless Chromium in a throwaway `--user-data-dir` under that directory, never a real profile: `chromium --headless=new --hide-scrollbars --window-size=1200,630 --virtual-time-budget=8000 --screenshot=<out>.png http://127.0.0.1:<port>/og-preview`. The PNG must be 1200×630 and under 200 KB.
- The design is theme-independent: fixed hex in inline styles, no network, no animation, inline SVG only.
- Composition, with everything inside a safe area of x 80–1120 and y 60–570:
  - Background `#0A0A0A`, with a 40px orange grid at 6% alpha, a soft orange radial glow at the top right (at most 10%), and a 6px `#F7931A` bar down the left edge.
  - Top left: `git.sovtech.pro`, mono 24px, `#F7931A`.
  - The hero at y≈170: "Your keys." in `#FAFAFA` and "Your code." in `#F7931A`, mono 88px bold, line-height 1.1, letter-spacing -2px.
  - Below it: "Git collaboration over Nostr, run from El Salvador.", Inter 30px, `#A3A3A3`.
  - Bottom left: a 56px `#F7931A` rounded tile with a `#0A0A0A` BrandMark, then "SovTech" in `#FAFAFA` and " Git" in `#F7931A`, mono 40px bold.
  - Bottom right: "NIP-34 · GRASP · ngit", mono 22px, `#8A8A8A`.
  - Every text colour is at least 5.7:1 on `#0A0A0A` (`#8A8A8A` is 5.73:1).
- Drops the purple/pink palette, the GitWorkshop wordmark, "powered by Git & Nostr" and the preview outline.

### Tokens

- Colour roles. theme.css (MR 2.2) sets the values; the shell uses only the role classes.
  - Page background: dark `#0A0A0A`, light `#FCFCFC`. Page text: dark `#EDEDED`, light `#171717`.
  - Brand fill, `bg-primary`: `--brand-500`, which is `#F7931A` in dark mode with a `#0A0A0A` label (8.61:1) and `#B05907` in light mode with a white label (4.9:1).
  - Brand text, `text-brand`: `--brand-500` as well, `#F7931A` in dark mode (8.61:1 on the page) and `#B05907` in light mode (4.8:1 on the page, 4.9:1 on cards).
  - Muted text: dark `#9E9E9E`, light `#666666`.
  - Focus ring: `--ring`, the same `--brand-500`.
- Radius: `--radius` 0.5rem, matching www's `rounded-lg`.
  - Tiles and buttons use `rounded-md`; cards use `rounded-lg`.
  - `rounded-full` is for badges and pills only.
- Spacing: Tailwind's 4px scale, limited to steps 1, 2, 3, 4, 6, 8, 12, 16 and 24.
  - The container is `max-w-screen-xl px-4 md:px-8`.
  - Sections use `py-16 md:py-24`; the header is `h-14`.
- Type:
  - Body text: Inter Variable (self-hosted, `font-sans` via tailwind-brand).
  - Headings and the wordmark: `font-mono`, bold, `tracking-tight`, on Tailwind's default system stack: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace.
  - Scale:
    - display `text-4xl`/`5xl`/`6xl` (36/48/60px);
    - h2 `text-2xl md:text-3xl`;
    - h3 `text-base`;
    - lead `text-lg md:text-xl`;
    - body `text-base`;
    - small `text-sm`;
    - meta and eyebrow `text-xs`, the 12px floor. Eyebrows are mono, uppercase, `tracking-wider`.
- Focus: every interactive element gets `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`, with `ring-offset-2 ring-offset-background` on buttons, tiles and nav links. Never an alpha ring.
- Motion (CSS only):
  - `transition-colors` and `transition-opacity` at 150ms ease-out.
  - Transforms (the card lift, `-translate-y-0.5`) at 200ms, and only under `motion-safe:`.
  - No infinite animation in the overlays, except the caret, which is under `motion-safe:`.
  - theme.css carries a global `prefers-reduced-motion: reduce` guard (added with the shell): animation and transition durations of 0.01ms, one iteration, and `scroll-behavior: auto`.
    - The guard also calms upstream's skeletons, spinners and dialogs.
    - It uses 0.01ms rather than `none` so that Radix still receives `animationend`.

### Accessibility (WCAG 2.2 AA)

- Measured contrast (theme.css as shipped):
  - `#F7931A` on `#0A0A0A` is 8.61:1 (AAA). This is the brand text and the ring in dark mode.
  - `#F7931A` on white is 2.30:1, so the bright orange is never text, an icon or a ring on a light surface; light mode uses `#B05907`.
  - Light-mode brand text `#B05907` is 4.8:1 on the page, 4.9:1 on cards and 4.7:1 on the footer, but only 4.49:1 on a full `bg-muted` and 4.2:1 on a 10% brand tint. So brand text never sits on either: the eyebrow pill's text is the foreground colour, and the icons on tints are non-text (3:1).
  - Button labels: `#0A0A0A` on `#F7931A` is 8.61:1; white on `#B05907` is 4.9:1. Overlays never put white on the bright orange.
  - Muted text: `#9E9E9E` is 7.39:1 on `#0A0A0A`; `#666666` is 5.62:1 on `#FCFCFC`. No text has reduced opacity.
- Structure:
  - One h1 per page, sections h2, cards h3.
  - `<header>`, and `<footer>` with a labelled `<nav>` and real lists; the steps and tiles are lists too.
  - Decorative icons and the mark are `aria-hidden`.
  - Icon-only buttons have an `aria-label` and a tooltip.
- Targets are 32×32px (`h-8 w-8`), above the 24px minimum.
- The layout holds at 320px wide and at 200% zoom. The wordmark hides below `sm` instead of wrapping.
- The theme control is a labelled single-select group that announces its state. No state is shown by colour alone.
- Checked in the plan's UI verification: light and dark screenshots of the CI `dist`, plus `getComputedStyle` contrast checks.

### Ratchet and gate impact

- `shadow-map.tsv` has the six rows above, which release mode requires.
- The shell empties `pending`:
  - `dan-bech32-tlv`, 4 to 0 (About's feedback naddrs and nprofiles);
  - `danconwaydev`, About's two;
  - `gitworkshop-host`, the footer, landing and About copy (5), and the SubordinateForkField input hint (1), which moves to `functional`.
- `functional` after the shell, each with its reason in `brand-allowlist.json`:
  - `gitworkshop-host` 7: the host sets that recognise upstream links (6), and the input hint that names them (1). The engine rule `subordinate-fork-hint` makes the hint read "gitworkshop.dev or git.sovtech.pro repo URLs", which the host sets accept since the defaults MR.
  - `danconwaydev` 2: `public/LICENSE.txt` and About's credit line.
  - `dan-npub` 1: `UPSTREAM_REPO_PATH`.

### What stays upstream

- `Index.tsx`: logged-in visitors get the Dashboard, logged-out visitors the landing overlay. Its head tags are rewritten by `head.ts`.
- `AppRouter.tsx` and every route, including:
  - `/landing`, `/about` and `/og-preview`;
  - the ngit.dev doc redirects (`/ngit`, `/install`, `/quick-start`, `/docs/*`);
  - the NotFound fallbacks in NIP19Page, CICoordinatorPage, CIProviderPage, RelayPage and RepoCoordinatorsPage, which receive the overlay through `resolveId`.
- Sign-in: `LoginArea`, `AccountSwitcher` (its menu holds Settings and Outbox) and `LoginDialog`.
- `NavBarNotificationBadge`, `CreateRepoDialog`, `RepositoriesPage`, `useRepositorySearch` and `useUserRepositories`.
- The Settings page and the theme API. `settings.ts` gets only MR 2.2's default seam.
- `DOCUMENTATION_URLS`: the docs stay on ngit.dev, and SovTech hosts none.
- Handled elsewhere:
  - index.html's title, meta and splash: the MR 2.1 engine;
  - the manifest and icons: MR 2.2.
- Repo, PR, issue and dashboard pages change only through the theme, as do the ui primitives.

## Upstream sync

`ci/sovtech/sync-upstream.sh` (weekly, or ad hoc for security fixes; Cameron
runs it from a clean checkout):

1. Assert the `upstream` remote is Dan's npub over `nostr://` with push
   `DISABLED`, fetch upstream `main` and `origin/main`, and cross-check
   `refs/heads/main` on gitnostr.com and relay.ngit.dev.
2. Take the rules (`sync_checks.py`, `sovci.py`) from the fork head with
   `git archive`, refusing any `__pycache__` entry or `.pyc` file, prove each
   file byte-identical to its blob, and run them with `python3 -I`. Nothing
   from the tree being merged ever runs on the laptop.
3. Refuse unless the new head descends from `UPSTREAM_BASE` and the history has
   the single root `19dd6a87`.
4. Refuse any upstream add, change or delete of a fork-owned path
   (`ci/sovtech/`, `src/sovtech/`, `SOVTECH.md`, `NOTICE.md`,
   `CHANGELOG.sovtech.md`, `CLAUDE.md`, `.gitlab-ci.yml`, `renovate.json`),
   with no allowlist. Refuse new or changed agent and editor configuration
   (deny-by-default, acked per blob in `ci/sovtech/agent-config-allow.txt`),
   flag `AGENTS.md` changes for a person, and list the security-sensitive
   paths to review. Every upstream path and diff line is printed with
   non-printable characters escaped.
5. Merge with `--no-ff` as `sovtech <git@sovit.xyz>` on
   `sync/upstream-<sha8>` (git's merge output, which names upstream paths, is
   printed with non-printable characters escaped), re-delete the paths in
   `ci/sovtech/fork-deleted.txt` as literal paths (entries may not hold `*`,
   `?`, `[`, `\` or `:`), and stop for a person on any real conflict.
6. Prove every fork-owned path still equals the fork head's, print the drift
   report for shadowed and watched files, bump `UPSTREAM_BASE` as `sovITxyz`,
   and print the push command that opens the MR with the `upstream-sync` label
   (`--push` runs it).

`--finish` resumes after a person committed the merge. It fetches again and
re-runs steps 1 to 4: upstream `main` and `origin/main` must still be the
merge's parents 2 and 1, and the branch name must be `sync/upstream-` plus the
first 8 hex digits of that upstream head. If either moved, regenerate the
branch.

`--report-only` is the weekly CI drift job: the same fetch and checks, a trial
merge in a throwaway worktree, and the report. It changes nothing. CI runners
have no nostr helper, so it fetches from the two GRASP https URLs and requires
them to agree.

Sync MRs are merge commits: never squash or rebase them.

## CI and the gate

`.gitlab-ci.yml` runs every job in a fresh Kata VM. No job uses CI/CD
variables or secrets. Routing comes from ref protection alone. Every
`workflow:rules` entry that creates a pipeline sets `SOVGIT_RUNNER_TAG`: to
the protected runner's tag exactly when it requires
`$CI_COMMIT_REF_PROTECTED == "true"` (a push to `main`, `sovtech-v*` tags),
and to the unprotected runner's tag exactly when it requires
`$CI_COMMIT_REF_PROTECTED != "true"` (merge request events, the drift
schedule on `drift/weekly`). The last rule is `when: never`, so an
unprotected `main` or tag, or a merge request or drift schedule on a
protected ref, creates no pipeline. Every job inherits
`default: tags: [$SOVGIT_RUNNER_TAG]`; no job or template has `tags` or
`inherit`, and nothing else sets that variable or any `CI_*` variable. So
merge requests, sync MRs and the drift job run on `ci-sovgit`, and `main` and
`sovtech-v*` tags on `ci-sovgit-prot`, which takes protected refs only.

The gate's `ci-config` step checks this statically (below). The runbook,
`kata/ci-sovgit/README.md` in `sovtech/platform`, adds a pre-merge GitLab CI
Lint dry run with `ref=main` on a CI change's head (more than zero jobs,
every one tagged exactly the protected tag), and checks which runner the
first merge request pipeline ran on, since no dry run can simulate a merge
request pipeline.

- **guard:** `ci/sovtech/gate.sh --phase history`, before any dependency code
  runs.
- **verify:** Node 24 and pnpm 9.15.9 through corepack (both asserted),
  `pnpm install --frozen-lockfile`, upstream's `pnpm test`, then
  `gate.sh --phase dist` on the built `dist`.
- **recheck** (MRs and `main`): `gate.sh --phase recheck` on verify's `dist`
  artifact, in a job that never runs pnpm. verify's own dist gate ran after
  dependency install scripts, vite and vitest, so it is only self-reported.
- **e2e** (sync MRs and tags): upstream's e2e suites against ngit-grasp 3.0.0
  built with `cargo install --locked`. A missing or empty JUnit report, zero
  testcases or any skipped test fails the job.
- **package** (tags): `gate.sh --phase recheck --release` on the downloaded
  artifact first, then the tested `dist` as a deterministic tarball with
  `build-info.json` and `SHA256SUMS`; source maps are a separate artifact.
- **drift** (the weekly schedule on `drift/weekly`; the schedule on
  `drift/weekly` carries no variables): `sync-upstream.sh --report-only`.

The gate checks, all failing closed:

- **Identity:** every fork commit
  (`git rev-list TARGET..HEAD --not UPSTREAM_BASE`) is
  `sovITxyz <git@sovit.xyz>` as author and committer; only merge commits may
  be `sovtech <git@sovit.xyz>`, and none may have more than two parents
  (octopus merges are refused, see gitleaks below). No trailers, no
  attribution text, and no `hs.internal` identity anywhere in the push range.
- **Fork-owned base:** the `UPSTREAM_BASE` tree holds no fork-owned path, so
  no upstream commit can reach into the gate, and a fork commit cannot pose as
  the base. A control requires the same listing to see the gate at `HEAD`.
- **`UPSTREAM_BASE`:** it must be a parent of a fork commit, so it only moves
  with a sync merge, and only `sync/upstream-*` MRs may change it. It must be
  on upstream `main` as both GRASP servers publish it (fetched over https with
  no credentials; a failed fetch fails the check) whenever TARGET does not
  already vouch for it: a changed or new base, release mode, and CI runs
  without a TARGET.
- **Gate changes:** every changed path under `ci/sovtech/` and
  `.gitlab-ci.yml` against TARGET is printed as `REVIEW gate-change`. On a
  `sync/upstream-*` branch only the data files a sync updates may change
  (`UPSTREAM_BASE`, `shadow-map.tsv`, `brand-allowlist.json`,
  `touched-upstream.txt`, `asset-swaps.tsv`, `agent-config-allow.txt`,
  `upstream-palette.sha256`, each staying a regular file); any change to the gate's code (`*.sh`, `*.py`,
  `tools.sha256`, `gitleaks.toml`, `.gitleaksignore`, `fork-deleted.txt`, any
  new file) or to `.gitlab-ci.yml` fails.
- **No bytecode:** `HEAD`'s `ci/sovtech` may hold no `__pycache__` entry and
  no `.pyc` file (in any case); a control proves the matcher first.
- **CI config** (`ci/sovtech/ci_config.py`, standard library only): the
  routing above, read with a strict YAML-subset parser that refuses anchors,
  tags, flow mappings and anything else it cannot read exactly. Each
  protected rule also pins `$CI_COMMIT_BRANCH == "main"` or a `sovtech-v`
  tag (neither exists in a merge request pipeline) and tests the pipeline
  source, if at all, only as `"push"`. The only `tags` key is the default; no
  `include`, `trigger`, `inherit`, `parallel` (a `parallel: matrix` entry
  sets job variables that tags expand) or `dotenv`; no other `variables`
  block sets `SOVGIT_RUNNER_TAG`, and none sets any `CI_*` key; the two tag
  literals appear only in the workflow rules. Mutated copies (a job tagged
  with the unprotected tag, a job matrix, a protected merge request rule, a
  missing final `when: never`, among others) must each fail first.
- **gitleaks:** pinned by sha256 in `ci/sovtech/tools.sha256`, checked before
  extraction, and run with `--config ci/sovtech/gitleaks.toml`: gitleaks
  8.30.1's default config (the `v8.30.1` tag's `config/gitleaks.toml`, the
  same bytes the pinned binary embeds) without the global allowlist entries
  for images, fonts, documents and `node_modules`. The lockfile entry
  (`pnpm-lock.yaml`, `package-lock.json` and the like) is kept on purpose:
  upstream's lockfiles change in every sync range and would only add noise.
  The scan is proven on planted tokens, on a file that `.gitattributes` marks
  `-diff`, on a conflicted merge whose resolution plants one, and on one
  token each in `x.svg` and `node_modules/a.js` (exactly two findings), then
  run over the push range with `--text --no-textconv --diff-merges=remerge`:
  `-diff` files (upstream marks `*.ts`) are scanned as text, and merge
  resolutions are scanned too (git 2.36 or later). Remerge diffs exist for
  two-parent merges only, which is why the identity check refuses octopus
  merges in the fork range. Inline `gitleaks:allow` comments are ignored:
  accepted findings go only in `ci/sovtech/.gitleaksignore`.
- **Overlay guard:** shadow-map acked blobs, sentinels and markers; the
  `touched-upstream.txt` numstat bound; `asset-swaps.tsv` blobs; deleted paths
  stay deleted; upstream's palette (one `:root` and one `.dark` block in
  `src/index.css`) still has the sha256 in
  `ci/sovtech/upstream-palette.sha256`, and a failure prints the new digest
  to record once theme.css is ported; the CSP meta in `dist` is
  byte-identical to upstream's.
- **Theme order** in `dist` (`theme-css-order`): exactly one file declares
  `--brand-foreground`, a stylesheet that `index.html` and `404.html` load,
  whose theme.css `:root` and `.dark` blocks open with `color-scheme` light
  and dark and are nested in nothing. Every other block in it that sets a
  palette variable (upstream's variable names, or any `--brand-*`) comes
  before theme.css's `:root`, is exactly `:root` or `.dark` inside at-rules
  only (theme.css's specificity), uses no `!important`, and sets nothing
  theme.css's block of the same selector does not. No other file, lazy chunk
  stylesheets, inline `<style>` and scripts included, sets a palette
  variable or names one in a string (a React style object or a
  `setProperty()` call): a lazy chunk's stylesheet loads after theme.css and
  would bring upstream's colours back. Every stylesheet a page links is a
  file in `dist`, and no built CSS or inline `<style>` holds an `@import`.
  Comments, strings, escapes and `url()` are masked before the braces are
  read; declarations after a nested rule count. The check is static: a
  variable name built at run time is out of its reach. Eighteen planted
  faults (reversed order, a layered theme, a declaration after a nested
  rule, lazy chunks setting an upstream and a `--brand-*` variable, an
  inline style, a script, an external link, one hidden behind a `<!--` in a
  script string, an `@import`, `html.dark`, a nested block, `!important`, a
  missing variable, no upstream palette, an unlinked or commented-out
  stylesheet, no theme) must each fail first.
- **Brand assets** (`gen-brand-assets.py --check`, history phase, standard
  library only): the committed files at `HEAD` are what the generator
  writes, as far as that can be known without Chromium. `mark.svg` passes
  the element and attribute allow-list; `mark-on-dark.svg`, `favicon.svg`
  and `icons/icon.svg` are byte for byte the mark composed on its tile, so
  no script or handler can reach the same-origin SVGs; every PNG is exactly
  `IHDR`, `IDAT` and `IEND`, 8-bit and not interlaced, with the pixel size of
  its name and colour type 2 (apple-touch, maskable, `icon.png`) or 6 (the
  tiles); `favicon.ico` is the committed 16, 32 and 48 px tiles; and the
  maskable icons, decoded, keep every pixel outside the safe zone plain
  background. Attribute values in the mark are plain (numbers, path data,
  `#hex` colours, keywords; no `url()`, `:` or `/`), so the SVGs reference
  no other resource. A decoder round trip and nine planted faults (an
  `onload`, a `<script>`, a `style`, a comment and a `url()` value in the
  mark; an extra chunk, a wrong colour type and a wrong size in a PNG; ink
  outside the safe zone) come first.
- **Brand-leak ratchet** over `dist` without source maps: upstream brand terms
  (the `GitWorkshop` name, and `gitworkshop.dev` both as a URL and as a bare
  host in any case), Dan's npub and hex key (also inside decoded bech32 TLVs),
  `nos.lol`, the manifest names and `og:url`. Counts must equal
  `ci/sovtech/brand-allowlist.json` exactly: `functional` entries are
  permanent, `pending` entries name the MR that removes them.
  `gate.sh --baseline` prints the counts that seed `pending`; `--release`
  requires `pending` to be empty and six shadow rows.
- **Dist secret scan** (maps included): Nostr secret keys, bunker secrets,
  GitLab, GitHub and AWS tokens and private-key blocks, reported by rule, file
  and byte offset only.
- Both dist scans fail on any symlink in `dist` or the maps, to a file or to
  a directory (a linked directory would otherwise go unscanned), and on a
  directory they cannot read; a planted symlink proves it on every run.

Every Python check runs as `python3 -I` (isolated mode: neither the script's
directory nor the working directory is on `sys.path`), so no file in the tree
can stand in for a standard-library module. Each script reads `sovci.py`'s
source, compiles it and runs it in a fresh module, without the import
system, so no `.pyc` is ever read: a planted
`ci/sovtech/__pycache__/sovci.cpython-3XX.pyc`, even an unchecked-hash one,
cannot stand in for it. The scripts refuse to run without `-I` (or below
Python 3.10), and check that before any import but the built-in `sys`, so
even a run without `-I` stops before a planted sibling such as `argparse.py`
could load.

Before pushing, also run the `differential-review` and `sharp-edges` audits on
the diff. `ci/sovtech/` is bash and Python 3 standard library only, so it can
be checked on the laptop without upstream code.

The gate still runs from the tree it checks: an MR that changes `gate.sh`
changes the checks it is held to, and `REVIEW gate-change` only makes that
visible. The stronger option, a follow-up for Cameron (no project setting has
changed): point project 88's CI/CD configuration file at a Maintainer-only
policy project whose pipeline extracts the gate from the MR's target branch
and runs that copy against the MR head, so an MR can never weaken its own
gate.

## Protected-runner token

Dependency code runs on the protected runner: `verify:main`,
`verify:release` and `e2e:release` run pnpm lifecycle scripts, vite, vitest,
tsc and cargo on `ci-sovgit-prot`. A malicious dependency could read that
runner's token there and later use it to take protected jobs.

Mitigation in force: rotate `ci-sovgit-prot`'s token after every sync MR
merge and after every release (`POST /runners/:id/reset_authentication_token`),
piping the new token straight to the server's 0600 token file and to
`secret-store`; it is never printed. This bounds a one-time read only:
`verify:main` runs the same lockfile's dependencies on every `main`
pipeline, so a poisoned dependency re-reads the new token at the next one.
The real bound is the clean runner below, or a rotation after every
protected pipeline.

A third, clean runner that takes only the guard, recheck and package jobs,
so no job that judges or ships the dist shares a token with dependency code,
is a possible hardening that Cameron may choose later.

The limit no rotation removes: a poisoned dependency can alter the built
`dist` itself. recheck runs where no dependency code ran, but it only
catches what the dist checks look for (brand and secret regressions), not a
malicious change to the app's code.

## Deployment

Releases (`sovtech-v*` tags) build a deterministic artifact in CI
(`sovtech-git-<tag>.tar.gz`, `build-info.json`, `SHA256SUMS`). Cameron
deploys it from the laptop to the `git-web` guest on l5400 with
`kata/ngit-grasp/deploy-spa.sh` in the `sovtech/l5400` repository.
