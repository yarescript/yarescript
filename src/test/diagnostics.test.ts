import assert from "node:assert";
import { test } from "node:test";
import { parse } from "../parser/parser";
import { check, TypeError_ } from "../checker/checker";
import { suggest, levenshtein } from "../diagnostics/suggest";

function errorFor(source: string): string {
  try {
    check(parse(source, "<test>"));
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a type error");
}

test("levenshtein counts edits", () => {
  assert.strictEqual(levenshtein("prntln", "println"), 1);
  assert.strictEqual(levenshtein("abc", "abc"), 0);
  assert.strictEqual(levenshtein("", "abc"), 3);
});

test("suggest gives up when nothing is close", () => {
  assert.strictEqual(suggest("zzzzzzz", ["apple", "banana"]), null);
  assert.strictEqual(suggest("aple", ["apple"]), "apple");
});

test("a mistyped print points at console.log", () => {
  assert.match(errorFor(`public function: void main() { prntln("hi"); }`), /console\.log/);
  assert.match(errorFor(`public function: void main() { println("hi"); }`), /console\.log/);
});

test("a mistyped variable is suggested from scope", () => {
  const msg = errorFor(`public function: void main() { let: int total = 1; console.log(totl); }`);
  assert.match(msg, /Did you mean 'total'\?/);
});

test("a mistyped type is suggested", () => {
  assert.match(errorFor(`public function: void main() { let: integ x = 1; }`), /Did you mean 'int'\?/);
  assert.match(errorFor(`public function: voi main() {}`), /Did you mean 'void'\?/);
});

test("a mistyped function name is suggested", () => {
  const msg = errorFor(`
    public function: int fibb(int n) { return n; }
    public function: void main() { console.log(fib(3)); }
  `);
  assert.match(msg, /Did you mean 'fibb'\?/);
});

test("errors carry a line number", () => {
  assert.throws(
    () => check(parse(`public function: void main() {\n  let: integ x = 1;\n}`)),
    (e: Error) => e instanceof TypeError_ && /\(line 2\)/.test(e.message)
  );
});
