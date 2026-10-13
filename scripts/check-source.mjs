import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

function hasModifier(node, kind) {
  return (
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind)
  );
}

function hasDoc(node) {
  return ts.getJSDocCommentsAndTags(node).length > 0;
}

function declarationNames(statement) {
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.map((declaration) => declaration.name.getText());
  return statement.name ? [statement.name.text] : [];
}

function collectReexportedNames(source, filename, reexported) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) continue;
    const target = path.join(path.dirname(filename), specifier.replace(/\.js$/, ".ts"));
    const names = reexported.get(target) ?? new Set();
    if (statement.exportClause && ts.isNamedExports(statement.exportClause))
      for (const element of statement.exportClause.elements)
        names.add((element.propertyName ?? element.name).text);
    else names.add("*");
    reexported.set(target, names);
  }
}

function sourceRules(source, filename, reexportedNames = new Set()) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const violations = [];
  const reported = new Set();
  const program = ts.createProgram(
    [filename],
    { noLib: true, noResolve: true },
    {
      ...ts.createCompilerHost({}),
      getSourceFile: (name) => (name === filename ? file : undefined),
    },
  );
  const checker = program.getTypeChecker();
  const report = (node, rule) => {
    const key = `${node.getStart(file)}:${rule}`;
    if (reported.has(key)) return;
    reported.add(key);
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    violations.push(`${filename}:${line + 1}: ${rule}`);
  };
  function resolve(node, seen = new Set()) {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration;
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        !seen.has(symbol)
      ) {
        seen.add(symbol);
        return resolve(declaration.initializer, seen);
      }
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return resolve(node.expression, seen);
    return node;
  }
  function explicitObject(node) {
    node = resolve(node);
    if (ts.isObjectLiteralExpression(node))
      return node.properties.every(
        (property) => !ts.isSpreadAssignment(property) || explicitObject(property.expression),
      );
    if (ts.isConditionalExpression(node))
      return explicitObject(node.whenTrue) && explicitObject(node.whenFalse);
    return (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      explicitObject(node.right)
    );
  }
  function randomness(node) {
    if (ts.isFunctionLike(node)) {
      let expression = node;
      while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
      if (!ts.isCallExpression(expression.parent) || expression.parent.expression !== expression)
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
      (["getRandomValues", "randomUUID"].includes(node.expression.name.text) ||
        node.expression.getText(file) === "Math.random")
    )
      report(node, "module-scope randomness");
    ts.forEachChild(node, randomness);
  }
  randomness(file);
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (
        path.basename(filename) === "schema.ts" &&
        node.expression.name.text === "index" &&
        node.arguments[0]
      ) {
        const index = resolve(node.arguments[0]);
        let fields = node.arguments[1] && resolve(node.arguments[1]);
        if (fields && ts.isObjectLiteralExpression(fields)) {
          const property = fields.properties.find((candidate) => candidate.name?.text === "fields");
          fields =
            property && ts.isShorthandPropertyAssignment(property)
              ? checker.getShorthandAssignmentValueSymbol(property)?.valueDeclaration?.initializer
              : property?.initializer;
        }
        fields = fields && resolve(fields);
        const names =
          fields && ts.isArrayLiteralExpression(fields)
            ? fields.elements.map((element) =>
                ts.isStringLiteral(element) ? element.text : undefined,
              )
            : [];
        if (
          !names.length ||
          names.includes(undefined) ||
          !ts.isStringLiteral(index) ||
          index.text !== `by_${names.join("_and_")}`
        )
          report(node, "index name must list its fields");
      }
      if (
        filename.startsWith("src/client/") &&
        ["runMutation", "runQuery", "runAction"].includes(node.expression.name.text)
      ) {
        const inspected = new Set();
        function inspect(argument) {
          argument = resolve(argument);
          if (inspected.has(argument)) return;
          inspected.add(argument);
          if (ts.isSpreadAssignment(argument) && !explicitObject(argument.expression))
            report(argument, "component arguments spread a caller object");
          ts.forEachChild(argument, inspect);
        }
        for (const argument of node.arguments.slice(1)) inspect(argument);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (/^src\/(client|browser|sw)\//.test(filename)) {
    for (const statement of file.statements) {
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      const declaration = ts.isVariableStatement(statement)
        ? statement.declarationList.declarations[0]
        : statement;
      if (!hasDoc(declaration)) report(statement, "public export needs TSDoc");
      if (!ts.isClassDeclaration(statement)) continue;
      for (const member of statement.members) {
        if (
          hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
          (member.name && ts.isPrivateIdentifier(member.name))
        )
          continue;
        if (!hasDoc(member)) report(member, "public member needs TSDoc");
        if (
          ts.isPropertyDeclaration(member) &&
          member.initializer &&
          ts.isObjectLiteralExpression(member.initializer)
        )
          for (const property of member.initializer.properties)
            if (!hasDoc(property)) report(property, "client method needs TSDoc");
      }
    }
  }
  for (const statement of file.statements) {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    const isPublic = declarationNames(statement).some(
      (name) => reexportedNames.has(name) || reexportedNames.has("*"),
    );
    const declaration = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations[0]
      : statement;
    if (isPublic && !hasDoc(declaration))
      report(statement, "re-exported public export needs TSDoc");
  }
  return violations;
}

const files = [];
for (const root of ["src", "example"]) {
  try {
    for (const file of await readdir(root, { recursive: true }))
      if (file.endsWith(".ts")) files.push(path.join(root, file));
  } catch (error) {
    if (root !== "example" || error.code !== "ENOENT") throw error;
  }
}
const sources = new Map();
const reexported = new Map();
for (const filename of files.toSorted((left, right) => left.localeCompare(right))) {
  const source = await readFile(filename, "utf8");
  sources.set(filename, source);
  if (/^src\/(client|browser|sw)\//.test(filename))
    collectReexportedNames(source, filename, reexported);
}
const violations = [];
for (const [filename, source] of sources)
  violations.push(...sourceRules(source, filename, reexported.get(filename)));
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Source invariants: 0 violations in ${files.length} TypeScript files`);
}
