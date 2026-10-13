import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

function moduleRandomness(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const violations = [];
  function visit(node) {
    if (ts.isFunctionLike(node)) {
      const parent = node.parent;
      const expression = ts.isParenthesizedExpression(parent) ? parent.parent : parent;
      if (
        !ts.isCallExpression(expression) ||
        expression.expression !== (ts.isParenthesizedExpression(parent) ? parent : node)
      )
        return;
    }
    if (
      ts.isPropertyDeclaration(node) &&
      !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
    )
      return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["getRandomValues", "randomUUID"].includes(node.expression.name.text)
    ) {
      const location = file.getLineAndCharacterOfPosition(node.getStart(file));
      violations.push(`${filename}:${location.line + 1}: module-scope randomness`);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return violations;
}
for (const [source, count] of [
  ["const key = crypto.getRandomValues(new Uint8Array(32));", 1],
  ["crypto.randomUUID();", 1],
  ["function make() { return crypto.randomUUID(); }", 0],
  ["const make = () => crypto.randomUUID();", 0],
  ['test("deferred", () => crypto.randomUUID());', 0],
  ["(() => crypto.randomUUID())();", 1],
  ["class X { static id = crypto.randomUUID(); id = crypto.randomUUID(); }", 1],
]) {
  if (moduleRandomness(source, "checker-fixture.ts").length !== count)
    throw new Error("Source checker fixture failed");
}
function indexNames(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const violations = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "index" &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      let fields = node.arguments[1];
      if (fields && ts.isObjectLiteralExpression(fields))
        fields = fields.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) && property.name.getText(file) === "fields",
        )?.initializer;
      const names =
        fields && ts.isArrayLiteralExpression(fields)
          ? fields.elements.map((element) => (ts.isStringLiteral(element) ? element.text : ""))
          : [];
      if (node.arguments[0].text !== `by_${names.join("_and_")}`) {
        const location = file.getLineAndCharacterOfPosition(node.getStart(file));
        violations.push(`${filename}:${location.line + 1}: index name must list its fields`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return violations;
}
for (const [source, count] of [
  ['t.index("by_a", ["a"]);', 0],
  ['t.index("by_a_and_b", ["a", "b"]);', 0],
  ['t.index("by_a_and_b", { fields: ["a", "b"], staged: true });', 0],
  ['t.index("by_a_b", ["a", "b"]);', 1],
  ['t.index("by_b_and_a", ["a", "b"]);', 1],
]) {
  if (indexNames(source, "checker-fixture.ts").length !== count)
    throw new Error("Index name checker fixture failed");
}
function spreadArguments(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const violations = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["runMutation", "runQuery", "runAction"].includes(node.expression.name.text)
    ) {
      function inspect(argument) {
        if (
          ts.isObjectLiteralExpression(argument) &&
          argument.properties.some((property) => ts.isSpreadAssignment(property))
        ) {
          const location = file.getLineAndCharacterOfPosition(argument.getStart(file));
          violations.push(`${filename}:${location.line + 1}: component arguments spread an object`);
        }
        ts.forEachChild(argument, inspect);
      }
      for (const argument of node.arguments.slice(1)) inspect(argument);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return violations;
}
for (const [source, count] of [
  ["ctx.runMutation(fn, { ref, actor: options.actor });", 0],
  ["ctx.runMutation(fn, { ref, ...options });", 1],
  ["ctx.runQuery(fn, { ...options });", 1],
  ["ctx.runAction(fn, definedFields({ ...options }));", 1],
  ["const args = { ...options };", 0],
]) {
  if (spreadArguments(source, "checker-fixture.ts").length !== count)
    throw new Error("Spread argument checker fixture failed");
}
const files = (await readdir("src", { recursive: true })).filter((file) => file.endsWith(".ts"));
const violations = [];
for (const filename of files) {
  const full = path.join("src", filename);
  violations.push(...moduleRandomness(await readFile(full, "utf8"), full));
}
const schemaPath = path.join("src", "component", "schema.ts");
violations.push(...indexNames(await readFile(schemaPath, "utf8"), schemaPath));
const clientFiles = files.filter(
  (file) => file.startsWith("client/") && !file.endsWith(".test.ts"),
);
for (const clientFile of clientFiles) {
  const clientPath = path.join("src", clientFile);
  violations.push(...spreadArguments(await readFile(clientPath, "utf8"), clientPath));
}
if (violations.length) throw new Error(violations.join("\n"));
console.log(`Module-scope randomness: 0 calls in ${files.length} source files`);
console.log(`Index names: all list their fields in ${schemaPath}`);
console.log(`Component arguments: 0 object spreads in src/client/`);
