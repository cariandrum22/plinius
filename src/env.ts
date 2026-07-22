import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

/**
 * Known environment variables used by Plinius. Backends may reference
 * additional, deployment-specific variables (e.g. VLLM_API_KEY) resolved
 * dynamically via {@link resolveEnv}.
 */
interface Env {
  OPENROUTER_API_KEY?: string;
}

/**
 * Type-safe access to well-known environment variables.
 */
export const env: Env = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
};

/**
 * Resolve an arbitrary environment variable by name. Used by backend
 * configuration (`apiKeyEnv`) so credentials stay in the environment and are
 * never written into configuration or artifacts.
 */
export function resolveEnv(name: string): string | undefined {
  return process.env[name];
}

/**
 * Validate that required environment variables are set.
 */
export function validateEnv(requiredVars: string[]): void {
  const missing = requiredVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }
}
