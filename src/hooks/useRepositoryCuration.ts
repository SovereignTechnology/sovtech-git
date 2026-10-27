import { useContext, useSyncExternalStore } from "react";
import { RepositoryCurationContext } from "@/contexts/RepositoryCurationContext";
import {
  relayCurationMode,
  resolveRelayCurationMode,
  DEFAULT_RELAY_CURATION_MODE,
  type RelayCurationPreference,
} from "@/services/settings";
import { use$ } from "./use$";

const setMode = (mode: RelayCurationPreference) => relayCurationMode.next(mode);
function useGlobalCuration() {
  const preference = use$(relayCurationMode) ?? "default";
  return {
    mode: resolveRelayCurationMode(preference),
    preference,
    defaultMode: DEFAULT_RELAY_CURATION_MODE,
    setMode,
  };
}

// Failed storage writes still apply for the lifetime of this tab.
const unsaved = new Map<string, RelayCurationPreference>();
const listeners = new Set<() => void>();
const storagePrefix = "gitworkshop:repo-curation:v1:";

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(storagePrefix)) {
      if (event.key === null) unsaved.clear();
      else unsaved.delete(event.key);
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function readPreference(key: string | undefined): RelayCurationPreference {
  if (!key) return "default";
  const fallback = unsaved.get(key);
  if (fallback !== undefined) return fallback;
  try {
    const value = localStorage.getItem(key);
    return value === "repo" || value === "outbox" ? value : "default";
  } catch {
    return "default";
  }
}

/** Repository identity comes from the shared reciprocal component resolver. */
export function useSavedRepositoryCuration(componentId: string | undefined) {
  const global = useGlobalCuration();
  const key = componentId ? storagePrefix + componentId : undefined;
  const preference = useSyncExternalStore(
    subscribe,
    () => readPreference(key),
    () => "default" as const,
  );
  return {
    preference,
    defaultMode: global.mode,
    mode: preference === "default" ? global.mode : preference,
    setMode: (value: RelayCurationPreference) => {
      if (!key) return;
      try {
        if (value === "default") localStorage.removeItem(key);
        else localStorage.setItem(key, value);
        unsaved.delete(key);
      } catch {
        unsaved.set(key, value);
      }
      listeners.forEach((listener) => listener());
    },
  };
}

/** Descendant loaders and controls share the repository's effective preference. */
export function useRepositoryCuration() {
  const local = useContext(RepositoryCurationContext);
  const global = useGlobalCuration();
  return local ?? global;
}
