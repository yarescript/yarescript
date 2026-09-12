import test from "node:test";
import assert from "node:assert/strict";
import { compileAndRun } from "./helpers";
import { parse } from "../parser/parser";
import { check } from "../checker/checker";

/**
 * The numeric ladder: nine integer types, two floating point types, and the
 * rules for moving values between them. Every case here prints a real value
 * out of a real WebAssembly module, because "it compiled" is not a result.
 */

async function run(body: string): Promise<string[]> {
  const { logs } = await compileAndRun(`public function: void main() {\n${body}\n}`);
  return logs;
}

function errorFor(source: string): string {
  try {
    check(parse(source, "<test>"));
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a type error");
}

test("narrow signed integers wrap like the type says they do", async () => {
  const logs = await run(`
    let: i8 a = 100;
    a = a + 100;
    let: i16 b = 30000;
    b = b + 10000;
    console.println(a);
    console.println(b);
  `);
  assert.deepStrictEqual(logs, ["-56", "-25536"]);
});

test("narrow unsigned integers wrap from the top back to zero", async () => {
  const logs = await run(`
    let: u8 a = 250;
    a = a + 10;
    let: u16 b = 65500;
    b = b + 100;
    console.println(a);
    console.println(b);
  `);
  assert.deepStrictEqual(logs, ["4", "64"]);
});

test("unsigned zero minus one is the biggest number there is", async () => {
  const logs = await run(`
    let: u32 a = 0;
    a = a - 1;
    let: u64 b = 0;
    b = b - 1;
    console.println(a);
    console.println(b);
  `);
  assert.deepStrictEqual(logs, ["4294967295", "18446744073709551615"]);
});

test("unsigned comparisons compare unsigned", async () => {
  // 4000000000 has the top bit set, so a signed read would call it negative
  const logs = await run(`
    let: u32 big = 4000000000;
    console.println(big > 1);
    console.println(big / 1000000000);
    console.println(big % 1000000000);
  `);
  assert.deepStrictEqual(logs, ["true", "4", "0"]);
});

test("a literal is allowed in any integer type it fits", async () => {
  const logs = await run(`
    let: u8 a = 255;
    let: u16 b = 65535;
    let: u32 c = 4294967295;
    let: i8 d = -128;
    let: i16 e = -32768;
    console.println(a);
    console.println(b);
    console.println(c);
    console.println(d);
    console.println(e);
  `);
  assert.deepStrictEqual(logs, ["255", "65535", "4294967295", "-128", "-32768"]);
});

test("a literal that does not fit is refused with its range", () => {
  assert.match(errorFor(`public function: void main() { let: u8 a = 256; }`), /out of range for 'u8'/);
  assert.match(errorFor(`public function: void main() { let: i8 a = 128; }`), /out of range for 'i8'/);
  assert.match(errorFor(`public function: void main() { let: u8 a = -1; }`), /out of range for 'u8'/);
  assert.match(errorFor(`public function: void main() { let: u32 a = 4294967296; }`), /out of range for 'u32'/);
});

test("signed and unsigned do not mix without a cast", () => {
  assert.match(
    errorFor(`public function: void main() { let: u8 a = 1; let: int b = 2; console.println(a + b); }`),
    /signed/
  );
  assert.match(
    errorFor(`public function: void main() { let: u16 a = 1; let: int b = a; }`),
    /Cannot assign 'u16' to 'int'/
  );
});

test("an explicit cast crosses the sign line", async () => {
  const logs = await run(`
    let: u8 a = 200;
    let: int b = a -> int;
    let: u8 c = b -> u8;
    console.println(b);
    console.println(c);
  `);
  assert.deepStrictEqual(logs, ["200", "200"]);
});

test("widening follows the ladder inside a family", async () => {
  const logs = await run(`
    let: i8 small = 5;
    let: int bigger = small + 1;
    let: long biggest = bigger + 2;
    console.println(bigger);
    console.println(biggest);
  `);
  assert.deepStrictEqual(logs, ["6", "8"]);
});

test("shrinking needs a cast, and the cast truncates", async () => {
  const logs = await run(`
    let: int big = 300;
    let: i8 small = big -> i8;
    let: u8 tiny = big -> u8;
    console.println(small);
    console.println(tiny);
  `);
  assert.deepStrictEqual(logs, ["44", "44"]);
});

test("char is an unsigned 16 bit code unit", () => {
  assert.match(errorFor(`public function: void main() { let: char c = 65536; }`), /out of range for 'char'/);
});

test("the floating point widths still do what they did", async () => {
  const logs = await run(`
    let: float f = 1.5;
    let: double d = 3.25;
    let: double mixed = f + d;
    console.println(f);
    console.println(d);
    console.println(mixed);
  `);
  assert.deepStrictEqual(logs, ["1.5", "3.25", "4.75"]);
});

test("long keeps its 64 bits", async () => {
  const logs = await run(`
    let: long big = 9007199254740991;
    console.println(big + 1);
    console.println(big * 2);
  `);
  assert.deepStrictEqual(logs, ["9007199254740992", "18014398509481982"]);
});

test("console.println has an overload for every type", async () => {
  const logs = await run(`
    console.println(true);
    console.println(65 -> char);
    console.println("hi");
    let: i8 a = -8;
    let: i16 b = -16;
    let: u8 c = 8;
    let: u16 d = 16;
    let: u32 e = 32;
    let: u64 f = 64;
    let: int g = 7;
    let: long h = 640;
    let: float i = 0.5;
    let: double j = 0.25;
    console.println(a);
    console.println(b);
    console.println(c);
    console.println(d);
    console.println(e);
    console.println(f);
    console.println(g);
    console.println(h);
    console.println(i);
    console.println(j);
  `);
  assert.deepStrictEqual(logs, [
    "true",
    "A",
    "hi",
    "-8",
    "-16",
    "8",
    "16",
    "32",
    "64",
    "7",
    "640",
    "0.5",
    "0.25",
  ]);
});

test("an unsigned counter can walk a whole byte", async () => {
  const logs = await run(`
    let: u8 i = 0;
    let: int count = 0;
    while (i < 10) {
      i = i + 2;
      count = count + 1;
    }
    console.println(i);
    console.println(count);
  `);
  assert.deepStrictEqual(logs, ["10", "5"]);
});

test("incrementing a narrow integer stays inside it", async () => {
  const logs = await run(`
    let: i8 a = 127;
    a++;
    let: u8 b = 255;
    b++;
    let: i16 c = -32768;
    c--;
    console.println(a);
    console.println(b);
    console.println(c);
  `);
  assert.deepStrictEqual(logs, ["-128", "0", "32767"]);
});

test("compound assignment normalizes too", async () => {
  const logs = await run(`
    let: u8 a = 250;
    a += 20;
    let: i8 b = 120;
    b += 20;
    console.println(a);
    console.println(b);
  `);
  assert.deepStrictEqual(logs, ["14", "-116"]);
});

test("a type that does not exist is still refused", () => {
  assert.match(errorFor(`public function: void main() { let: int8 a = 1; }`), /Unknown type 'int8'/);
});
