import { readFile } from "fs/promises";
import { join } from "path";
import { RawModelsResponseSchema, CatalogSnapshot } from "../../src/catalog/schema.js";
import { buildSnapshot } from "../../src/catalog/snapshot.js";

export const FIXTURE = join(process.cwd(), "test", "fixtures", "openrouter-models.json");
export const FETCHED_AT = "2026-07-20T00:00:00.000Z";
export const NOW_MS = Date.parse("2026-07-20T00:00:00Z");

export const LIVE_TARGETS = [
  "moonshotai/kimi-k3",
  "openai/gpt-5.6-sol",
  "anthropic/claude-fable-5",
  "google/gemini-3.1-pro-preview",
  "x-ai/grok-4.5",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "z-ai/glm-5.2",
  "qwen/qwen3.7-max",
  "qwen/qwen3.7-plus",
  "minimax/minimax-m3",
  "moonshotai/kimi-k2.7-code",
];

export async function loadFixtureRaw(): Promise<unknown> {
  return JSON.parse(await readFile(FIXTURE, "utf-8"));
}

export async function fixtureSnapshot(): Promise<CatalogSnapshot> {
  const raw = RawModelsResponseSchema.parse(await loadFixtureRaw());
  return buildSnapshot({ rawModels: raw.data, fetchedAt: FETCHED_AT, source: "fixture" });
}
