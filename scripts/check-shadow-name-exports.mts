#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { z } from "zod";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { collectTypeScriptFilesFromRoots, runAsScript } from "./lib/ts-guard-utils.mts";

const debtBaselineRelativePath = "scripts/lib/shadow-name-debt-baseline.json";
const debtBaselineRegenCommand = "pnpm lint:tmp:shadow-name-exports:gen";
const failureTool = "shadow-name-exports";

const baselineEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  sdk: z.boolean(),
});
const debtBaselineSchema = z.array(baselineEntrySchema);

export type ShadowNameSource = {
  path: string;
  source: string;
};

export type ShadowNameViolation = {
  line: number;
  name: string;
  path: string;
  sdk: boolean;
};

export type ShadowNameDebtEntry = z.infer<typeof baselineEntrySchema>;

export type AliasingReExport = {
  exportedName: string;
  importedName: string;
  line: number;
  moduleSpecifier: string;
  path: string;
};

type SourceModule = {
  path: string;
  sourceFile: ts.SourceFile;
};

type LocalDefinition = {
  directExport: boolean;
  node: ts.FunctionDeclaration | ts.VariableDeclaration;
};

type ModuleFacts = {
  aliases: AliasingReExport[];
  definitions: Map<string, LocalDefinition>;
  exportedNames: Set<string>;
  importNames: Map<string, string>;
  path: string;
  starReExports: string[];
};

function normalizePath(filePath: string) {
  return filePath.replaceAll(path.sep, "/");
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return Boolean(
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((item) => item.kind === kind),
  );
}

