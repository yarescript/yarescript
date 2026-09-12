import assert from "node:assert";
import { test } from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse } from "../parser/parser";
import { check, TypeError_ } from "../checker/checker";
import { generateWasm } from "../codegen/codegen";
import { resolveModules, ModuleError } from "../modules/resolve";
import { compileAndRun } from "./helpers";

// ---------------------------------------------------------------------------
// Strings. Concatenation and comparison run on a tiny bump allocator that
// codegen installs only when a program actually uses them.
// ---------------------------------------------------------------------------

test("string concatenation", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      console.println("hello, " + "world");
    }
  `);
  assert.deepStrictEqual(logs, ["hello, world"]);
});

test("string concatenation chains and reuses variables", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: string a = "yare";
      let: string b = a + "script" + "!";
      console.println(b);
      console.println(a);
    }
  `);
  assert.deepStrictEqual(logs, ["yarescript!", "yare"]);
});

test("string concatenation in a loop grows memory", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: string s = "abcdefghij";
      for (let: int i = 0; i < 12; i++) { s = s + s; }
      console.println(s == s);
    }
  `);
  assert.deepStrictEqual(logs, ["true"]);
});

test("string equality compares bytes, not pointers", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: string a = "same";
      console.println(a == "same");
      console.println("same" != "other");
      console.println("a" == "ab");
      console.println(("ab" + "c") == ("a" + "bc"));
    }
  `);
  assert.deepStrictEqual(logs, ["true", "true", "false", "true"]);
});

test("&& and || short-circuit, so a guard can protect an index", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: string s = "ab";
      let: int i = 2;
      // the right side must not run: s[2] is out of bounds
      if (i < s.length && s[i] == (97 -> char)) {
        console.println("matched");
      } else {
        console.println("guarded");
      }
      let: bool yes = true;
      let: bool no = false;
      console.println(yes && no);
      console.println(yes || no);
      console.println(no || yes);
      console.println(no && yes);
    }
  `);
  assert.deepStrictEqual(logs, ["guarded", "false", "true", "true", "false"]);
});

test("strings order by code point, not by vibes", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      console.println("a" < "b");
      console.println("b" < "a");
      console.println("apple" < "apples");
      console.println("apples" <= "apples");
      console.println("Z" < "a");
      console.println("" < "anything");
    }
  `);
  assert.deepStrictEqual(logs, ["true", "false", "true", "true", "true", "true"]);
});

// ---------------------------------------------------------------------------
// Casts
// ---------------------------------------------------------------------------

test("narrowing cast truncates", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: double pi = 3.99;
      console.println(pi -> int);
      console.println(pi -> long);
      console.println(3 -> double);
      console.println(7 -> bool);
      console.println(0 -> bool);
    }
  `);
  assert.deepStrictEqual(logs, ["3", "3", "3", "true", "false"]);
});

test("cast binds tighter than arithmetic", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      console.println(2.5 + 1 -> int);
      console.println((2.5 + 1) -> int);
    }
  `);
  assert.deepStrictEqual(logs, ["3.5", "3"]);
});

test("a string cannot be written into", () => {
  assert.throws(
    () =>
      check(parse(`
      public function: void main() {
        let: string s = "yare";
        s[0] = (89 -> char);
      }
    `)),
    (e: Error) => e instanceof TypeError_ && /cannot be written into/.test(e.message)
  );
});

test("casting a string is a type error", () => {
  assert.throws(() => {
    check(parse(`
      public function: void main() {
        let: int n = "nope" -> int;
      }
    `));
  }, TypeError_);
});

test("implicit narrowing is still a type error", () => {
  assert.throws(() => {
    check(parse(`
      public function: void main() {
        let: int n = 3.99;
      }
    `));
  }, TypeError_);
});

// ---------------------------------------------------------------------------
// char, long literals, and mixed-width arithmetic
// ---------------------------------------------------------------------------

test("char holds a code unit and prints as a letter", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: char c = 72 -> char;
      console.println(c);
      console.println(c -> int);
    }
  `);
  assert.deepStrictEqual(logs, ["H", "72"]);
});

test("integer literals wider than i32 become long", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: long a = 3000000000;
      let: long b = 5000000000;
      console.println(a);
      console.println(b);
      console.println(a + b);
    }
  `);
  assert.deepStrictEqual(logs, ["3000000000", "5000000000", "8000000000"]);
});

