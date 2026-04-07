export type DebugEntryType =
  | "tool_call"
  | "tool_result"
  | "summary_generated"
  | "context_loaded"
  | "error";

export interface DebugEntry {
  timestamp: string;
  type: DebugEntryType;
  data: Record<string, unknown>;
}

const log: DebugEntry[] = [];

export function pushLog(type: DebugEntryType, data: Record<string, unknown>) {
  log.push({ timestamp: new Date().toISOString(), type, data });
  // Cap at 500 entries to avoid unbounded growth
  if (log.length > 500) log.splice(0, log.length - 500);
}

export function getLog(): DebugEntry[] {
  return log;
}

export function clearLog() {
  log.length = 0;
}
