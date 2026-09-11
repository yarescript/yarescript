import assert from "node:assert";
import { test } from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse } from "../parser/parser";
import { linkModules, availableModules } from "../deps/link";
import { readDepFile, DEP_MAGIC } from "../deps/depfile";
import { ModuleError } from "../modules/resolve";
import { runProgram } from "./helpers";

function link(source: string) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "yare-dep-"));
  const report = linkModules(parse(source, "<test>"), { outDir });
  return { ...report, outDir };
}

test("the bundled modules are all there", () => {
  const mods = availableModules();
  for (const expected of ["json", "math", "str"]) {
    assert.ok(mods.includes(expected), `missing module ${expected} in ${mods.join(", ")}`);
  }
});

test("only the functions you call get linked", () => {
  const { modules } = link(`
    @modules.import("str");
    public function: void main() { console.log(str.upper("hi")); }
  `);
  const str = modules.find((m) => m.name === "str")!;
  assert.deepStrictEqual(str.linked, ["upper"]);
  assert.ok(str.available > 1);
});

test("importing a module you never call links nothing from it", () => {
  const { modules } = link(`
    @modules.import("json");
    @modules.import("str");
    public function: void main() { console.log(str.length("hi")); }
  `);
  const json = modules.find((m) => m.name === "json")!;
  assert.deepStrictEqual(json.linked, []);
});

test("a function that calls a sibling pulls it in too", () => {
  const { modules } = link(`
    @modules.import("str");
    public function: void main() { console.log(str.contains("abc", "b")); }
  `);
  const str = modules.find((m) => m.name === "str")!;
  assert.ok(str.linked.includes("contains"));
  assert.ok(str.linked.includes("slice"), `slice should come along: ${str.linked}`);
});

test("the dep file is a real object file with an index", () => {
  const { modules, outDir } = link(`
    @modules.import("math");
    public function: void main() { console.log(math.abs(1)); }
  `);
  const dep = readDepFile(modules[0].depPath);
  assert.strictEqual(dep.magic, DEP_MAGIC);
  assert.strictEqual(dep.name, "math");
  assert.match(dep.sourceHash, /^sha256:[0-9a-f]+$/);
  assert.ok(dep.functions.some((f) => f.name === "abs"));
  assert.ok(fs.existsSync(path.join(outDir, "dep", "build", "math.yare.dep")));
});

test("linked module code really runs", async () => {
  const { program } = link(`
    @modules.import("str");
    @modules.import("math");
    public function: void main() {
      console.log(str.upper("yare"));
      console.log(str.reverse("abc"));
      console.log(math.pow(2, 8));
      console.log(math.sqrt(81.0));
    }
  `);
  const { logs } = await runProgram(program);
  assert.deepStrictEqual(logs, ["YARE", "cba", "256", "9"]);
});

test("an unknown module is reported with the alternatives", () => {
  assert.throws(
    () => link(`@modules.import("jsonn");
      public function: void main() { console.log(1); }`),
    (e: Error) => e instanceof ModuleError && /Did you mean 'json'\?/.test(e.message)
  );
});

test("an unknown function in a known module is reported", () => {
  assert.throws(
    () => link(`@modules.import("str");
      public function: void main() { console.log(str.uppr("x")); }`),
    /has no function 'uppr'.*Did you mean 'upper'\?/s
  );
});

test("an unknown directive is reported", () => {
  assert.throws(
    () => link(`@moduls.import("str");
      public function: void main() { console.log(1); }`),
    /Unknown directive '@moduls'/
  );
});
