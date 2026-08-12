#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = resolve(process.argv[2] ?? scriptRoot);
const packageJsonPath = resolve(packageRoot, 'package.json');

function fail(message) {
  throw new Error(`Public API documentation audit failed: ${message}`);
}

if (!existsSync(packageJsonPath)) fail(`missing package.json under ${packageRoot}`);
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
if (typeof packageJson.types !== 'string') fail('package.json does not declare a types entry');
const declarationPath = resolve(packageRoot, packageJson.types);
if (!existsSync(declarationPath)) fail(`missing declaration entry ${declarationPath}`);

const program = ts.createProgram({
  rootNames: [declarationPath],
  options: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    strict: true,
  },
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length > 0) {
  const rendered = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (value) => value,
    getCurrentDirectory: () => packageRoot,
    getNewLine: () => '\n',
  });
  fail(`declaration graph does not typecheck\n${rendered}`);
}

const checker = program.getTypeChecker();
const rootSource = program.getSourceFile(declarationPath);
if (!rootSource) fail(`compiler did not load ${declarationPath}`);
const rootSymbol = checker.getSymbolAtLocation(rootSource);
if (!rootSymbol) fail('package-root declaration is not an external module');
const exports = checker
  .getExportsOfModule(rootSymbol)
  .sort((left, right) => left.getName().localeCompare(right.getName()));
const exportedTypeNames = new Set(exports.map((symbol) => symbol.getName()));
const valueExports = exports
  .filter((symbol) => (resolveAlias(symbol).flags & ts.SymbolFlags.Value) !== 0)
  .map((symbol) => symbol.getName())
  .sort();
