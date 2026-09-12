import assert from "node:assert";
import { test } from "node:test";
import { parse } from "../parser/parser";
import { check, TypeError_ } from "../checker/checker";
import { format } from "../fmt/formatter";
import { compileAndRun } from "./helpers";

// ---------------------------------------------------------------------------
// The language features that make JavaScript feel like JavaScript, minus the
// DOM: ternaries, switch, do..while, for..of, bitwise operators, template
// strings, type inference, typeof, null, and strings you can += onto.
// ---------------------------------------------------------------------------

test("a ternary picks an arm and does not evaluate the other", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: int n = 5;
      console.println(n > 3 ? "big" : "small");
      console.println(n > 9 ? "big" : "small");
      // the untaken arm indexes past the end, which traps if it is evaluated
      let: int[] xs = new int[0];
      console.println(xs.length > 0 ? xs[0] : -1);
    }
  `);
  assert.deepStrictEqual(logs, ["big", "small", "-1"]);
});

test("switch matches, falls through, and breaks", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: int n = 5;
      let: string word = "";
      switch (n) {
        case 1: {
          word = "one";
          break;
        }
        case 5: {
          word = "five";
        }
        case 6: {
          word = word + " or six";
          break;
        }
        default: {
          word = "other";
        }
      }
      console.println(word);
      switch (n) {
        case 1: {
          console.println("one");
          break;
        }
        default: {
          console.println("default");
        }
      }
      switch ("abc") {
        case "abc": {
          console.println("strings switch too");
          break;
        }
      }
    }
  `);
  assert.deepStrictEqual(logs, ["five or six", "default", "strings switch too"]);
});

test("break inside a switch leaves the switch, and the loop carries on", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: int hits = 0;
      for (let: int i = 0; i < 3; i++) {
        switch (i) {
          case 1: {
            break;
          }
        }
        hits++;
      }
      // break leaves the switch only, so all three passes still count
      console.println(hits);
      let: int counted = 0;
      for (let: int i = 0; i < 5; i++) {
        if (i == 3) {
          break;
        }
        counted++;
      }
      console.println(counted);
    }
  `);
  assert.deepStrictEqual(logs, ["3", "3"]);
});

test("do..while runs the body once before asking", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: int i = 0;
      do {
        i++;
      } while (i < 3);
      console.println(i);
      let: int j = 10;
      do {
        j++;
      } while (j < 0);
      console.println(j);
    }
  `);
  assert.deepStrictEqual(logs, ["3", "11"]);
});

test("for..of walks arrays and strings", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: int[] xs = [1, 2, 3];
      let: int total = 0;
      for (let: int x of xs) {
        total += x;
      }
      console.println(total);
      let: string s = "";
      for (let: char c of "abc") {
        s = s + c;
      }
      console.println(s);
      let: string[] names = ["a", "b"];
      for (let: string name of names) {
        console.println(name);
      }
    }
  `);
  assert.deepStrictEqual(logs, ["6", "abc", "a", "b"]);
});

test("for..in counts the slots", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: int[] xs = [7, 8, 9];
      for (let: int i in xs) {
        console.println(i);
      }
      for (let: int i in "hi") {
        console.println(i);
      }
    }
  `);
  assert.deepStrictEqual(logs, ["0", "1", "2", "0", "1"]);
});

test("bitwise operators and their compound forms", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      console.println(6 & 3);
      console.println(6 | 3);
      console.println(6 ^ 3);
      console.println(1 << 4);
      console.println(-16 >> 2);
      console.println(~5);
      let: int n = 12;
      n &= 10;
      console.println(n);
      n |= 1;
      console.println(n);
      n ^= 9;
      console.println(n);
      n <<= 2;
      console.println(n);
      n >>= 1;
      console.println(n);
      n %= 3;
      console.println(n);
      let: long big = 1;
      big <<= 40;
      console.println(big);
    }
  `);
  assert.deepStrictEqual(logs, ["2", "7", "5", "16", "-4", "-6", "8", "9", "0", "0", "0", "0", "1099511627776"]);
});

test("=== and !== are the same comparison with a longer spelling", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      console.println(1 === 1);
      console.println(1 === 2);
      console.println("a" !== "b");
      console.println("a" === "a");
    }
  `);
  assert.deepStrictEqual(logs, ["true", "false", "true", "true"]);
});

test("template strings interpolate anything printable", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: string name = "yare";
      console.println(\`hi \${name}\`);
      console.println(\`\${2 + 3}\`);
      console.println(\`\${3.5}\`);
      console.println(\`\${0.1}\`);
      console.println(\`\${-2.25}\`);
      console.println(\`\${true}\`);
      console.println(\`\${65 -> char}\`);
      console.println(\`\${42}\`);
      console.println(\`\${-7}\`);
      console.println(\`plain\`);
    }
  `);
  assert.deepStrictEqual(logs, ["hi yare", "5", "3.5", "0.1", "-2.25", "true", "A", "42", "-7", "plain"]);
});

