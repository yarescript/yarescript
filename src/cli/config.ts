import * as fs from "fs";
import * as path from "path";

/**
 * config.yare is a JSON file (despite the extension) that describes a
 * yarescript project: its name, entry point, and dependencies ("libs").
 * It plays the role package.json/tsconfig.json play for JS/TS projects,
 * but for a from-scratch toolchain, this is the *only* file the `yare`
 * CLI needs to build/run a project.
 *
 * Yes, it is JSON wearing a .yare costume. The extension is for you; the
 * contents are for the parser, and the parser does not care what the file is
 * called.
 */
export interface YareConfig {
  name: string;
  version: string;
  entry: string; // path to the entry .ys file, e.g. "src/main.ys"
  outDir: string; // where compiled output goes, defaults to ".yare"
  target: "wasm";
  libs: Record<string, string>; // dependency name -> version/spec (future: npm-like registry)
}

export const DEFAULT_CONFIG_FILENAME = "config.yare";

export function defaultConfig(name: string): YareConfig {
  return {
    name,
    version: "0.1.0",
    entry: "src/main.ys",
    outDir: ".yare",
    target: "wasm",
    libs: {},
  };
}

export function findConfig(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, DEFAULT_CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(configPath: string): { config: YareConfig; root: string } {
  const raw = fs.readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${DEFAULT_CONFIG_FILENAME} is not valid JSON: ${(e as Error).message}`);
  }
  const config = parsed as Partial<YareConfig>;
  if (!config.name) throw new Error(`${DEFAULT_CONFIG_FILENAME} is missing "name"`);
  if (!config.entry) throw new Error(`${DEFAULT_CONFIG_FILENAME} is missing "entry"`);
  return {
    config: {
      name: config.name,
      version: config.version ?? "0.1.0",
      entry: config.entry,
      outDir: config.outDir ?? ".yare",
      target: "wasm",
      libs: config.libs ?? {},
    },
    root: path.dirname(configPath),
  };
}

export function writeConfig(root: string, config: YareConfig) {
  const filePath = path.join(root, DEFAULT_CONFIG_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return filePath;
}
