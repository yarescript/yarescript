import { check } from "../checker/checker";
import { generateWasm } from "../codegen/codegen";
import { resolveModules } from "../modules/resolve";
import * as N from "../ast/nodes";

export interface TestResult {
  name: string;
  file: string;
  ok: boolean;
  error?: string;
}

/**
 * Runs every `public function` whose name starts with `test` in a `.ys` file.
 *
 * A test passes by not blowing up. Fail it with `assert(cond)`, which throws in
 * the host and traps the module, or just return something and let a divide by
 * zero do the talking. Either way, silence means success, which is the same
 * contract every other test runner on earth uses.
 */
export async function runTestFile(file: string): Promise<TestResult[]> {
  const { program } = resolveModules(file);

  // A test file is allowed to have no main(). The checker insists on one, so
  // the runner donates a do-nothing main and nobody has to argue about it.
  if (!program.body.some((d) => d.kind === "FunctionDecl" && d.name === "main")) {
    const empty: N.FunctionDecl = {
      kind: "FunctionDecl",
      name: "main",
      visibility: "private",
      returnType: { name: "void", dims: 0, line: 0, column: 0 },
      params: [],
      body: { kind: "Block", body: [], line: 0, endLine: 0 },
      line: 0,
    };
    program.body.push(empty);
  }

  const checked = check(program);
  const { wasmBinary, usedHostFunctions } = generateWasm(checked);

  let memory: WebAssembly.Memory;
  const readString = (ptr: number) => {
    const view = new DataView(memory.buffer as ArrayBuffer);
    const len = view.getUint32(ptr, true);
    const bytes = new Uint8Array(memory.buffer, ptr + 4, len);
    return Buffer.from(bytes).toString("utf8");
  };

  const env: Record<string, (...args: any[]) => any> = {
    console_println_string: (ptr: number) => console.log(readString(ptr)),
    console_println_int: (v: number) => console.log(v),
    console_println_uint: (v: number) => console.log(v >>> 0),
    console_println_long: (v: bigint) => console.log(v.toString()),
    console_println_ulong: (v: bigint) => console.log((v < 0n ? v + (1n << 64n) : v).toString()),
    console_println_float: (v: number) => console.log(v),
    console_println_double: (v: number) => console.log(v),
    console_println_bool: (v: number) => console.log(Boolean(v)),
    console_println_char: (v: number) => console.log(String.fromCharCode(v)),
    assert: (v: number) => {
      if (!v) throw new Error("assertion failed");
    },
  };
  for (const name of usedHostFunctions) {
    if (!env[name]) env[name] = () => {};
  }

  const { instance } = await WebAssembly.instantiate(wasmBinary.slice().buffer, { env });
  memory = instance.exports.memory as WebAssembly.Memory;
  const exports = instance.exports as Record<string, unknown>;

  const names = [...checked.functions.entries()]
    .filter(([name, sig]) => sig.visibility === "public" && name.startsWith("test"))
    .map(([name]) => name);

  const results: TestResult[] = [];
  for (const name of names) {
    try {
      (exports[name] as () => void)();
      results.push({ name, file, ok: true });
    } catch (err) {
      results.push({ name, file, ok: false, error: (err as Error).message ?? String(err) });
    }
  }
  return results;
}