test("a literal that does not fit an int cannot be assigned to one", () => {
  assert.throws(() => {
    check(parse(`
      public function: void main() {
        let: int n = 3000000000;
      }
    `));
  }, TypeError_);
});

test("mixed-width arithmetic widens the narrower operand", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: double x = 1.5;
      console.println(x + 1);
      let: long y = 2;
      console.println(y * 3.5);
    }
  `);
  assert.deepStrictEqual(logs, ["2.5", "7"]);
});

// ---------------------------------------------------------------------------
// export, assert, reserved names
// ---------------------------------------------------------------------------

test("export is another spelling of public", async () => {
  const { logs, exports } = await compileAndRun(`
    export function: int double(int x) { return x * 2; }
    public function: void main() { console.println(double(21)); }
  `);
  assert.deepStrictEqual(logs, ["42"]);
  assert.strictEqual(typeof (exports as any).double, "function");
});

test("assert(true) is quiet and assert(false) traps", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() { assert(1 + 1 == 2); console.println("survived"); }
  `);
  assert.deepStrictEqual(logs, ["survived"]);

  await assert.rejects(
    compileAndRun(`public function: void main() { assert(1 == 2); }`),
    /assertion failed/
  );
});

test("runtime helper names are reserved", () => {
  assert.throws(() => {
    check(parse(`
      public function: int __yare_alloc(int x) { return x; }
      public function: void main() { console.println(__yare_alloc(1)); }
    `));
  }, /reserved for the yarescript runtime/);
});

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

test("imports pull in declarations from another file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yare-mod-"));
  fs.writeFileSync(
    path.join(dir, "math.ys"),
    `public function: int square(int x) { return x * x; }\n`
  );
  fs.writeFileSync(
    path.join(dir, "main.ys"),
    `import { square } from "./math.ys";\npublic function: void main() { console.println(square(9)); }\n`
  );

  const { program, files } = resolveModules(path.join(dir, "main.ys"));
  assert.strictEqual(files.length, 2);
  assert.strictEqual(files[0], path.join(dir, "math.ys"));

  const { wasmBinary } = generateWasm(check(program));
  const { instance } = await WebAssembly.instantiate(wasmBinary.slice().buffer, {
    env: { console_println_int: () => {} },
  });
  assert.strictEqual((instance.exports as any).square(9), 81);
});

test("importing a name the file does not define is an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yare-mod-"));
  fs.writeFileSync(path.join(dir, "math.ys"), `public function: int square(int x) { return x * x; }\n`);
  fs.writeFileSync(
    path.join(dir, "main.ys"),
    `import { cube } from "./math.ys";\npublic function: void main() { console.println(1); }\n`
  );
  assert.throws(() => resolveModules(path.join(dir, "main.ys")), /does not define 'cube'/);
});

test("circular imports are reported, not hung on", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yare-mod-"));
  fs.writeFileSync(path.join(dir, "a.ys"), `import { b } from "./b.ys";\npublic function: int a() { return 1; }\n`);
  fs.writeFileSync(path.join(dir, "b.ys"), `import { a } from "./a.ys";\npublic function: int b() { return 2; }\n`);
  assert.throws(() => resolveModules(path.join(dir, "a.ys")), ModuleError);
});

test("a diamond import compiles the shared file once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yare-mod-"));
  fs.writeFileSync(path.join(dir, "base.ys"), `public function: int base() { return 1; }\n`);
  fs.writeFileSync(path.join(dir, "left.ys"), `import { base } from "./base.ys";\npublic function: int left() { return base(); }\n`);
  fs.writeFileSync(path.join(dir, "right.ys"), `import { base } from "./base.ys";\npublic function: int right() { return base(); }\n`);
  fs.writeFileSync(
    path.join(dir, "main.ys"),
    `import { left } from "./left.ys";\nimport { right } from "./right.ys";\npublic function: void main() { console.println(left() + right()); }\n`
  );
  const { files } = resolveModules(path.join(dir, "main.ys"));
  assert.strictEqual(files.filter((f) => f.endsWith("base.ys")).length, 1);
});