const concreteStandardErrors = new Set([
  'AggregateError',
  'DOMException',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

function resolveAlias(symbol) {
  let current = symbol;
  const seen = new Set();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0) {
    if (seen.has(current)) fail(`cyclic declaration alias for ${symbol.getName()}`);
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function documentationOf(value) {
  return ts.displayPartsToString(value.getDocumentationComment(checker)).trim();
}

function tagsOf(value) {
  return value.getJsDocTags(checker);
}

function tagText(tag) {
  return (tag.text ?? [])
    .map((part) => part.text)
    .join('')
    .trim();
}

function parameterNameOf(tag) {
  const part = (tag.text ?? []).find((item) => item.kind === 'parameterName');
  if (!part) return undefined;
  return part.text.replace(/^\[/u, '').replace(/\]$/u, '').split('=')[0];
}

function hasUsefulTagDescription(tag) {
  if (tag.name === 'param') {
    return (tag.text ?? []).some(
      (part) => part.kind !== 'parameterName' && part.kind !== 'space' && part.text.trim() !== '-'
    );
  }
  return tagText(tag).length > 0;
}

function thrownTypeOf(tag) {
  const match = /^\{([^{}]+)\}(?:\s+|$)/u.exec(tagText(tag));
  return match?.[1]?.trim();
}

function isPromiseSignature(signature) {
  const returnType = checker.getReturnTypeOfSignature(signature);
  const promisedType = checker.getPromisedTypeOfPromise(returnType);
  return promisedType !== undefined;
}

function signatureLabel(owner, kind, index, count) {
  if (count === 1) return owner;
  return `${owner} ${kind} overload ${index + 1}`;
}

const issues = [];
let callableSignatureCount = 0;
let constructSignatureCount = 0;
let callableMemberCount = 0;

function auditTagsForSignature({ owner, signature, tags, kind, index, count, requireThrows }) {
  const label = signatureLabel(owner, kind, index, count);
  const parameters = signature.parameters.map((parameter) => parameter.getName());
  const parameterTags = tags.filter((tag) => tag.name === 'param');
  const documentedNames = parameterTags.map(parameterNameOf);

  const duplicateNames = documentedNames.filter(
    (name, position) => name !== undefined && documentedNames.indexOf(name) !== position
  );
  const missingNames = parameters.filter((name) => !documentedNames.includes(name));
  const unexpectedNames = documentedNames.filter(
    (name) => name === undefined || !parameters.includes(name)
  );
  if (missingNames.length > 0 || unexpectedNames.length > 0 || duplicateNames.length > 0) {
    issues.push(
      `${label}: @param names must exactly match (${parameters.join(', ') || 'none'}); ` +
        `documented (${documentedNames.map((name) => name ?? '<unnamed>').join(', ') || 'none'})`
    );
  }
  for (const tag of parameterTags) {
    if (!hasUsefulTagDescription(tag)) {
      issues.push(`${label}: @param ${parameterNameOf(tag) ?? '<unnamed>'} has no contract text`);
    }
  }

  if (kind === 'call') {
    const returnTags = tags.filter((tag) => tag.name === 'returns' || tag.name === 'return');
    if (returnTags.length !== 1 || !hasUsefulTagDescription(returnTags[0])) {
      issues.push(`${label}: requires exactly one nonempty @returns contract`);
    }
  }

  const throwsTags = tags.filter((tag) => tag.name === 'throws' || tag.name === 'exception');
  if (requireThrows && throwsTags.length === 0) {
    issues.push(`${label}: missing typed @throws contract`);
  }
  for (const tag of throwsTags) {
    const thrownType = thrownTypeOf(tag);
    if (
      !thrownType ||
      !/^(?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*(?:\s*\|\s*(?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*)*$/u.test(
        thrownType
      )
    ) {
      issues.push(`${label}: @throws must start with a concrete {Type}`);
      continue;
    }
    for (const namedType of thrownType.split('|').map((value) => value.trim())) {
      if (namedType === 'Error') {
        issues.push(`${label}: @throws {Error} is not an actionable concrete error contract`);
      } else if (!exportedTypeNames.has(namedType) && !concreteStandardErrors.has(namedType)) {
        issues.push(`${label}: @throws type ${namedType} is not exported by the package root`);
      }
    }
    const description = tagText(tag)
      .slice(tagText(tag).indexOf('}') + 1)
      .trim();
    if (description.length === 0) {
      issues.push(`${label}: @throws {${thrownType}} has no failure condition or recovery text`);
    }
  }
}

function auditSignatures(
  owner,
  signatures,
  kind,
  fallbackTags,
  requireThrowsForName = false,
  allowSingleFallback = false
) {
  signatures.forEach((signature, index) => {
    // A class-level constructor contract is the canonical JSDoc location for a class with
    // one constructor. Overloads and ordinary call signatures must each own their tags so
    // documentation from a sibling signature cannot mask an undocumented overload.
    const ownTags = tagsOf(signature);
    const tags =
      (kind === 'construct' || allowSingleFallback) &&
      signatures.length === 1 &&
      ownTags.length === 0
        ? fallbackTags
        : ownTags;
    if (
      documentationOf(signature).length === 0 &&
      !((kind === 'construct' || allowSingleFallback) && signatures.length === 1)
    ) {
      issues.push(
        `${signatureLabel(owner, kind, index, signatures.length)}: missing contract JSDoc`
      );
    }
    auditTagsForSignature({
      owner,
      signature,
      tags,
      kind,
      index,
      count: signatures.length,
      requireThrows: kind === 'call' && (requireThrowsForName || isPromiseSignature(signature)),
    });
  });
}

function interfaceDeclarationsOf(symbol) {
  return (symbol.getDeclarations() ?? []).filter(ts.isInterfaceDeclaration);
}

function auditCallableInterfaceMembers(publicName, target) {
  const interfaces = interfaceDeclarationsOf(target);
  if (interfaces.length === 0) return;
  const declaredType = checker.getDeclaredTypeOfSymbol(target);
  for (const member of checker
    .getPropertiesOfType(declaredType)
    .sort((left, right) => left.getName().localeCompare(right.getName()))) {
    const declarations = member.getDeclarations() ?? [];
    if (!declarations.some((declaration) => interfaces.includes(declaration.parent))) continue;
    const declaration = declarations[0];
    if (!declaration) continue;
    const memberType = checker.getTypeOfSymbolAtLocation(member, declaration);
    const signatures = checker.getNonNullableType(memberType).getCallSignatures();
    if (signatures.length === 0) continue;

    const memberName = `${publicName}.${member.getName()}`;
    callableMemberCount += 1;
    if (documentationOf(member).length === 0) {
      issues.push(`${memberName}: missing contract JSDoc`);
    }
    auditSignatures(
      memberName,
      signatures,
      'call',
      tagsOf(member),
      memberName === 'SessionReadContext.releaseSession',
      true
    );
  }
}

for (const exported of exports) {
  const publicName = exported.getName();
  const target = resolveAlias(exported);
  const declarations = target.getDeclarations() ?? [];
  const declaration = declarations[0];
  if (!declaration) {
    issues.push(`${publicName}: declaration cannot be resolved`);
    continue;
  }

  if (documentationOf(target).length === 0) issues.push(`${publicName}: missing contract JSDoc`);

  const type = checker.getTypeOfSymbolAtLocation(target, declaration);
  const callSignatures = type.getCallSignatures();
  const constructSignatures = type.getConstructSignatures();
  callableSignatureCount += callSignatures.length;
  constructSignatureCount += constructSignatures.length;
  auditSignatures(publicName, callSignatures, 'call', tagsOf(target));
  auditSignatures(publicName, constructSignatures, 'construct', tagsOf(target));
  auditCallableInterfaceMembers(publicName, target);
}

if (issues.length > 0) fail(`\n- ${issues.join('\n- ')}`);

process.stdout.write(
  `${JSON.stringify({
    declarationPath,
    exportCount: exports.length,
    documented: exports.length,
    callableSignatureCount,
    constructSignatureCount,
    callableMemberCount,
    valueExports,
  })}\n`
);
