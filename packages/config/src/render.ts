import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { CONFIG_FIELDS } from "./fields.ts";
import {
  ALLOWED_KEYS_TXT,
  DEFAULTS_ENV,
  allowedKeysTxt,
  buildManifest,
  defaultsEnv,
  manifestEnv,
  MANIFEST_ENV,
} from "./manifest.ts";
import { migrateLegacyEnv, resolveConfig, type ResolvedConfig } from "./resolve.ts";
import { ConfigResolutionError } from "./types.ts";

export interface RenderOptions {
  readonly operatorPath: string;
  readonly legacyEnvPath?: string | undefined;
  readonly templatesDir: string;
  readonly outDir: string;
  readonly dataDir: string;
  readonly generatedConfigDir: string;
  readonly imageTag?: string | undefined;
  readonly releaseVersion?: string | undefined;
  readonly managerVersion?: string | undefined;
  readonly writeOperatorIfMissing?: boolean | undefined;
}

export interface RenderResult {
  readonly mode: "caddy" | "direct";
  readonly files: readonly string[];
  readonly configHash: string;
}

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function substituteTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  return template.replace(
    /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?}/g,
    (match, name: string, _group: string | undefined, def: string | undefined) => {
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        return vars[name] ?? "";
      }
      if (def !== undefined) return def;
      return match;
    },
  );
}

function redactedValues(resolved: ResolvedConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of CONFIG_FIELDS) {
    const value = resolved.values[field.key];
    if (value === undefined) continue;
    out[field.key] = field.secret === true ? "[redacted]" : value;
  }
  return out;
}

function writeFile(path: string, content: string, mode?: number): void {
  writeFileSync(path, content, "utf8");
  if (mode !== undefined) chmodSync(path, mode);
}

export function renderDeployment(options: RenderOptions): RenderResult {
  const writeOperator = options.writeOperatorIfMissing !== false;
  let operator: unknown = undefined;

  if (existsSync(options.operatorPath)) {
    operator = yamlParse(readFileSync(options.operatorPath, "utf8"));
  } else if (options.legacyEnvPath !== undefined && existsSync(options.legacyEnvPath)) {
    const legacy = parseEnvFile(readFileSync(options.legacyEnvPath, "utf8"));
    operator = migrateLegacyEnv(legacy);
    if (writeOperator) {
      mkdirSync(dirname(options.operatorPath), { recursive: true });
      writeFile(options.operatorPath, yamlStringify(operator), 0o600);
    }
  } else {
    throw new ConfigResolutionError([
      {
        key: "operatorConfig",
        reason: `missing ${options.operatorPath} and no legacy .env provided`,
      },
    ]);
  }

  const legacyEnv =
    options.legacyEnvPath !== undefined && existsSync(options.legacyEnvPath)
      ? parseEnvFile(readFileSync(options.legacyEnvPath, "utf8"))
      : {};

  const resolved = resolveConfig({ operator, legacyEnv });
  mkdirSync(options.outDir, { recursive: true });

  const files: string[] = [];
  const composeTemplate =
    resolved.mode === "caddy" ? "app.caddy.yml.tmpl" : "app.direct.yml.tmpl";
  const composeRaw = readFileSync(join(options.templatesDir, composeTemplate), "utf8");

  const composeVars: Record<string, string> = {
    ...resolved.composeVars,
    DATA_DIR: options.dataDir,
    CONFIG_DIR: options.generatedConfigDir,
  };

  const composeBody = substituteTemplate(composeRaw, composeVars);
  const composePath = join(options.outDir, "compose.yml");
  writeFile(composePath, `name: tokenpanel\n${composeBody}`, 0o600);
  files.push(composePath);

  const envLines = Object.entries(resolved.apiEnv).map(([k, v]) => `${k}=${v}`);
  const envPath = join(options.outDir, ".env");
  writeFile(envPath, `${envLines.join("\n")}\n`, 0o600);
  files.push(envPath);

  const managerEnvLines = Object.entries(resolved.env).map(([k, v]) => `${k}=${v}`);
  const managerEnvPath = join(options.outDir, "manager.env");
  writeFile(managerEnvPath, `${managerEnvLines.join("\n")}\n`, 0o600);
  files.push(managerEnvPath);

  if (resolved.mode === "caddy") {
    const caddyRaw = readFileSync(join(options.templatesDir, "Caddyfile.tmpl"), "utf8");
    const caddyPath = join(options.outDir, "Caddyfile");
    writeFile(
      caddyPath,
      substituteTemplate(caddyRaw, {
        DOMAIN: String(resolved.values.DOMAIN ?? ""),
        ADMIN_EMAIL: String(resolved.values.ADMIN_EMAIL ?? ""),
      }),
      0o600,
    );
    files.push(caddyPath);
  }

  const managerVersion = options.managerVersion ?? "0.0.0";
  const manifest = buildManifest(managerVersion);
  const manifestEnvPath = join(options.outDir, MANIFEST_ENV);
  writeFile(manifestEnvPath, manifestEnv(manifest), 0o600);
  files.push(manifestEnvPath);

  const defaultsPath = join(options.outDir, DEFAULTS_ENV);
  writeFile(defaultsPath, defaultsEnv(manifest), 0o600);
  files.push(defaultsPath);

  const allowedPath = join(options.outDir, ALLOWED_KEYS_TXT);
  writeFile(allowedPath, allowedKeysTxt(manifest), 0o600);
  files.push(allowedPath);

  const configHash = createHash("sha256")
    .update(JSON.stringify(redactedValues(resolved)))
    .digest("hex");

  const release = {
    schema: 1,
    renderedAt: new Date().toISOString(),
    mode: resolved.mode,
    imageTag: options.imageTag ?? null,
    releaseVersion: options.releaseVersion ?? null,
    managerVersion,
    minManagerVersion: manifest.minManagerVersion,
    configHash,
    files: files.map((f) => f.replace(`${options.outDir}/`, "")),
  };
  const releasePath = join(options.outDir, "release.json");
  writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`, 0o600);
  files.push(releasePath);

  return Object.freeze({ mode: resolved.mode, files, configHash });
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : ".";
}
