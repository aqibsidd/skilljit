import { UpstreamManager } from "./upstream.js";
import type { UpstreamSpec, ConnectFn } from "./upstream.js";

export interface DoctorEntry {
  ok: boolean;
  toolCount?: number;
  error?: string;
}

export type DoctorReport = Record<string, DoctorEntry>;

/** Verify every managed upstream still spawns, handshakes, and lists tools —
 * `skilljit doctor`, so adopting the proxy layer isn't a leap of faith. */
export async function runDoctor(specs: UpstreamSpec[], connectFn?: ConnectFn): Promise<DoctorReport> {
  const manager = new UpstreamManager(specs, connectFn);
  const tools = await manager.listAllTools();
  const errors = manager.getErrors();
  await manager.closeAll();

  const report: DoctorReport = {};
  for (const spec of specs) {
    const err = errors[spec.name];
    if (err) {
      report[spec.name] = { ok: false, error: err };
    } else {
      report[spec.name] = { ok: true, toolCount: tools.filter((t) => t.server === spec.name).length };
    }
  }
  return report;
}
