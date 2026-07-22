/**
 * `plinius backend` — list / info / health across execution backends.
 */
import { createDefaultRegistry } from "../backend/default-registry.js";
import { CAPABILITIES } from "../backend/capabilities.js";

export async function runBackendList(): Promise<void> {
  const registry = createDefaultRegistry();
  console.log(`\n=== Available Backends ===`);
  for (const name of registry.list()) {
    const backend = registry.get(name);
    const meta = backend.metadata();
    console.log(`  ✓ ${meta.vendor} (${meta.backendName} v${meta.backendVersion}, api=${meta.apiVersion ?? "—"})`);
  }
}

export async function runBackendInfo(name: string): Promise<void> {
  const registry = createDefaultRegistry();
  const backend = registry.get(name);
  const meta = backend.metadata();
  const caps = await backend.capabilities();

  console.log(`\n=== Backend: ${meta.backendName} ===`);
  console.log(`Vendor: ${meta.vendor}  Version: ${meta.backendVersion}  API: ${meta.apiVersion ?? "—"}`);
  console.log(`Max context: ${caps.maxContextLength ?? "unknown"}  Max output: ${caps.maxOutputLength ?? "unknown"}`);
  console.log(`Capabilities (supported / unsupported / unknown):`);
  const supported = CAPABILITIES.filter((c) => caps.capabilities[c] === "supported");
  const unsupported = CAPABILITIES.filter((c) => caps.capabilities[c] === "unsupported");
  const unknown = CAPABILITIES.filter((c) => caps.capabilities[c] === "unknown");
  console.log(`  supported:   ${supported.join(", ") || "—"}`);
  console.log(`  unsupported: ${unsupported.join(", ") || "—"}`);
  console.log(`  unknown:     ${unknown.join(", ") || "—"}`);
}

export async function runBackendHealth(name?: string): Promise<void> {
  const registry = createDefaultRegistry();
  const names = name ? [name] : registry.list();
  console.log(`\n=== Backend Health ===`);
  for (const n of names) {
    const backend = registry.get(n);
    let result;
    try {
      result = await backend.health();
    } catch (error) {
      console.log(`  ✗ ${n}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    console.log(`  ${result.healthy ? "✓" : "✗"} ${n} (${result.checkedAt})`);
    for (const check of result.checks) {
      console.log(`      ${check.ok ? "✔" : "✗"} ${check.name}: ${check.detail}`);
    }
  }
}
