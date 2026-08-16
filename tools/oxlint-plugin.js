import { definePlugin, defineRule } from "@oxlint/plugins";

// Custom rules for conventions with no built-in oxlint equivalent. Each was
// measured against the tree before it was written, and each is at zero
// violations -- they lock in what the codebase already does rather than
// scheduling a refactor.
//
// All four use the `createOnce` API rather than the ESLint-compatible
// `create`. `createOnce` runs once per lint run instead of once per file,
// which lets oxlint statically analyse which node types a rule wants and skip
// traversal when they are absent. Per-file state must therefore be reset in
// `before()`, never in the `createOnce` body.
//
// Node type names are ESTree-standard (`MemberExpression`, not
// `StaticMemberExpression`); verified against oxlint 1.78.
//
// This file is JavaScript, not TypeScript, on purpose. oxlint loads plugins
// with whatever runtime invokes it: `bun run oxlint` uses Bun, but the bin's
// shebang is `#!/usr/bin/env node`, and the VS Code Oxc extension uses its own
// Node. Node only strips TypeScript types from 22.18/20.19 onward, so a .ts
// plugin fails with an opaque "Failed to parse oxlint configuration file" on
// older Node. Plain JS with JSDoc types loads everywhere.

/**
 * `Schema.Compile()` builds a validator. Calling it inside a function body
 * rebuilds that validator on every single call -- a silent performance cliff
 * that reads as completely normal in review. All 19 existing call sites are at
 * module scope.
 */
const schemaCompileModuleScope = defineRule({
  meta: {
    docs: {
      description:
        "Require `Schema.Compile()` at module scope so the validator is compiled once, not per call.",
    },
    messages: {
      nested:
        "`Schema.Compile()` must be called at module scope -- inside a function it recompiles the validator on every call. Hoist it to a module-level `const`.",
    },
    type: "problem",
  },
  createOnce(context) {
    let functionDepth = 0;
    const enter = () => void (functionDepth += 1);
    const exit = () => void (functionDepth -= 1);

    return {
      before() {
        functionDepth = 0;
      },
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": exit,
      CallExpression(node) {
        if (functionDepth === 0) return;
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (callee.object.type !== "Identifier") return;
        if (callee.object.name !== "Schema") return;
        if (callee.property.type !== "Identifier") return;
        if (callee.property.name !== "Compile") return;
        context.report({ messageId: "nested", node });
      },
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": exit,
      FunctionExpression: enter,
      "FunctionExpression:exit": exit,
    };
  },
});

/**
 * Route dependency fields are structurally narrowed -- `Pick<Service, "method">`
 * or an inline literal -- never the whole service type. That is what keeps
 * route tests to small fakes; a bare service type forces every test double for
 * the route to implement the entire interface.
 */
const routeDepsNarrowed = defineRule({
  meta: {
    docs: {
      description:
        "Require `*RouteDependencies` fields to narrow services structurally instead of naming a whole service type.",
    },
    messages: {
      bare: '`{{field}}` takes the whole `{{service}}`. Narrow it to the methods this route uses -- `Pick<{{service}}, "someMethod">` -- so test doubles stay small.',
    },
    type: "suggestion",
  },
  createOnce(context) {
    return {
      TSTypeAliasDeclaration(node) {
        if (!node.id.name.endsWith("RouteDependencies")) return;
        if (node.typeAnnotation.type !== "TSTypeLiteral") return;
        for (const member of node.typeAnnotation.members) {
          if (member.type !== "TSPropertySignature") continue;
          const annotation = member.typeAnnotation?.typeAnnotation;
          if (annotation?.type !== "TSTypeReference") continue;
          if (annotation.typeName.type !== "Identifier") continue;
          const service = annotation.typeName.name;
          if (!/(?:DataService|Service)$/u.test(service)) continue;
          // `Pick<Service, ...>` / `Omit<Service, ...>` carry type arguments;
          // a bare reference has none.
          if (annotation.typeArguments) continue;
          const field =
            member.key.type === "Identifier" ? member.key.name : "field";
          context.report({
            data: { field, service },
            messageId: "bare",
            node: member,
          });
        }
      },
    };
  },
});

/**
 * Package imports before relative imports. oxlint has no `import/order` rule,
 * and this holds in every file under `src/`.
 */
const importGrouping = defineRule({
  meta: {
    docs: {
      description: "Require package imports to come before relative imports.",
    },
    messages: {
      outOfOrder:
        'Package import "{{source}}" must come before relative imports.',
    },
    type: "layout",
  },
  createOnce(context) {
    let seenRelative = false;

    return {
      before() {
        seenRelative = false;
      },
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string") return;
        if (source.startsWith(".")) {
          seenRelative = true;
          return;
        }
        if (seenRelative) {
          context.report({
            data: { source },
            messageId: "outOfOrder",
            node,
          });
        }
      },
    };
  },
});

/**
 * Narrow the rule's untyped options into the allow list, without asserting.
 * @param {unknown} options
 * @returns {string[]}
 */
function readAllowList(options) {
  if (typeof options !== "object" || options === null) return [];
  if (!("allow" in options)) return [];
  const { allow } = options;
  if (!Array.isArray(allow)) return [];
  return allow.filter((entry) => typeof entry === "string");
}

/**
 * A barrel is a module that only re-exports other modules. `oxc/no-barrel-file`
 * only counts `export * from`, of which this repo has none, so it can never
 * fire here -- this catches the named-re-export form too.
 */
const noBarrelFile = defineRule({
  meta: {
    docs: {
      description:
        "Disallow modules that exist only to re-export other modules.",
    },
    messages: {
      barrel:
        "This module only re-exports {{count}} binding(s) from other modules. Import from the defining module instead of adding a barrel.",
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          allow: {
            description:
              "Path suffixes exempt from the rule, e.g. a schema entry point a tool requires.",
            items: { type: "string" },
            type: "array",
          },
        },
        type: "object",
      },
    ],
    type: "suggestion",
  },
  createOnce(context) {
    /** @type {Set<string>} */
    let importedNames = new Set();
    let reexported = 0;
    let ownExports = 0;
    let exempt = false;

    return {
      before() {
        importedNames = new Set();
        reexported = 0;
        ownExports = 0;
        const allow = readAllowList(context.options[0]);
        const path = context.filename.replaceAll("\\", "/");
        exempt = allow.some((suffix) => path.endsWith(suffix));
      },
      ExportAllDeclaration() {
        reexported += 1;
      },
      ExportDefaultDeclaration() {
        ownExports += 1;
      },
      ExportNamedDeclaration(node) {
        // `export const x = ...` / `export function f() {}` declares its own.
        if (node.declaration) {
          ownExports += 1;
          return;
        }
        for (const specifier of node.specifiers) {
          const local = specifier.local;
          const isReexport = node.source
            ? true
            : local.type === "Identifier" && importedNames.has(local.name);
          if (isReexport) reexported += 1;
          else ownExports += 1;
        }
      },
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          importedNames.add(specifier.local.name);
        }
      },
      "Program:exit"(node) {
        if (exempt || ownExports > 0 || reexported === 0) return;
        context.report({
          data: { count: String(reexported) },
          messageId: "barrel",
          node,
        });
      },
    };
  },
});

export default definePlugin({
  meta: { name: "feedfathom" },
  rules: {
    "import-grouping": importGrouping,
    "no-barrel-file": noBarrelFile,
    "route-deps-narrowed": routeDepsNarrowed,
    "schema-compile-module-scope": schemaCompileModuleScope,
  },
});
