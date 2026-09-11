#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { build } from "../compiler";
import { defaultConfig, findConfig, loadConfig, writeConfig, DEFAULT_CONFIG_FILENAME } from "./config";
import { LexError } from "../lexer/lexer";
import { ParseError } from "../parser/parser";
import { TypeError_ } from "../checker/checker";

const VERSION = "0.1.0";

function usage() {
  console.log(`yarescript ${VERSION} - a compiled language for the web. Compiles .ys source to WebAssembly.

Usage:
  yare init [name]        Scaffold a new yarescript project (writes ${DEFAULT_CONFIG_FILENAME})
  yare build [--wat]      Compile the project entry to WebAssembly + a tiny JS loader
  yare run [--wat]        Build, then execute the compiled program in Node
  yare version            Print the compiler version

yarescript is written by Arunkumar (github.com/Seigh-sword) and maintained
by Surya (github.com/suripewepedie).
`);
}

function fail(message: string): never {
  console.error(`\x1b[31merror:\x1b[0m ${message}`);
  process.exit(1);
}

function loadProjectConfig() {
  const configPath = findConfig(process.cwd());
  if (!configPath) {
    fail(`No ${DEFAULT_CONFIG_FILENAME} found. Run "yare init" to create one.`);
  }
  return loadConfig(configPath!);
}

function cmdInit(name?: string) {
  const configPathExisting = path.join(process.cwd(), DEFAULT_CONFIG_FILENAME);
  if (fs.existsSync(configPathExisting)) {
    fail(`${DEFAULT_CONFIG_FILENAME} already exists in this directory.`);
  }
  const projectName = name ?? path.basename(process.cwd());
  const config = defaultConfig(projectName);
  writeConfig(process.cwd(), config);

  const entryDir = path.dirname(path.join(process.cwd(), config.entry));
  fs.mkdirSync(entryDir, { recursive: true });
  const entryFile = path.join(process.cwd(), config.entry);
  if (!fs.existsSync(entryFile)) {
    fs.writeFileSync(
      entryFile,
      `public function: void main() {\n    console.log("hello, world");\n}\n`
    );
  }

  console.log(`Created ${DEFAULT_CONFIG_FILENAME} and ${config.entry}`);
  console.log(`Next: yare build`);
}

function cmdBuild(flags: Set<string>) {
  const { config, root } = loadProjectConfig();
  try {
    const result = build({ root, config, emitWat: flags.has("--wat") });
    console.log(`Compiled ${config.entry} -> ${path.relative(root, result.wasmPath)}`);
    console.log(`Loader:   ${path.relative(root, result.loaderPath)}`);
    if (result.watPath) console.log(`WAT:      ${path.relative(root, result.watPath)}`);
    console.log(`Exports:  ${result.exportedFunctions.join(", ") || "(none)"}`);
  } catch (err) {
    reportCompileError(err);
  }
}

async function cmdRun(flags: Set<string>) {
  const { config, root } = loadProjectConfig();
  try {
    const result = build({ root, config, emitWat: flags.has("--wat") });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadYarescriptModule } = require(result.loaderPath);
    const mod = await loadYarescriptModule();
    if (typeof mod.main !== "function") {
      fail(`Entry file has no public "main" function to run.`);
    }
    mod.main();
  } catch (err) {
    reportCompileError(err);
  }
}

function reportCompileError(err: unknown): never {
  if (err instanceof LexError || err instanceof ParseError || err instanceof TypeError_) {
    fail(err.message);
  }
  throw err;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.filter((a) => !a.startsWith("--"));

  switch (cmd) {
    case "init":
      cmdInit(positional[0]);
      break;
    case "build":
      cmdBuild(flags);
      break;
    case "run":
      await cmdRun(flags);
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("\x1b[31mInternal compiler error:\x1b[0m", err);
  process.exit(1);
});