function isNamedExport(node: ts.Node) {
  return (
    hasModifier(node, ts.SyntaxKind.ExportKeyword) &&
    !hasModifier(node, ts.SyntaxKind.DefaultKeyword)
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function callExpressionFromReturn(
  expression: ts.Expression,
  allowAwait: boolean,
): ts.CallExpression | null {
  let current = unwrapExpression(expression);
  if (allowAwait && ts.isAwaitExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return ts.isCallExpression(current) ? current : null;
}

function callTarget(call: ts.CallExpression) {
  const target = unwrapExpression(call.expression);
  if (ts.isIdentifier(target)) {
    return { localName: target.text, name: target.text, receiverName: null };
  }
  if (ts.isPropertyAccessExpression(target)) {
    const receiver = unwrapExpression(target.expression);
    return {
      localName: null,
      name: target.name.text,
      receiverName: ts.isIdentifier(receiver) ? receiver.text : null,
    };
  }
  if (ts.isElementAccessExpression(target) && target.argumentExpression) {
    const argument = unwrapExpression(target.argumentExpression);
    const receiver = unwrapExpression(target.expression);
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
      return {
        localName: null,
        name: argument.text,
        receiverName: ts.isIdentifier(receiver) ? receiver.text : null,
      };
    }
  }
  return null;
}

function forwardsParameters(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  args: ts.NodeArray<ts.Expression>,
) {
  const runtimeParameters = parameters.filter(
    (parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === "this"),
  );
  if (runtimeParameters.length !== args.length) {
    return false;
  }
  return runtimeParameters.every((parameter, index) => {
    if (!ts.isIdentifier(parameter.name) || parameter.initializer) {
      return false;
    }
    const argument = args[index];
    if (!argument) {
      return false;
    }
    if (parameter.dotDotDotToken) {
      const spreadExpression = ts.isSpreadElement(argument)
        ? unwrapExpression(argument.expression)
        : null;
      return (
        spreadExpression !== null &&
        ts.isIdentifier(spreadExpression) &&
        spreadExpression.text === parameter.name.text
      );
    }
    const forwardedArgument = unwrapExpression(argument);
    return ts.isIdentifier(forwardedArgument) && forwardedArgument.text === parameter.name.text;
  });
}

function isMatchingForwardCall(
  call: ts.CallExpression,
  exportedName: string,
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  importNames: ReadonlyMap<string, string>,
) {
  const target = callTarget(call);
  const matchesTarget =
    (target?.name === exportedName && target.receiverName !== null) ||
    (target?.localName !== null &&
      target?.localName !== undefined &&
      importNames.get(target.localName) === exportedName);
  return matchesTarget && forwardsParameters(parameters, call.arguments);
}

function isLazyRuntimeAssignment(statement: ts.Statement) {
  if (!ts.isVariableStatement(statement)) {
    return null;
  }
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
    return null;
  }
  const [declaration] = statement.declarationList.declarations;
  if (
    statement.declarationList.declarations.length !== 1 ||
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer
  ) {
    return null;
  }
  const initializer = unwrapExpression(declaration.initializer);
  if (!ts.isAwaitExpression(initializer)) {
    return null;
  }
  const loader = unwrapExpression(initializer.expression);
  if (!ts.isCallExpression(loader)) {
    return null;
  }
  const isZeroArgumentLoader = loader.arguments.length === 0;
  const isLiteralDynamicImport =
    loader.expression.kind === ts.SyntaxKind.ImportKeyword &&
    loader.arguments.length === 1 &&
    loader.arguments[0] !== undefined &&
    ts.isStringLiteralLike(loader.arguments[0]);
  return isZeroArgumentLoader || isLiteralDynamicImport ? declaration.name.text : null;
}

function callReceiverName(call: ts.CallExpression) {
  return callTarget(call)?.receiverName ?? null;
}

function isForwardingFunction(
  node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  exportedName: string,
  importNames: ReadonlyMap<string, string>,
) {
  if (!node.body) {
    return false;
  }
  const isAsync = hasModifier(node, ts.SyntaxKind.AsyncKeyword);
  if (!ts.isBlock(node.body)) {
    const call = callExpressionFromReturn(node.body, isAsync);
    return Boolean(call && isMatchingForwardCall(call, exportedName, node.parameters, importNames));
  }

  if (node.body.statements.length === 1) {
    const [statement] = node.body.statements;
    if (!statement || !ts.isReturnStatement(statement) || !statement.expression) {
      return false;
    }
    const call = callExpressionFromReturn(statement.expression, isAsync);
    return Boolean(call && isMatchingForwardCall(call, exportedName, node.parameters, importNames));
  }

  if (node.body.statements.length !== 2 || !isAsync) {
    return false;
  }
  const [assignment, returned] = node.body.statements;
  if (!assignment || !returned || !ts.isReturnStatement(returned) || !returned.expression) {
    return false;
  }
  const runtimeName = isLazyRuntimeAssignment(assignment);
  const call = callExpressionFromReturn(returned.expression, true);
  return Boolean(
    runtimeName &&
    call &&
    callReceiverName(call) === runtimeName &&
    isMatchingForwardCall(call, exportedName, node.parameters, importNames),
  );
}

function isForwardingOnly(
  definition: LocalDefinition,
  exportedName: string,
  importNames: ReadonlyMap<string, string>,
) {
  if (ts.isFunctionDeclaration(definition.node)) {
    return isForwardingFunction(definition.node, exportedName, importNames);
  }
  if (!definition.node.initializer) {
    return false;
  }
  const initializer = unwrapExpression(definition.node.initializer);
  return (
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
    isForwardingFunction(initializer, exportedName, importNames)
  );
}

function collectModuleDefinitions(module: SourceModule) {
  const locals = new Map<string, LocalDefinition>();
  const localExports = new Map<string, string>();
  const exportedNames = new Set<string>();
  const importNames = new Map<string, string>();
  const starReExports: string[] = [];
  const aliases: AliasingReExport[] = [];

  const collectBindingNames = (name: ts.BindingName): string[] => {
    if (ts.isIdentifier(name)) {
      return [name.text];
    }
    return name.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : collectBindingNames(element.name),
    );
  };

  for (const statement of module.sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) {
            importNames.set(element.name.text, element.propertyName?.text ?? element.name.text);
          }
        }
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const previous = locals.get(statement.name.text);
      if (statement.body || !previous) {
        locals.set(statement.name.text, {
          directExport: isNamedExport(statement) || previous?.directExport === true,
          node: statement,
        });
      } else if (isNamedExport(statement)) {
        previous.directExport = true;
      }
      if (isNamedExport(statement)) {
        exportedNames.add(statement.name.text);
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      if (!isConst) {
        if (isNamedExport(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            for (const name of collectBindingNames(declaration.name)) {
              exportedNames.add(name);
            }
          }
        }
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        for (const name of collectBindingNames(declaration.name)) {
          if (declaration.initializer) {
            locals.set(name, {
              directExport: isNamedExport(statement),
              node: declaration,
            });
          }
          if (isNamedExport(statement)) {
            exportedNames.add(name);
          }
        }
      }
      continue;
    }
    if (
      (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
      statement.name &&
      isNamedExport(statement)
    ) {
      exportedNames.add(statement.name.text);
      continue;
    }
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    if (!statement.exportClause) {
      if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        starReExports.push(statement.moduleSpecifier.text);
      }
      continue;
    }
    if (ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        const exportedName = element.name.text;
        if (statement.isTypeOnly || element.isTypeOnly) {
          continue;
        }
        exportedNames.add(exportedName);
        if (!statement.moduleSpecifier) {
          localExports.set(exportedName, localName);
          continue;
        }
        if (
          localName !== exportedName &&
          !module.path.startsWith("src/plugin-sdk/") &&
          ts.isStringLiteralLike(statement.moduleSpecifier)
        ) {
          aliases.push({
            exportedName,
            importedName: localName,
            line:
              module.sourceFile.getLineAndCharacterOfPosition(element.getStart(module.sourceFile))
                .line + 1,
            moduleSpecifier: statement.moduleSpecifier.text,
            path: module.path,
          });
        }
      }
    } else if (ts.isNamespaceExport(statement.exportClause)) {
      exportedNames.add(statement.exportClause.name.text);
    }
  }

  const definitions = new Map<string, LocalDefinition>();
  for (const [localName, definition] of locals) {
    if (definition.directExport) {
      definitions.set(localName, definition);
    }
  }
  for (const [exportedName, localName] of localExports) {
    const definition = locals.get(localName);
    if (definition) {
      definitions.set(exportedName, definition);
    }
  }
  return {
    aliases,
    definitions,
    exportedNames,
    importNames,
    path: module.path,
    starReExports,
  } satisfies ModuleFacts;
}

