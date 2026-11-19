// Side-effect module installing the runtime profiler's probes. Imported first
// by main.tsx so it runs before react-dom looks for its DevTools hook and
// before any socket or timer. PROFILING BUILDS ONLY: the constant folds and
// normal builds drop this call and the profiler with it.
import { installRuntimeProfiler } from "@/lib/perfRuntime";

if (import.meta.env.VITE_PROFILE === "1") installRuntimeProfiler();
