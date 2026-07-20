import type { ManifestField, ReleaseManifest } from "./types.ts";

export type PolicyLevel = "error" | "warn";

export interface PolicyIssue {
  readonly level: PolicyLevel;
  readonly key: string;
  readonly message: string;
}

export interface ManifestChange {
  readonly key: string;
  readonly before: ManifestField;
  readonly after: ManifestField;
  readonly changedProps: readonly string[];
}

export interface ManifestDiff {
  readonly added: readonly ManifestField[];
  readonly removed: readonly ManifestField[];
  readonly changed: readonly ManifestChange[];
}

function indexBy(fields: readonly ManifestField[]): Map<string, ManifestField> {
  const map = new Map<string, ManifestField>();
  for (const field of fields) map.set(field.key, field);
  return map;
}

function diffField(before: ManifestField, after: ManifestField): readonly string[] {
  const props = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  const beforeRecord = before as unknown as Record<string, unknown>;
  const afterRecord = after as unknown as Record<string, unknown>;
  for (const prop of props) {
    const b = JSON.stringify(beforeRecord[prop]);
    const a = JSON.stringify(afterRecord[prop]);
    if (b !== a) changed.push(prop);
  }
  return changed;
}

export function diffManifests(before: ReleaseManifest, after: ReleaseManifest): ManifestDiff {
  const beforeMap = indexBy(before.fields);
  const afterMap = indexBy(after.fields);

  const added: ManifestField[] = [];
  const removed: ManifestField[] = [];
  const changed: ManifestChange[] = [];

  for (const field of after.fields) {
    const old = beforeMap.get(field.key);
    if (old === undefined) added.push(field);
  }
  for (const field of before.fields) {
    const next = afterMap.get(field.key);
    if (next === undefined) removed.push(field);
  }
  for (const field of after.fields) {
    const old = beforeMap.get(field.key);
    if (old === undefined) continue;
    const changedProps = diffField(old, field).filter((p) => p !== "since");
    if (changedProps.length > 0) {
      changed.push({ key: field.key, before: old, after: field, changedProps });
    }
  }

  return Object.freeze({ added, removed, changed });
}

export function checkPolicy(before: ReleaseManifest, after: ReleaseManifest): readonly PolicyIssue[] {
  const diff = diffManifests(before, after);
  const issues: PolicyIssue[] = [];

  for (const field of diff.added) {
    if (field.required && !field.derived && field.default === undefined) {
      issues.push({
        level: "error",
        key: field.key,
        message:
          "new required config without a default breaks updates; add a default or introduce it as optional",
      });
    }
  }

  for (const field of diff.removed) {
    if (field.deprecatedSince === undefined) {
      issues.push({
        level: "error",
        key: field.key,
        message:
          "removing an undePRECATED config key breaks existing installs; mark deprecatedSince first and ship a compatibility release",
      });
    }
  }

  for (const change of diff.changed) {
    const { before: old, after: next, changedProps } = change;

    if (changedProps.includes("kind")) {
      issues.push({
        level: "error",
        key: next.key,
        message: `config kind changed from ${old.kind} to ${next.kind}; ship a new key instead`,
      });
    }
    if (changedProps.includes("secret")) {
      issues.push({
        level: "error",
        key: next.key,
        message: "secret flag changed; this can leak or lose operator secrets",
      });
    }
    if (
      changedProps.includes("required") &&
      old.required === false &&
      next.required === true &&
      next.default === undefined &&
      !next.derived
    ) {
      issues.push({
        level: "error",
        key: next.key,
        message: "optional config became required without a default; updates will fail",
      });
    }
    if (changedProps.includes("default")) {
      issues.push({
        level: "warn",
        key: next.key,
        message: `default changed from ${JSON.stringify(old.default)} to ${JSON.stringify(next.default)}`,
      });
    }
    if (changedProps.includes("validation")) {
      issues.push({
        level: "warn",
        key: next.key,
        message: "validation rules changed; existing operator values may become invalid",
      });
    }
  }

  return issues;
}