function compareViolation(left: ShadowNameViolation, right: ShadowNameViolation) {
  return left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
}

function compareDebtEntry(left: ShadowNameDebtEntry, right: ShadowNameDebtEntry) {
  return left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
}

export function analyzeShadowNameSourceFiles(
  modules: SourceModule[],
  additionalSdkExportNames: ReadonlySet<string> = new Set(),
) {
  const definitionsByName = new Map<
    string,
    Array<{ definition: LocalDefinition; line: number; path: string }>
  >();
  const aliases: AliasingReExport[] = [];

  const moduleFacts = modules.map(collectModuleDefinitions);
  const sdkExportNames = collectSyntacticSdkExportNames(moduleFacts);
  for (const name of additionalSdkExportNames) {
    sdkExportNames.add(name);
  }
  for (const collected of moduleFacts) {
    aliases.push(...collected.aliases);
    for (const [name, definition] of collected.definitions) {
      if (isForwardingOnly(definition, name, collected.importNames)) {
        continue;
      }
      const entries = definitionsByName.get(name) ?? [];
      const sourceFile = definition.node.getSourceFile();
      entries.push({
        definition,
        line:
          sourceFile.getLineAndCharacterOfPosition(definition.node.getStart(sourceFile)).line + 1,
        path: collected.path,
      });
      definitionsByName.set(name, entries);
    }
  }

  const violations: ShadowNameViolation[] = [];
  for (const [name, definitions] of definitionsByName) {
    if (definitions.length < 2) {
      continue;
    }
    for (const definition of definitions) {
      violations.push({
        line: definition.line,
        name,
        path: definition.path,
        sdk: sdkExportNames.has(name),
      });
    }
  }
  return {
    aliases: aliases.toSorted(
      (left, right) =>
        left.path.localeCompare(right.path) || left.exportedName.localeCompare(right.exportedName),
    ),
    violations: violations.toSorted(compareViolation),
  };
}

