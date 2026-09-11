import { parse } from "../parser/parser";
import { check } from "../checker/checker";
import { generateWasm } from "../codegen/codegen";
import * as N from "../ast/nodes";

/**
 * Runs a yarescript source string through the full pipeline and executes the
 * resulting WebAssembly module, capturing whatever it logs via console.log so
 * tests can assert on real program output rather than on the fact that it
 * compiled. Compiling is the easy half.
 */
export async function compileAndRun(
  source: string
): Promise<{ logs: string[]; exports: WebAssembly.Exports }> {
  return runProgram(parse(source, "<test>"));
}

/** Same pipeline, but you hand it an AST. The linker needs that. */
export async function runProgram(
  program: N.Program
): Promise<{ logs: string[]; exports: WebAssembly.Exports }> {
  const checked = check(program);
  const { wasmBinary, usedHostFunctions } = generateWasm(checked);

  const logs: string[] = [];
  let memory: WebAssembly.Memory;
  const readString = (ptr: number) => {
    const view = new DataView(memory.buffer as ArrayBuffer);
    const len = view.getUint32(ptr, true);
    const bytes = new Uint8Array(memory.buffer, ptr + 4, len);
    return Buffer.from(bytes).toString("utf8");
  };

  const env: Record<string, (...args: any[]) => any> = {
    console_log_string: (ptr: number) => logs.push(readString(ptr)),
    console_log_int: (v: number) => logs.push(String(v)),
    console_log_long: (v: bigint) => logs.push(String(v)),
    console_log_float: (v: number) => logs.push(String(v)),
    console_log_double: (v: number) => logs.push(String(v)),
    console_log_bool: (v: number) => logs.push(String(Boolean(v))),
    console_log_char: (v: number) => logs.push(String.fromCharCode(v)),
    assert: (v: number) => {
      if (!v) throw new Error("assertion failed");
    },
  };
  for (const name of usedHostFunctions) {
    if (!env[name]) env[name] = () => {};
  }

  const { instance } = await WebAssembly.instantiate(wasmBinary.slice().buffer, { env });
  memory = instance.exports.memory as WebAssembly.Memory;
  if (typeof (instance.exports as any).main === "function") {
    (instance.exports as any).main();
  }
  return { logs, exports: instance.exports };
}
