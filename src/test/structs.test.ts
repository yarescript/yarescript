import test from "node:test";
import assert from "node:assert/strict";
import { compileAndRun } from "./helpers";
import { parse } from "../parser/parser";
import { check } from "../checker/checker";

/**
 * Structs: fixed-layout records you declare at the top of a file, build with
 * `Point(1, 2)`, and reach into with `p.x`. The layout is worked out once by
 * the checker, and these tests exist to make sure codegen agrees with it.
 */

async function run(source: string): Promise<string[]> {
  const { logs } = await compileAndRun(source);
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

test("a struct holds what you put in it", async () => {
  const logs = await run(`
    struct Point {
      int x;
      int y;
    }

    public function: void main() {
      let: Point p = Point(3, 4);
      console.println(p.x);
      console.println(p.y);
    }
  `);
  assert.deepStrictEqual(logs, ["3", "4"]);
});

test("fields can be written, and ++ works on them", async () => {
  const logs = await run(`
    struct Counter {
      int hits;
      double total;
    }

    public function: void main() {
      let: Counter c = Counter(0, 0.0);
      c.hits++;
      c.hits += 4;
      c.total = 1.25;
      c.total += 0.5;
      console.println(c.hits);
      console.println(c.total);
    }
  `);
  assert.deepStrictEqual(logs, ["5", "1.75"]);
});

test("every field type keeps its own width and alignment", async () => {
  // narrow fields next to wide ones is where a wrong offset shows up first
  const logs = await run(`
    struct Everything {
      i8 small;
      u8 byte;
      i16 half;
      char letter;
      int number;
      u32 unsigned;
      long big;
      double precise;
      float rough;
      bool flag;
      string name;
    }

    public function: void main() {
      let: Everything e = Everything(-1, 255, -2, 65 -> char, 7, 4000000000, 5000000000, 0.5, 0.25, true, "all");
      console.println(e.small);
      console.println(e.byte);
      console.println(e.half);
      console.println(e.letter);
      console.println(e.number);
      console.println(e.unsigned);
      console.println(e.big);
      console.println(e.precise);
      console.println(e.rough);
      console.println(e.flag);
      console.println(e.name);
      e.small = 127;
      e.small++;
      console.println(e.small);
    }
  `);
  assert.deepStrictEqual(logs, [
    "-1",
    "255",
    "-2",
    "A",
    "7",
    "4000000000",
    "5000000000",
    "0.5",
    "0.25",
    "true",
    "all",
    "-128",
  ]);
});

test("structs go into functions and come back out", async () => {
  const logs = await run(`
    struct Rect {
      int w;
      int h;
    }

    public function: int area(Rect r) {
      return r.w * r.h;
    }

    public function: Rect scaled(Rect r, int factor) {
      return Rect(r.w * factor, r.h * factor);
    }

    public function: void main() {
      let: Rect r = Rect(3, 4);
      console.println(area(r));
      let: Rect bigger = scaled(r, 10);
      console.println(bigger.w);
      console.println(area(bigger));
      console.println(r.w);
    }
  `);
  assert.deepStrictEqual(logs, ["12", "30", "1200", "3"]);
});

test("a struct can hold an array, and an array can hold structs", async () => {
  const logs = await run(`
    struct Tag {
      string name;
      int[] counts;
    }

    public function: void main() {
      let: Tag t = Tag("sizes", [1, 2, 3]);
      console.println(t.name);
      console.println(t.counts.length);
      console.println(t.counts[2]);
      t.counts[2] = 30;
      console.println(t.counts[2]);

      let: Tag[] tags = [Tag("a", [1]), Tag("b", [2, 2])];
      console.println(tags.length);
      console.println(tags[1].name);
      console.println(tags[1].counts[0]);
      tags[0].counts[0] = 99;
      console.println(tags[0].counts[0]);
    }
  `);
  assert.deepStrictEqual(logs, ["sizes", "3", "3", "30", "2", "b", "2", "99"]);
});

test("structs nest, and the inner one is shared not copied", async () => {
  const logs = await run(`
    struct Inner {
      int value;
    }

    struct Outer {
      Inner inner;
      int label;
    }

    public function: void main() {
      let: Inner i = Inner(1);
      let: Outer o = Outer(i, 2);
      console.println(o.inner.value);
      console.println(o.label);
      o.inner.value = 10;
      console.println(i.value);
      o.inner.value++;
      console.println(o.inner.value);
    }
  `);
  assert.deepStrictEqual(logs, ["1", "2", "10", "11"]);
});

test("a struct in a loop, building something real", async () => {
  const logs = await run(`
    struct Row {
      int index;
      int square;
    }

    public function: void main() {
      let: Row[] rows = new Row[3];
      let: int i = 0;
      while (i < rows.length) {
        rows[i] = Row(i, i * i);
        i++;
      }
      let: int j = 0;
      while (j < rows.length) {
        console.println(rows[j].square);
        j++;
      }
    }
  `);
  assert.deepStrictEqual(logs, ["0", "1", "4"]);
});

test("the struct errors are specific", () => {
  const base = `struct Point { int x; int y; }`;
  assert.match(
    errorFor(`${base}\npublic function: void main() { let: Point p = Point(1, 2); console.println(p.z); }`),
    /has no field 'z'\. Did you mean/
  );
  assert.match(
    errorFor(`${base}\npublic function: void main() { let: Point p = Point(1); }`),
    /has 2 field\(s\) \(x, y\), got 1/
  );
  assert.match(
    errorFor(`${base}\npublic function: void main() { let: Point p = Point(1, "two"); }`),
    /Field 'y' of 'Point': expected 'int', got 'string'/
  );
  assert.match(
    errorFor(`struct Empty {\n}\npublic function: void main() { }`),
    /has no fields/
  );
  assert.match(
    errorFor(`struct Dup { int a; int a; }\npublic function: void main() { }`),
    /two fields called 'a'/
  );
  assert.match(
    errorFor(`struct P { int x; }\nstruct P { int y; }\npublic function: void main() { }`),
    /already defined/
  );
  assert.match(
    errorFor(`struct Bad { banana b; }\npublic function: void main() { }`),
    /Unknown type 'banana'/
  );
});

test("a struct is not a number and does not cast", () => {
  assert.match(
    errorFor(`struct P { int x; }\npublic function: void main() { let: P p = P(1); let: int n = p -> int; }`),
    /Cannot cast a 'P' to 'int'/
  );
  assert.match(
    errorFor(`struct P { int x; }\npublic function: void main() { let: P p = P(1); console.println(p + p); }`),
    /does not work on 'P'/
  );
});

test("a struct name cannot shadow a built-in type", () => {
  assert.match(
    errorFor(`struct int { int x; }\npublic function: void main() { }`),
    /built-in type/
  );
});