function resolveRelativeModulePath(
  containingPath: string,
  moduleSpecifier: string,
  knownPaths: ReadonlySet<string>,
) {
  if (!moduleSpecifier.startsWith(".")) {
    return null;
  }
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(containingPath), moduleSpecifier),
  );
  const extensionless = base.replace(/\.(?:mjs|cjs|js)$/, "");
  const candidates = [
    base,
    `${extensionless}.ts`,
    `${extensionless}.mts`,
    `${extensionless}/index.ts`,
  ];
  return candidates.find((candidate) => knownPaths.has(candidate)) ?? null;
}

function collectSyntacticSdkExportNames(modules: ModuleFacts[]) {
  const knownPaths = new Set(modules.map((module) => module.path));
  const exportedNamesByPath = new Map(
    modules.map((module) => [module.path, new Set(module.exportedNames)]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const module of modules) {
      const exportedNames = exportedNamesByPath.get(module.path);
      if (!exportedNames) {
        continue;
      }
      for (const specifier of module.starReExports) {
        const targetPath = resolveRelativeModulePath(module.path, specifier, knownPaths);
        const targetNames = targetPath ? exportedNamesByPath.get(targetPath) : undefined;
        if (!targetNames) {
          continue;
        }
        for (const name of targetNames) {
          if (!exportedNames.has(name)) {
            exportedNames.add(name);
            changed = true;
          }
        }
      }
    }
  }
  const names = new Set<string>();
  for (const [modulePath, exportedNames] of exportedNamesByPath) {
    if (modulePath.startsWith("src/plugin-sdk/")) {
      for (const name of exportedNames) {
        names.add(name);
      }
    }
  }
  return names;
}

export function analyzeShadowNameSources(sources: ShadowNameSource[]) {
  const modules = sources.map((source) => ({
    path: source.path,
    sourceFile: ts.createSourceFile(
      source.path,
      source.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
  }));
  return analyzeShadowNameSourceFiles(modules);
}

export function toShadowNameDebtEntries(violations: ShadowNameViolation[]) {
  return violations
    .map(({ name, path: violationPath, sdk }) => ({ name, path: violationPath, sdk }))
    .toSorted(compareDebtEntry);
}

function debtEntryKey(entry: ShadowNameDebtEntry) {
  return `${entry.name}\0${entry.path}`;
}

export function findNewShadowNameDebt(
  current: ShadowNameDebtEntry[],
  baseline: ShadowNameDebtEntry[],
) {
  const baselineKeys = new Set(baseline.map(debtEntryKey));
  return current
    .filter((entry) => !baselineKeys.has(debtEntryKey(entry)))
    .toSorted(compareDebtEntry);
}

async function loadSourceModules(repoRoot: string) {
  const files = (
    await collectTypeScriptFilesFromRoots([path.join(repoRoot, "src")], {
      includeTests: true,
    })
  )
    .filter((filePath) => {
      const relativePath = normalizePath(path.relative(repoRoot, filePath));
      return (
        !relativePath.startsWith("src/test-utils/") &&
        !relativePath.endsWith(".test.ts") &&
        !relativePath.endsWith(".test-support.ts") &&
        !relativePath.endsWith(".test-helpers.ts")
      );
    })
    .toSorted();
  const modules = await Promise.all(
    files.map(async (filePath) => {
      const source = await fs.readFile(filePath, "utf8");
      return {
        path: normalizePath(path.relative(repoRoot, filePath)),
        sourceFile: ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true),
      };
    }),
  );
  return modules;
}

