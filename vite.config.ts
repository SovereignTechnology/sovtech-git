import path from "node:path";
import { execSync } from "node:child_process";

import react from "@vitejs/plugin-react-swc";
import { defineConfig, type Plugin } from "vitest/config";
import { name } from "./package.json";

/** Notification owners cannot be replaced while React retains their old entries. */
function notificationReloadPlugin(): Plugin {
  const owner = path.resolve(__dirname, "src/hooks/useNotifications.ts");
  return {
    name: "notification-owner-reload",
    apply: "serve",
    handleHotUpdate({ modules, server, timestamp }) {
      // Follow importers so changes to transitive state/relay dependencies
      // also restart the owners. Component and stylesheet edits keep HMR.
      const affected = new Set(modules);
      for (const module of affected) {
        for (const importer of module.importers) affected.add(importer);
      }
      if (![...affected].some((module) => module.file === owner)) return;

      const invalidated = new Set<(typeof modules)[number]>();
      for (const module of modules) {
        server.moduleGraph.invalidateModule(
          module,
          invalidated,
          timestamp,
          true,
        );
      }
      server.ws.send({ type: "full-reload" });
      return [];
    },
  };
}

function getGitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

function getCommitDate(): string {
  try {
    return execSync("git log -1 --format=%cd --date=format:%Y-%m-%d")
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

/** Replaces %APP_NAME% tokens in index.html at build and dev time. */
function htmlAppNamePlugin(): Plugin {
  return {
    name: "html-app-name",
    transformIndexHtml(html) {
      return html.replace(/%APP_NAME%/g, name);
    },
  };
}

/**
 * Serves manifest.webmanifest with the app name and description sourced from
 * package.json so there is a single source of truth.
 */
function manifestPlugin(): Plugin {
  const virtualId = "/manifest.webmanifest";
  const manifest = JSON.stringify(
    {
      name: "GitWorkshop.dev",
      short_name: "GitWorkshop",
      description: "Decentralized GitHub alternative over Nostr",
      start_url: "/",
      display: "standalone",
      background_color: "#16171e",
      theme_color: "#16171e",
      categories: ["development", "productivity", "utilities"],
      icons: [
        {
          src: "/icons/icon-192x192.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "/icons/icon-512x512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "/icons/pwa-maskable-192x192.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "maskable",
        },
        {
          src: "/icons/pwa-maskable-512x512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ],
    },
    null,
    2,
  );

  return {
    name: "manifest",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === virtualId) {
          res.setHeader("Content-Type", "application/manifest+json");
          res.end(manifest);
        } else {
          next();
        }
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: manifest,
      });
    },
  };
}

/**
 * `pnpm build:profile`: a production build that can be profiled, into
 * `dist-perf/`. Function and class names survive minification, so components
 * and every frame of a CPU profile read as names instead of `Xe`, and
 * `VITE_PROFILE=1` installs the runtime probes (`src/lib/perfRuntime.ts`).
 * Never a release build — it is larger and a little slower.
 *
 * `VITE_PROFILE_REACT=1` on top swaps in react-dom's profiling build, so each
 * component carries its render time (selfMs in the report). It inflates CPU,
 * so it is the wrong build for asking how much a flow costs overall.
 */
const PROFILE_BUILD = process.env.VITE_PROFILE === "1";
const PROFILE_REACT = PROFILE_BUILD && process.env.VITE_PROFILE_REACT === "1";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  define: {
    __APP_NAME__: JSON.stringify(name),
    __APP_RELEASE_VERSION__: JSON.stringify(
      process.env.APP_RELEASE_VERSION ?? null,
    ),
    __GIT_COMMIT__: JSON.stringify(getGitCommit()),
    __COMMIT_DATE__: JSON.stringify(getCommitDate()),
  },
  build: {
    sourcemap: true,
    target: ["es2022"],
    ...(PROFILE_BUILD ? { outDir: "dist-perf" } : {}),
  },
  esbuild: {
    target: ["es2022"],
    ...(PROFILE_BUILD ? { keepNames: true } : {}),
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "es2022",
    },
  },
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    notificationReloadPlugin(),
    react(),
    htmlAppNamePlugin(),
    manifestPlugin(),
  ],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    // Unit tests live under src/. End-to-end tests (e2e/**/*.e2e.test.ts) need
    // a real ngit-grasp server and run via a separate config
    // (vitest.e2e.config.ts / `pnpm test:e2e` or `npm run test:e2e`), so they
    // are excluded here.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    onConsoleLog(log) {
      return !log.includes("React Router Future Flag Warning");
    },
    env: {
      DEBUG_PRINT_LIMIT: "0", // Suppress DOM output that exceeds AI context windows
    },
  },
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      // React 18's react-dom/client re-exports react-dom; profiling is the
      // same renderer plus fiber timings.
      ...(PROFILE_REACT
        ? [{ find: /^react-dom$/, replacement: "react-dom/profiling" }]
        : []),
    ],
  },
}));