test("let works out the type when you do not say it", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let x = 42;
      let y = 1.5;
      let z = "text";
      let flag = true;
      let xs = new int[2];
      xs[1] = 9;
      console.println(x);
      console.println(y);
      console.println(z);
      console.println(flag);
      console.println(xs[1]);
    }
  `);
  assert.deepStrictEqual(logs, ["42", "1.5", "text", "true", "9"]);
});

test("typeof answers with the type the compiler knows", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: int[] xs = [1];
      console.println(typeof 1);
      console.println(typeof "s");
      console.println(typeof 1.5);
      console.println(typeof true);
      console.println(typeof xs);
    }
  `);
  assert.deepStrictEqual(logs, ["int", "string", "double", "bool", "int[]"]);
});

test("null goes in a reference and comes back out", async () => {
  const { logs } = await compileAndRun(`
    struct Point {
      int x;
    }

    public function: void main() {
      let: int[] xs = null;
      console.println(xs == null);
      let: Point p = Point(1);
      console.println(p == null);
      p = null;
      console.println(p != null);
      let: string s = null;
      console.println(s == null);
    }
  `);
  assert.deepStrictEqual(logs, ["true", "false", "false", "true"]);
});

test("a string can be += onto", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: string s = "";
      s += "ab";
      s += "cd";
      s += (33 -> char);
      console.println(s);
    }
  `);
  assert.deepStrictEqual(logs, ["abcd!"]);
});

test("if, while, and for take a bare statement", async () => {
  const { logs } = await compileAndRun(`
    public function: void main() {
      let: int i = 0;
      while (i < 2) i++;
      console.println(i);
      if (i == 2) console.println("two");
      else console.println("other");
      for (let: int k = 0; k < 2; k++) console.println(k);
    }
  `);
  assert.deepStrictEqual(logs, ["2", "two", "0", "1"]);
});

test("bitwise operators refuse floats", () => {
  assert.throws(
    () =>
      check(parse(`
      public function: void main() {
        console.println(1.5 & 1);
      }
    `)),
    (e: Error) => e instanceof TypeError_ && /needs integers/.test(e.message)
  );
});

test("the two arms of a ternary have to agree", () => {
  assert.throws(
    () =>
      check(parse(`
      public function: void main() {
        console.println(true ? "a" : 1);
      }
    `)),
    (e: Error) => e instanceof TypeError_ && /have to agree/.test(e.message)
  );
});

test("switch refuses a float", () => {
  assert.throws(
    () =>
      check(parse(`
      public function: void main() {
        switch (1.5) {
          case 1.5: {
            break;
          }
        }
      }
    `)),
    (e: Error) => e instanceof TypeError_ && /switch/.test(e.message)
  );
});

test("for..of walks arrays and strings only", () => {
  assert.throws(
    () =>
      check(parse(`
      public function: void main() {
        for (let: int x of 5) {
          console.println(x);
        }
      }
    `)),
    (e: Error) => e instanceof TypeError_ && /walks arrays and strings/.test(e.message)
  );
});

test("a bare null with nowhere to go is an error", () => {
  assert.throws(
    () =>
      check(parse(`
      public function: void main() {
        let x = null;
      }
    `)),
    (e: Error) => e instanceof TypeError_ && /no type/.test(e.message)
  );
});

test("the formatter keeps the new syntax in shape", () => {
  const messy = `public function: void main(){
let x=5;
switch(x){case 5:{console.println(\`five \${x}\`);break;}default:{console.println("other");}}
do{x++;}while(x<7);
for(let:int y of [1,2]){console.println(y);}
console.println(x>3?"big":"small");
console.println(6&3|1);
}\n`;
  const formatted = format(messy);
  assert.ok(formatted.includes("let x = 5;"), formatted);
  assert.ok(formatted.includes("switch (x) {"), formatted);
  assert.ok(formatted.includes("case 5:"), formatted);
  assert.ok(formatted.includes("`five ${x}`"), formatted);
  assert.ok(formatted.includes("} while (x < 7);"), formatted);
  assert.ok(formatted.includes("for (let: int y of [1, 2]) {"), formatted);
  assert.ok(formatted.includes(`console.println(x > 3 ? "big" : "small");`), formatted);
  // & binds tighter than |, so no parentheses are needed and none appear
  assert.ok(formatted.includes("console.println(6 & 3 | 1);"), formatted);
});

test("a formatted program with the new syntax still behaves", async () => {
  const source = `public function: void main() {
    let total = 0;
    for (let: int x of [1, 2, 3]) {
      total += x;
    }
    do {
      total--;
    } while (total > 3);
    console.println(\`total is \${total}\`);
}\n`;
  const formatted = format(source);
  const { logs } = await compileAndRun(formatted);
  assert.deepStrictEqual(logs, ["total is 3"]);
});
