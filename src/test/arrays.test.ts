import test from "node:test";
import assert from "node:assert/strict";
import { compileAndRun } from "./helpers";
import { parse } from "../parser/parser";
import { check } from "../checker/checker";

/**
 * Arrays: `[1, 2, 3]` and `new int[5]`, indexed with bounds checks, stored in
 * linear memory with their element count in front. Every case here runs real
 * WebAssembly, because a type checker agreeing with you is not the same thing
 * as a program working.
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

test("an array literal can be read back", async () => {
  const logs = await run(`
    let: int[] xs = [10, 20, 30];
    console.println(xs.length);
    console.println(xs[0]);
    console.println(xs[1]);
    console.println(xs[2]);
  `);
  assert.deepStrictEqual(logs, ["3", "10", "20", "30"]);
});

test("writing a slot changes the array, not a copy of it", async () => {
  const logs = await run(`
    let: int[] xs = [1, 2, 3];
    xs[1] = 99;
    console.println(xs[0]);
    console.println(xs[1]);
    console.println(xs[2]);
  `);
  assert.deepStrictEqual(logs, ["1", "99", "3"]);
});

test("new int[n] is zero filled", async () => {
  const logs = await run(`
    let: int[] xs = new int[4];
    let: int i = 0;
    while (i < xs.length) {
      console.println(xs[i]);
      i++;
    }
    let: double[] ds = new double[2];
    console.println(ds[1]);
  `);
  assert.deepStrictEqual(logs, ["0", "0", "0", "0", "0"]);
});

test("reading or writing out of range traps", async () => {
  await assert.rejects(
    compileAndRun(`public function: void main() { let: int[] xs = [1, 2]; console.println(xs[2]); }`)
  );
  await assert.rejects(
    compileAndRun(`public function: void main() { let: int[] xs = [1, 2]; xs[0 - 1] = 5; }`)
  );
  await assert.rejects(
    compileAndRun(`public function: void main() { let: int[] xs = new int[0 - 1]; }`)
  );
});

test("arrays hold every element type", async () => {
  const logs = await run(`
    let: string[] names = ["ada", "grace"];
    let: double[] ds = [1.5, 2.25];
    let: long[] ls = [9007199254740991, 1];
    let: bool[] bs = [true, false];
    let: u8[] bytes = [0, 128, 255];
    let: i8[] tiny = [127, -128];
    console.println(names[0] + " " + names[1]);
    console.println(ds[1]);
    console.println(ls[0] + ls[1]);
    console.println(bs[0]);
    console.println(bytes[2]);
    console.println(tiny[1]);
  `);
  assert.deepStrictEqual(logs, ["ada grace", "2.25", "9007199254740992", "true", "255", "-128"]);
});

test("a u8 array is an actual array of bytes", async () => {
  // 300 slots of one byte each, walking the whole range and wrapping at 256
  const logs = await run(`
    let: u8[] buf = new u8[300];
    let: int i = 0;
    while (i < buf.length) {
      buf[i] = i -> u8;
      i++;
    }
    console.println(buf[255]);
    console.println(buf[256]);
    console.println(buf[299]);
  `);
  assert.deepStrictEqual(logs, ["255", "0", "43"]);
});

test("arrays go into functions and come back out", async () => {
  const { logs } = await compileAndRun(`
    public function: int total(int[] xs) {
      let: int sum = 0;
      let: int i = 0;
      while (i < xs.length) {
        sum += xs[i];
        i++;
      }
      return sum;
    }

    public function: int[] upto(int n) {
      let: int[] out = new int[n];
      let: int i = 0;
      while (i < n) {
        out[i] = i * i;
        i++;
      }
      return out;
    }

    public function: void main() {
      console.println(total([1, 2, 3, 4]));
      let: int[] squares = upto(5);
      console.println(squares.length);
      console.println(squares[4]);
    }
  `);
  assert.deepStrictEqual(logs, ["10", "5", "16"]);
});

test("compound assignment and ++ work on a slot", async () => {
  const logs = await run(`
    let: int[] xs = [1, 2, 3];
    xs[0] += 10;
    xs[1]++;
    ++xs[2];
    console.println(xs[0]);
    console.println(xs[1]);
    console.println(xs[2]);
    let: int old = xs[0]++;
    console.println(old);
    console.println(xs[0]);
  `);
  assert.deepStrictEqual(logs, ["11", "3", "4", "11", "12"]);
});

test("arrays of arrays", async () => {
  const logs = await run(`
    let: int[][] grid = [[1, 2], [3, 4], [5, 6]];
    console.println(grid.length);
    console.println(grid[0].length);
    console.println(grid[1][0]);
    grid[2][1] = 60;
    console.println(grid[2][1]);
  `);
  assert.deepStrictEqual(logs, ["3", "2", "3", "60"]);
});

test("an array of strings can be walked and rebuilt", async () => {
  const logs = await run(`
    let: string[] words = ["yare", "script"];
    let: string joined = "";
    let: int i = 0;
    while (i < words.length) {
      joined = joined + words[i];
      i++;
    }
    console.println(joined);
    console.println(words[1].length);
    console.println(words[0][0]);
  `);
  assert.deepStrictEqual(logs, ["yarescript", "6", "y"]);
});

test("arrays are invariant, and the errors say so", () => {
  assert.match(
    errorFor(`public function: void main() { let: int[] xs = [1]; let: double[] ys = xs; }`),
    /Cannot assign 'int\[\]' to 'double\[\]'/
  );
  assert.match(
    errorFor(`public function: void main() { let: int[] xs = [1]; console.println(xs[1.5]); }`),
    /index must be an integer/
  );
  assert.match(
    errorFor(`public function: void main() { let: int[] a = [1]; let: int[] b = [1]; console.println(a == b); }`),
    /two arrays/i
  );
  assert.match(
    errorFor(`public function: void main() { let: int[] xs = [1]; console.println(xs + xs); }`),
    /does not work on 'int\[\]'/
  );
  assert.match(
    errorFor(`public function: void main() { let: int[] xs = ["a"]; }`),
    /Element 1 of the array: expected 'int', got 'string'/
  );
  assert.match(
    errorFor(`public function: void main() { let: int x = [1, 2]; }`),
    /Cannot put an array literal in something of type 'int'/
  );
});

test("an array without a type to aim at is refused", () => {
  assert.match(
    errorFor(`public function: void main() { console.println([1, 2]); }`),
    /needs an array type to aim at/
  );
});
