import assert from "node:assert";
import { test } from "node:test";
import { parse } from "../parser/parser";
import { check } from "../checker/checker";
import { compileAndRun } from "./helpers";

test("a string can be indexed and measured", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: string s = "yare";
      console.println(s[0]);
      console.println(s[3]);
      console.println(s.length);
    }
  `);
  assert.deepStrictEqual(logs, ["y", "e", "4"]);
});

test("indexing out of range traps instead of reading neighbours", async () => {
  await assert.rejects(
    compileAndRun(`public function: void main() { let: string s = "ab"; console.println(s[9]); }`)
  );
  await assert.rejects(
    compileAndRun(`public function: void main() { let: string s = "ab"; console.println(s[0 - 1]); }`)
  );
});

test("a char concatenates onto a string from either side", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      console.println("hell" + (111 -> char));
      console.println((89 -> char) + "es");
    }
  `);
  assert.deepStrictEqual(logs, ["hello", "Yes"]);
});

test("a string can be rebuilt one char at a time", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: string s = "yarescript";
      let: string out = "";
      for (let: int i = s.length - 1; i >= 0; i--) { out = out + s[i]; }
      console.println(out);
    }
  `);
  assert.deepStrictEqual(logs, ["tpircseray"]);
});

test("indexing a non-string is a type error", () => {
  assert.throws(() => {
    check(parse(`public function: void main() { let: int n = 1; console.println(n[0]); }`));
  }, /Cannot index into a 'int'/);
});
