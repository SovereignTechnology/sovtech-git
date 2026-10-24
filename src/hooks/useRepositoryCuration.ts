import { useContext } from "react";
import { RepositoryCurationContext } from "@/contexts/RepositoryCurationContext";
import { relayCurationMode, type RelayCurationMode } from "@/services/settings";
import { use$ } from "./use$";

const setDefault = (mode: RelayCurationMode) => relayCurationMode.next(mode);
/** Repository controls override the default for this visit, not every repo. */
export function useRepositoryCuration() {
  const local = useContext(RepositoryCurationContext);
  const preferred = use$(relayCurationMode) ?? "repo";
  return local ?? { mode: preferred, setMode: setDefault };
}
