import { createContext } from "react";
import type {
  RelayCurationMode,
  RelayCurationPreference,
} from "@/services/settings";

export const RepositoryCurationContext = createContext<{
  mode: RelayCurationMode;
  preference: RelayCurationPreference;
  defaultMode: RelayCurationMode;
  setMode: (mode: RelayCurationPreference) => void;
} | null>(null);
