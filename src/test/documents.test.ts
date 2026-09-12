import assert from "node:assert";
import { test } from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse } from "../parser/parser";
import { linkModules } from "../deps/link";
import { ModuleError } from "../modules/resolve";
import { runProgram } from "./helpers";

function link(source: string) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "yare-doc-"));
  return linkModules(parse(source, "<test>"), { outDir });
}

/** Links the stdlib modules in, then runs main() and collects what it printed. */
async function run(source: string): Promise<string[]> {
  const { logs } = await runProgram(link(source).program);
  return logs;
}

test("json reads a whole document into a tree", async () => {
  const logs = await run(`
    @modules.import("json");

    public function: void main() {
      let: JsonValue doc = json.parse("{\\"name\\":\\"yare\\",\\"tags\\":[\\"a\\",\\"b\\"],\\"n\\":42,\\"ok\\":true,\\"z\\":null}");
      console.println(json.ok(doc));
      console.println(json.kindName(doc));
      console.println(json.count(doc));
      console.println(json.stringOf(json.find(doc, "name")));
      console.println(json.intOf(json.find(doc, "n")));
      console.println(json.boolOf(json.find(doc, "ok")));
      console.println(json.kindName(json.find(doc, "z")));
      let: JsonValue tags = json.find(doc, "tags");
      console.println(json.count(tags));
      console.println(json.stringOf(json.child(tags, 1)));
    }
  `);
  assert.deepStrictEqual(logs, ["true", "object", "5", "yare", "42", "true", "null", "2", "b"]);
});

test("json reports a broken document instead of guessing", async () => {
  const logs = await run(`
    @modules.import("json");

    public function: void main() {
      let: JsonValue doc = json.parse("{\\"a\\":}");
      console.println(json.ok(doc));
      console.println(json.errorOf(doc));
    }
  `);
  assert.deepStrictEqual(logs, ["false", "a number needs at least one digit"]);
});

test("json writes a document back out", async () => {
  const logs = await run(`
    @modules.import("json");

    public function: void main() {
      console.println(json.stringify(json.parse("[1, 2.5, \\"x\\", true, false, null]")));
      console.println(json.ofInt(7));
      console.println(json.quote("a\\"b"));
    }
  `);
  assert.deepStrictEqual(logs, ["[1,2.5,\"x\",true,false,null]", "7", "\"a\\\"b\""]);
});

test("toml reads sections, values, and comments", async () => {
  const logs = await run(`
    @modules.import("toml");

    public function: void main() {
      let: string src = "# a comment\\ntitle = \\"yarescript\\"\\n[server]\\nhost = \\"localhost\\" # where\\nport = 8080\\nenabled = true\\nratio = 0.5\\n";
      let: TomlDoc doc = toml.parse(src);
      console.println(toml.ok(doc));
      console.println(toml.count(doc));
      console.println(toml.stringOf(doc, "server", "host"));
      console.println(toml.intOf(doc, "server", "port"));
      console.println(toml.boolOf(doc, "server", "enabled"));
      console.println(toml.numberOf(doc, "server", "ratio"));
      console.println(toml.kindName(toml.find(doc, "server", "nope")));
    }
  `);
  assert.deepStrictEqual(logs, ["true", "5", "localhost", "8080", "true", "0.5", "missing"]);
});

test("xml reads elements, attributes, and nested children", async () => {
  const logs = await run(`
    @modules.import("xml");

    public function: void main() {
      let: XmlDoc doc = xml.parse("<?xml version=\\"1.0\\"?><!-- hi --><note priority=\\"1\\"><to>Tove</to><meta><tag>kept</tag></meta></note>");
      console.println(xml.ok(doc));
      let: XmlNode root = xml.root(doc);
      console.println(xml.name(root));
      console.println(xml.attr(root, "priority"));
      console.println(xml.childCount(root));
      console.println(xml.textOf(xml.find(root, "to")));
      console.println(xml.textOf(xml.find(xml.find(root, "meta"), "tag")));
      console.println(xml.errorOf(xml.parse("<a></b>")));
      console.println(xml.ok(xml.parse("<a></b>")));
    }
  `);
  assert.deepStrictEqual(logs, ["true", "note", "1", "2", "Tove", "kept", "a was closed by b", "false"]);
});

test("two document modules can be imported at once", async () => {
  const logs = await run(`
    @modules.import("json");
    @modules.import("toml");

    public function: void main() {
      console.println(json.count(json.parse("[1, 2]")));
      console.println(toml.count(toml.parse("a = 1")));
    }
  `);
  assert.deepStrictEqual(logs, ["2", "1"]);
});

test("only the parser functions you call get linked", () => {
  const { modules } = link(`
    @modules.import("json");
    public function: void main() { console.println(json.ok(json.parse("1"))); }
  `);
  const json = modules.find((m) => m.name === "json")!;
  assert.ok(json.linked.includes("parse"));
  assert.ok(!json.linked.includes("stringify"));
});

test("a module cannot define the same function twice", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yare-dup-"));
  const stdlib = path.join(dir, "stdlib");
  fs.mkdirSync(stdlib);
  fs.writeFileSync(
    path.join(stdlib, "dup.ys"),
    "public function: int twice(int a) {\n    return a;\n}\n\npublic function: int twice(int a, int b) {\n    return a;\n}\n"
  );
  assert.throws(
    () =>
      linkModules(parse(`@modules.import("dup");\npublic function: void main() { console.println(dup.twice(1)); }`, "<test>"), {
        outDir: dir,
        stdlib,
      }),
    (e: Error) => e instanceof ModuleError && /defines 'twice' twice/.test(e.message)
  );
});
