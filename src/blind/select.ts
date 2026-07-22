/**
 * Response selection strategies for blind-review generation.
 *
 * Supported: all repetitions, random sample, deterministic stratified sample by
 * (benchmark, target), and explicit run-record ids. Score-based selection
 * (best/median/worst) is intentionally NOT supported by default — it would leak
 * evaluator bias into the human-calibration set.
 */
import { LoadedRunRecord } from "../experiment/records.js";
import { LoadedBenchmark } from "../suite/loader.js";
import { SelectionConfig } from "./schema.js";

export interface FilterConfig {
  includePrototypes: boolean;
  includeInfraValidation: boolean;
  targets?: string[];
  benchmarks?: string[];
}

/** Drop records that must never enter a review set (errors, filtered-out). */
export function filterRecords(
  records: LoadedRunRecord[],
  benchmarksById: Map<string, LoadedBenchmark>,
  filter: FilterConfig,
  experimentIsInfraValidation: boolean,
): LoadedRunRecord[] {
  if (!filter.includeInfraValidation && experimentIsInfraValidation) return [];

  return records.filter(({ record }) => {
    if (!record.response) return false; // nothing to review
    const isPrototype =
      record.benchmark.prototype ??
      benchmarksById.get(record.benchmark.id)?.definition.prototype ??
      false;
    if (!filter.includePrototypes && isPrototype) return false;
    if (filter.targets && !filter.targets.includes(record.targetId)) return false;
    if (filter.benchmarks && !filter.benchmarks.includes(record.benchmark.id)) return false;
    return true;
  });
}

function groupKey(r: LoadedRunRecord): string {
  return `${r.record.benchmark.id}::${r.record.targetId}`;
}

function groupByTargetBenchmark(records: LoadedRunRecord[]): Map<string, LoadedRunRecord[]> {
  const groups = new Map<string, LoadedRunRecord[]>();
  for (const r of records) {
    const key = groupKey(r);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  // Stable ordering within a group by repetition index then id.
  for (const list of groups.values()) {
    list.sort(
      (a, b) =>
        (a.record.repetitionIndex ?? 0) - (b.record.repetitionIndex ?? 0) ||
        a.runRecordId.localeCompare(b.runRecordId),
    );
  }
  return groups;
}

/** Deterministic stratified pick: evenly spaced across the sorted group. */
function stratifiedPick(list: LoadedRunRecord[], count: number): LoadedRunRecord[] {
  if (count >= list.length) return list;
  const picked: LoadedRunRecord[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor((i * list.length) / count);
    picked.push(list[idx]);
  }
  return picked;
}

/**
 * Select records according to the configured strategy. `rng` is used only by
 * the random mode; all other modes are deterministic.
 */
export function selectRecords(
  records: LoadedRunRecord[],
  selection: SelectionConfig,
  rng: () => number,
): LoadedRunRecord[] {
  switch (selection.mode) {
    case "all":
      return records;

    case "explicit": {
      const wanted = new Set(selection.runRecordIds ?? []);
      return records.filter((r) => wanted.has(r.runRecordId));
    }

    case "random": {
      const count = selection.countPerTargetBenchmark ?? 1;
      const out: LoadedRunRecord[] = [];
      for (const list of groupByTargetBenchmark(records).values()) {
        // Seeded Fisher–Yates on a copy, then take `count`.
        const copy = list.slice();
        for (let i = copy.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        out.push(...copy.slice(0, count));
      }
      return out;
    }

    case "stratified": {
      const count = selection.countPerTargetBenchmark ?? 1;
      const out: LoadedRunRecord[] = [];
      for (const list of groupByTargetBenchmark(records).values()) {
        out.push(...stratifiedPick(list, count));
      }
      return out;
    }
  }
}
