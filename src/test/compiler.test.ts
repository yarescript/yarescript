import assert from "node:assert";
import { test } from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse } from "../parser/parser";
import { check, TypeError_ } from "../checker/checker";
import { generateWasm } from "../codegen/codegen";
import { ParseError } from "../parser/parser";

/**
 * Runs a yarescript source string through the full pipeline and executes
 * the resulting WebAssembly module, capturing whatever it logs via
 * console.log so the tests can assert on real program output, not just
 * on the fact that it compiled.
 */
async function compileAndRun(source: string): Promise<{ logs: string[]; exports: WebAssembly.Exports }> {
  const program = parse(source, "<test>");
  const checked = check(program);
  const { wasmBinary, usedHostFunctions } = generateWasm(checked);

  const logs: string[] = [];
  let memory: WebAssembly.Memory;
  const readString = (ptr: number) => {
    const view = new DataView((memory.buffer as ArrayBuffer));
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

test("hello world prints a string", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      console.log("hello, world");
    }
  `);
  assert.deepStrictEqual(logs, ["hello, world"]);
});

test("arithmetic, recursion, and int math", async () => {
  const { logs } = await compileAndRun(`
    public function: int fib(int n) {
      if (n < 2) { return n; }
      return fib(n - 1) + fib(n - 2);
    }
    public function: void main() {
      console.log(fib(10));
    }
  `);
  assert.deepStrictEqual(logs, ["55"]);
});

test("for loop with += accumulates correctly", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: int total = 0;
      for (let: int i = 1; i <= 100; i++) {
        total += i;
      }
      console.log(total);
    }
  `);
  assert.deepStrictEqual(logs, ["5050"]);
});

test("while with break and continue", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: int i = 0;
      while (true) {
        i = i + 1;
        if (i == 3) { continue; }
        if (i > 5) { break; }
        console.log(i);
      }
    }
  `);
  assert.deepStrictEqual(logs, ["1", "2", "4", "5"]);
});

test("bool and comparison operators", async () => {
  const { logs } = await compileAndRun(`
    public function: bool isEven(int n) { return n % 2 == 0; }
    public function: void main() {
      console.log(isEven(4));
      console.log(isEven(7));
    }
  `);
  assert.deepStrictEqual(logs, ["true", "false"]);
});

test("double arithmetic widens int literals", async () => {
  const { logs } = await compileAndRun(`
    public function: double average(double a, double b) {
      const: double two = 2.0;
      return (a + b) / two;
    }
    public function: void main() {
      console.log(average(3.5, 4.5));
    }
  `);
  assert.deepStrictEqual(logs, ["4"]);
});

test("private functions are not exported", async () => {
  const { exports } = await compileAndRun(`
    private function: int helper(int x) { return x * 2; }
    public function: void main() { console.log(helper(21)); }
  `);
  assert.strictEqual((exports as any).helper, undefined);
  assert.strictEqual(typeof (exports as any).main, "function");
});

test("const reassignment is a type error", () => {
  assert.throws(() => {
    const program = parse(`
      public function: void main() {
        const: int x = 1;
        x = 2;
      }
    `);
    check(program);
  }, TypeError_);
});

test("type mismatch on declaration is a type error", () => {
  assert.throws(() => {
    const program = parse(`
      public function: void main() {
        let: int x = "oops";
      }
    `);
    check(program);
  }, TypeError_);
});

test("missing main is a type error", () => {
  assert.throws(() => {
    const program = parse(`
      public function: void notMain() {}
    `);
    check(program);
  }, TypeError_);
});

test("unterminated string is a lex error", () => {
  assert.throws(() => {
    parse(`
      public function: void main() {
        console.log("unterminated);
      }
    `);
  });
});

test("bad syntax is a parse error", () => {
  assert.throws(() => {
    parse(`
      public function void main() { }
    `);
  }, ParseError);
});

test("postfix increment returns the pre-increment value", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: int i = 5;
      console.log(i++);
      console.log(i);
    }
  `);
  assert.deepStrictEqual(logs, ["5", "6"]);
});

test("prefix increment returns the post-increment value", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: int i = 5;
      console.log(++i);
      console.log(i);
    }
  `);
  assert.deepStrictEqual(logs, ["6", "6"]);
});
