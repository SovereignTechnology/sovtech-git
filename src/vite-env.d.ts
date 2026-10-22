/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in a `pnpm build:profile` build: names kept, render attribution on. */
  readonly VITE_PROFILE?: string;
}

declare const __APP_NAME__: string;
declare const __APP_RELEASE_VERSION__: string | null;
declare const __GIT_COMMIT__: string;
declare const __COMMIT_DATE__: string;
