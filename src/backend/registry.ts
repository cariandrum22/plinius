/**
 * Backend registry.
 *
 * Backends are obtained through the registry so CLI/commands never depend on a
 * concrete backend implementation. Factories are lazy so constructing the
 * registry does not require network access or credentials.
 */
import { ExecutionBackend } from "./interface.js";

export const DEFAULT_BACKEND = "openrouter";

export type BackendFactory = () => ExecutionBackend;

export class BackendRegistry {
  private readonly factories = new Map<string, BackendFactory>();

  register(name: string, factory: BackendFactory): void {
    this.factories.set(name, factory);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  list(): string[] {
    return [...this.factories.keys()].sort();
  }

  /** Instantiate a backend by name (default when omitted). */
  get(name: string = DEFAULT_BACKEND): ExecutionBackend {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Unknown backend "${name}". Available: ${this.list().join(", ") || "(none)"}`);
    }
    return factory();
  }
}
