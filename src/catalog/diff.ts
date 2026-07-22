/**
 * Snapshot diffing: what changed between two catalog snapshots.
 */
import { CatalogSnapshot, NormalizedModel } from "./schema.js";

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ModelChange {
  id: string;
  changes: FieldChange[];
}

export interface CatalogDiff {
  fromSnapshotId: string;
  toSnapshotId: string;
  added: string[];
  removed: string[];
  changed: ModelChange[];
  /** Models present in `to` that carry an expiration date. */
  expired: string[];
}

function compareModel(a: NormalizedModel, b: NormalizedModel): FieldChange[] {
  const changes: FieldChange[] = [];
  const push = (field: string, from: unknown, to: unknown) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ field, from, to });
  };
  push("canonicalSlug", a.canonicalSlug, b.canonicalSlug);
  push("contextLength", a.contextLength, b.contextLength);
  push("pricing.prompt", a.pricing.prompt, b.pricing.prompt);
  push("pricing.completion", a.pricing.completion, b.pricing.completion);
  push("supportedParameters", [...a.supportedParameters].sort(), [...b.supportedParameters].sort());
  push("providers", a.providers.map((p) => p.providerName).sort(), b.providers.map((p) => p.providerName).sort());
  push("expirationDate", a.expirationDate, b.expirationDate);
  return changes;
}

export function diffSnapshots(from: CatalogSnapshot, to: CatalogSnapshot): CatalogDiff {
  const fromById = new Map(from.models.map((m) => [m.id, m]));
  const toById = new Map(to.models.map((m) => [m.id, m]));

  const added = to.models.filter((m) => !fromById.has(m.id)).map((m) => m.id).sort();
  const removed = from.models.filter((m) => !toById.has(m.id)).map((m) => m.id).sort();

  const changed: ModelChange[] = [];
  for (const [id, toModel] of toById) {
    const fromModel = fromById.get(id);
    if (!fromModel) continue;
    const changes = compareModel(fromModel, toModel);
    if (changes.length > 0) changed.push({ id, changes });
  }
  changed.sort((a, b) => a.id.localeCompare(b.id));

  const now = Date.now();
  const expired = to.models
    .filter((m) => m.expirationDate && Date.parse(m.expirationDate) < now)
    .map((m) => m.id)
    .sort();

  return {
    fromSnapshotId: from.snapshotId,
    toSnapshotId: to.snapshotId,
    added,
    removed,
    changed,
    expired,
  };
}
