import assert from "node:assert";
import { test } from "node:test";
import { format } from "../fmt/formatter";
import { compileAndRun } from "./helpers";

test("formats into the canonical layout", () => {
  const messy = `public function:int fib( int n ){
if(n<2){return n;}  // base case
    return fib(n-1)+fib(n-2);
}
public function: void main(){
let:int x=1;const:double pi=2.0;
for(let:int i=0;i<3;i++){x+=i;}
}
`;
  const expected = `public function: int fib(int n) {
    if (n < 2) {  // base case
        return n;
    }
    return fib(n - 1) + fib(n - 2);
}

public function: void main() {
    let: int x = 1;
    const: double pi = 2.0;
    for (let: int i = 0; i < 3; i++) {
        x += i;
    }
}
`;
  assert.strictEqual(format(messy, "t.ys"), expected);
});

test("formatting twice changes nothing", () => {
  const src = `public function: void main(){if(1==1){console.log("a");}else{console.log("b");}while(0>1){}}`;
  const once = format(src, "t.ys");
  assert.strictEqual(format(once, "t.ys"), once);
});

test("parentheses that change meaning survive", () => {
  const src = `public function: double average(double a, double b) {
    const: double two = 2.0;
    return (a + b) / two;
}`;
  assert.match(format(src, "t.ys"), /return \(a \+ b\) \/ two;/);
  // ...and ones that do not are dropped
  assert.match(format(`public function: void main() { let: int x = 1 + (2 * 3); }`, "t.ys"), /1 \+ 2 \* 3/);
});

test("two minus signs never become a decrement", () => {
  const src = `public function: void main() { let: int i = 1; console.log(- -i); }`;
  const out = format(src, "t.ys");
  assert.match(out, /-\(-i\)/);
  assert.doesNotMatch(out, /--i/);
});

test("comments survive, including trailing ones", () => {
  const src = `// file header

public function: void main() {
    // standalone
    let: int x = 1;  // trailing

    /* block */
    console.log(x);
}
`;
  const out = format(src, "t.ys");
  assert.match(out, /\/\/ file header\n\npublic function/);
  assert.match(out, /\/\/ standalone\n {4}let: int x = 1; {2}\/\/ trailing/);
  assert.match(out, /\/\* block \*\//);
});

test("a blank line between statements is kept", () => {
  const src = `public function: void main() {
    let: int a = 1;

    let: int b = 2;
    let: int c = 3;
}
`;
  const out = format(src, "t.ys");
  assert.match(out, /let: int a = 1;\n\n {4}let: int b = 2;\n {4}let: int c = 3;/);
});

test("floats keep their decimal point", () => {
  const src = `public function: void main() { const: double two = 2.0; console.log(two); }`;
  assert.match(format(src, "t.ys"), /const: double two = 2\.0;/);
});

test("a formatted program behaves exactly like the original", async () => {
  const src = `
    public function: int fib(int n) {
      if (n < 2) { return n; }
      return fib(n - 1) + fib(n - 2);
    }
    public function: double average(double a, double b) {
      const: double two = 2.0;
      return (a + b) / two;
    }
    public function: void main() {
      console.log(fib(10));
      console.log(average(3.5, 4.5));
      console.log(2 * (3 + 4) - 10 / (1 + 1));
      let: string s = "a" + "b";
      console.log(s);
      console.log(s == "ab");
      let: int n = 3.99 -> int;
      console.log(n);
      let: int i = 0;
      while (i < 3) { i++; }
      console.log(i);
    }
  `;
  const before = await compileAndRun(src);
  const after = await compileAndRun(format(src, "t.ys"));
  assert.deepStrictEqual(after.logs, before.logs);
  assert.ok(before.logs.length > 5);
});
