import { createContext } from "react";
import type { RelayCurationMode } from "@/services/settings";

export const RepositoryCurationContext = createContext<{
  mode: RelayCurationMode;
  setMode: (mode: RelayCurationMode) => void;
} | null>(null);
