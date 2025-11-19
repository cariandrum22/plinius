import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

/**
 * Environment variables interface
 */
interface Env {
  OPENROUTER_API_KEY?: string;
}

/**
 * Type-safe access to environment variables
 */
export const env: Env = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
};

/**
 * Validate that required environment variables are set
 */
export function validateEnv(requiredVars: (keyof Env)[]): void {
  const missing = requiredVars.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}
