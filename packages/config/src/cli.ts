import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  ALLOWED_KEYS_TXT,
  DEFAULTS_ENV,
  MANIFEST_ENV,
  MANIFEST_JSON,
  allowedKeysTxt,
  buildManifest,
  defaultsEnv,
  manifestEnv,
  manifestJson,
} from "./manifest.ts";
import { checkPolicy, diffManifests } from "./policy.ts";
import { migrateLegacyEnv, parseEnvFile, renderDeployment, resolveConfig } from "./index.ts";
import type { ReleaseManifest } from "./types.ts";

interface Args {
  readonly flags: Readonly<Record<string, string>>;
  readonly positionals: readonly string[];
}

function parseArgs(argv: readonly string[]): Args {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = "true";
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function repoRoot(flags: Readonly<Record<string, string>>): string {
  return flags.root ?? process.cwd();
}

function managerVersion(root: string): string {
  const path = join(root, "manager/VERSION");
  if (!existsSync(path)) return "0.0.0";
  return readFileSync(path, "utf8").trim() || "0.0.0";
}

function writeReleaseFile(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
}

function commandGenerate(root: string): void {
  const manifest = buildManifest(managerVersion(root));
  const dir = join(root, "manager/release");
  mkdirSync(dir, { recursive: true });
  writeReleaseFile(join(dir, MANIFEST_JSON), manifestJson(manifest));
  writeReleaseFile(join(dir, MANIFEST_ENV), manifestEnv(manifest));
  writeReleaseFile(join(dir, DEFAULTS_ENV), defaultsEnv(manifest));
  writeReleaseFile(join(dir, ALLOWED_KEYS_TXT), allowedKeysTxt(manifest));
  console.log(`generated ${dir}`);
}

function commandCheckGenerated(root: string): void {
  const manifest = buildManifest(managerVersion(root));
  const dir = join(root, "manager/release");
  const expected: Record<string, string> = {
    [join(dir, MANIFEST_JSON)]: manifestJson(manifest),
    [join(dir, MANIFEST_ENV)]: manifestEnv(manifest),
    [join(dir, DEFAULTS_ENV)]: defaultsEnv(manifest),
    [join(dir, ALLOWED_KEYS_TXT)]: allowedKeysTxt(manifest),
  };
  const stale: string[] = [];
  for (const [path, content] of Object.entries(expected)) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
      stale.push(path);
    }
  }
  if (stale.length > 0) {
    fail(`stale generated release files: ${stale.join(", ")}\nrun: bun run config:generate`);
  }
  console.log("release files up to date");
}

function readManifest(path: string): ReleaseManifest {
  if (!existsSync(path)) fail(`manifest not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as ReleaseManifest;
}

function commandPolicy(flags: Readonly<Record<string, string>>, root: string): void {
  const baselinePath = flags.baseline ?? join(root, "manager/release", MANIFEST_JSON);
  if (!existsSync(baselinePath)) {
    console.log(`no baseline manifest at ${baselinePath}; skipping policy check`);
    return;
  }
  const before = readManifest(baselinePath);
  const after = buildManifest(managerVersion(root));
  const issues = checkPolicy(before, after);
  if (issues.length === 0) {
    console.log("config policy passed");
    return;
  }
  let hasError = false;
  for (const issue of issues) {
    const line = `${issue.level.toUpperCase()} ${issue.key}: ${issue.message}`;
    if (issue.level === "error") {
      hasError = true;
      console.error(line);
    } else {
      console.warn(line);
    }
  }
  if (hasError) process.exit(1);
}

function commandDiff(flags: Readonly<Record<string, string>>, root: string): void {
  const baselinePath = flags.baseline ?? join(root, "manager/release", MANIFEST_JSON);
  if (!existsSync(baselinePath)) {
    console.log(`no baseline manifest at ${baselinePath}`);
    return;
  }
  const before = readManifest(baselinePath);
  const after = buildManifest(managerVersion(root));
  console.log(JSON.stringify(diffManifests(before, after), null, 2));
}

function commandRender(flags: Readonly<Record<string, string>>): void {
  const operatorPath = flags.operator ?? "/etc/tokenpanel/tokenpanel.yml";
  const templatesDir = flags.templates ?? "/app/manager/templates";
  const outDir = flags.out ?? "/etc/tokenpanel/generated";
  const dataDir = flags["data-dir"] ?? "/var/tokenpanel/shared";
  const generatedConfigDir = flags["generated-config-dir"] ?? outDir;
  const result = renderDeployment({
    operatorPath,
    legacyEnvPath: flags["legacy-env"],
    templatesDir,
    outDir,
    dataDir,
    generatedConfigDir,
    imageTag: flags["image-tag"],
    releaseVersion: flags["release-version"],
    managerVersion: flags["manager-version"],
    writeOperatorIfMissing: flags["write-operator"] !== "false",
  });
  console.log(`rendered ${result.mode} config to ${outDir}`);
  for (const file of result.files) console.log(`  ${file}`);
}

function commandMigrateLegacy(flags: Readonly<Record<string, string>>): void {
  const legacy = flags["legacy-env"] ?? "/etc/tokenpanel/.env";
  const out = flags.out ?? "/etc/tokenpanel/tokenpanel.yml";
  if (!existsSync(legacy)) fail(`legacy env not found: ${legacy}`);
  const operator = migrateLegacyEnv(parseEnvFile(readFileSync(legacy, "utf8")));
  writeFileSync(out, yamlStringify(operator), "utf8");
  chmodSync(out, 0o600);
  console.log(`migrated ${legacy} -> ${out}`);
}

function commandCheck(flags: Readonly<Record<string, string>>): void {
  const operatorPath = flags.operator ?? "/etc/tokenpanel/tokenpanel.yml";
  const legacyEnvPath = flags["legacy-env"] ?? "/etc/tokenpanel/.env";
  let operator: unknown = undefined;
  if (existsSync(operatorPath)) {
    operator = yamlParse(readFileSync(operatorPath, "utf8"));
  }
  const legacyEnv = existsSync(legacyEnvPath)
    ? parseEnvFile(readFileSync(legacyEnvPath, "utf8"))
    : {};
  const resolved = resolveConfig({ operator, legacyEnv });
  console.log(`config ok (${resolved.mode})`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const root = repoRoot(args.flags);

  switch (command) {
    case "generate":
      commandGenerate(root);
      break;
    case "check-generated":
      commandCheckGenerated(root);
      break;
    case "policy":
      commandPolicy(args.flags, root);
      break;
    case "diff":
      commandDiff(args.flags, root);
      break;
    case "render":
      commandRender(args.flags);
      break;
    case "migrate-legacy":
      commandMigrateLegacy(args.flags);
      break;
    case "check":
      commandCheck(args.flags);
      break;
    default:
      fail(
        "usage: config <generate|check-generated|policy|diff|render|migrate-legacy|check> [flags]",
      );
  }
}

main();