function collectExternalSdkExportNames(repoRoot: string, modules: SourceModule[]) {
  const roots = modules
    .filter(
      (module) =>
        module.path.startsWith("src/plugin-sdk/") &&
        module.sourceFile.statements.some(
          (statement) =>
            ts.isExportDeclaration(statement) &&
            !statement.exportClause &&
            statement.moduleSpecifier &&
            ts.isStringLiteralLike(statement.moduleSpecifier) &&
            !statement.moduleSpecifier.text.startsWith("."),
        ),
    )
    .map((module) => module.sourceFile.fileName);
  if (roots.length === 0) {
    return new Set<string>();
  }
  const configPath = ts.findConfigFile(
    repoRoot,
    (fileName) => ts.sys.fileExists(fileName),
    "tsconfig.json",
  );
  if (!configPath) {
    throw new Error("Could not find tsconfig.json");
  }
  const config = ts.readConfigFile(configPath, (fileName) => ts.sys.readFile(fileName));
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram({
    options: { ...parsed.options, noEmit: true, skipLibCheck: true },
    rootNames: roots,
  });
  const checker = program.getTypeChecker();
  const names = new Set<string>();
  for (const root of roots) {
    const sourceFile = program.getSourceFile(root);
    const symbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!symbol) {
      continue;
    }
    for (const exported of checker.getExportsOfModule(symbol)) {
      const target =
        (exported.flags & ts.SymbolFlags.Alias) !== 0
          ? checker.getAliasedSymbol(exported)
          : exported;
      if ((target.flags & ts.SymbolFlags.Value) !== 0 && exported.getName() !== "default") {
        names.add(exported.getName());
      }
    }
  }
  return names;
}

function baselinePath(repoRoot: string) {
  return path.join(repoRoot, ...debtBaselineRelativePath.split("/"));
}

async function readDebtBaseline(repoRoot: string) {
  try {
    return debtBaselineSchema.parse(JSON.parse(await fs.readFile(baselinePath(repoRoot), "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeDebtBaseline(repoRoot: string, entries: ShadowNameDebtEntry[]) {
  await fs.writeFile(baselinePath(repoRoot), `${JSON.stringify(entries, null, 2)}\n`);
}

function printAliasingReExports(aliases: AliasingReExport[]) {
  if (aliases.length === 0) {
    return;
  }
  console.log("Aliasing re-exports outside src/plugin-sdk/ (informational):");
  for (const alias of aliases) {
    console.log(
      `- ${alias.path}:${alias.line}: ${alias.importedName} as ${alias.exportedName} from ${JSON.stringify(alias.moduleSpecifier)}`,
    );
  }
}

export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const modules = await loadSourceModules(repoRoot);
  const analysis = analyzeShadowNameSourceFiles(
    modules,
    collectExternalSdkExportNames(repoRoot, modules),
  );
  const currentDebt = toShadowNameDebtEntries(analysis.violations);

  if (process.argv.includes("--update-debt-baseline")) {
    await writeDebtBaseline(repoRoot, currentDebt);
    const sdkCount = currentDebt.filter((entry) => entry.sdk).length;
    console.log(
      `Wrote ${debtBaselineRelativePath} (${currentDebt.length} violations, ${sdkCount} SDK-flagged)`,
    );
    printAliasingReExports(analysis.aliases);
    return;
  }

  const baseline = await readDebtBaseline(repoRoot);
  if (!baseline) {
    console.error(
      `Missing ${debtBaselineRelativePath}; run \`${debtBaselineRegenCommand}\` and commit it.`,
    );
    process.exitCode = 1;
    return;
  }
  const newDebt = findNewShadowNameDebt(currentDebt, baseline);
  printAliasingReExports(analysis.aliases);
  if (newDebt.length === 0) {
    const sdkCount = currentDebt.filter((entry) => entry.sdk).length;
    console.log(
      `shadow-name export guard passed (${currentDebt.length} current violations, ${sdkCount} SDK-flagged).`,
    );
    return;
  }

  const violationsByKey = new Map(
    analysis.violations.map((violation) => [debtEntryKey(violation), violation]),
  );
  console.error(
    `Found ${newDebt.length} same-name exported definition(s) not in ${debtBaselineRelativePath}:`,
  );
  for (const entry of newDebt) {
    const violation = violationsByKey.get(debtEntryKey(entry));
    console.error(`- ${entry.name} (sdk: ${entry.sdk}): ${entry.path}:${violation?.line ?? "?"}`);
  }
  console.error(
    `Give each behavior a unique exported name. If this is intentional existing debt, run \`${debtBaselineRegenCommand}\` and commit the reviewed baseline.`,
  );
  process.exitCode = 1;
}

runAsScript(import.meta.url, () => runWithFailedTrailer(failureTool, main));
