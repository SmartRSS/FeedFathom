import { readFileSync } from "node:fs";
import { definePlugin, defineRule } from "@oxlint/plugins";

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

const awaitAsyncExpect = defineRule({
  meta: {
    docs: {
      description:
        "Require `await` on `expect(...).rejects` and `expect(...).resolves`, which bun:test leaves pending otherwise.",
    },
    messages: {
      floating:
        "Write `await expect(...).{{matcher}}...`. Without the `await` the test ends before the promise settles, so the assertion can never fail it.",
    },
    type: "problem",
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (node.property.type !== "Identifier") return;
        const matcher = node.property.name;
        if (matcher !== "rejects" && matcher !== "resolves") return;
        const subject = node.object;
        if (subject.type !== "CallExpression") return;
        if (subject.callee.type !== "Identifier") return;
        if (subject.callee.name !== "expect") return;
        let chain = node;
        while (
          (chain.parent.type === "MemberExpression" &&
            chain.parent.object === chain) ||
          (chain.parent.type === "CallExpression" &&
            chain.parent.callee === chain)
        ) {
          chain = chain.parent;
        }
        if (chain.parent.type !== "ExpressionStatement") return;
        context.report({ data: { matcher }, messageId: "floating", node: chain });
      },
    };
  },
});

/**
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

/**
 * @param {unknown} options
 * @returns {Record<string, string[]>}
 */
function readFeatureDag(options) {
  if (typeof options !== "object" || options === null) return {};
  if (!("features" in options)) return {};
  const { features } = options;
  if (typeof features !== "object" || features === null) return {};
  /** @type {Record<string, string[]>} */
  const dag = {};
  for (const [name, edges] of Object.entries(features)) {
    dag[name] = Array.isArray(edges)
      ? edges.filter((edge) => typeof edge === "string")
      : [];
  }
  return dag;
}

/**
 * @param {string} filename
 * @returns {string}
 */
function repoRelative(filename) {
  const path = filename.replaceAll("\\", "/");
  if (path.startsWith("src/")) return path;
  const index = path.lastIndexOf("/src/");
  return index === -1 ? "" : path.slice(index + 1);
}

/**
 * @param {string} path
 * @returns {{ kind: string, name: string } | null}
 */
function layerOf(path) {
  if (!path.startsWith("src/")) return null;
  const segments = path.split("/");
  if (segments.length === 2) return { kind: "root", name: "" };
  const group = segments[1] ?? "";
  if (group === "shared" || group === "platform") {
    return { kind: group, name: "" };
  }
  if (group === "features") return { kind: "feature", name: segments[2] ?? "" };
  if (group === "spa" || group === "extension") {
    return { kind: "client", name: group };
  }
  return null;
}

/**
 * @param {string} from
 * @param {string} specifier
 * @returns {string}
 */
function resolveRelative(from, specifier) {
  const segments = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

/**
 * @type {Record<string, string>}
 */
const SUBPATH_PREFIXES = Object.fromEntries(
  Object.entries(
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).imports,
  ).map(([alias, target]) => [
    alias.replace(/\*$/, ""),
    String(target).replace(/^\.\//, "").replace(/\*$/, ""),
  ]),
);

/**
 * @param {string} from
 * @param {string} specifier
 * @returns {string | null}
 */
function targetOf(from, specifier) {
  for (const [prefix, root] of Object.entries(SUBPATH_PREFIXES)) {
    if (specifier.startsWith(prefix)) {
      return root + specifier.slice(prefix.length);
    }
  }
  return specifier.startsWith(".") ? resolveRelative(from, specifier) : null;
}

/**
 * @param {{ kind: string, name: string }} from
 * @param {{ kind: string, name: string }} to
 * @param {Record<string, string[]>} dag
 * @returns {boolean}
 */
function allows(from, to, dag) {
  switch (from.kind) {
    case "root": {
      return true;
    }
    case "shared": {
      return to.kind === "shared";
    }
    case "platform": {
      return to.kind === "shared" || to.kind === "platform";
    }
    case "feature": {
      if (to.kind === "shared" || to.kind === "platform") return true;
      if (to.kind !== "feature") return false;
      if (to.name === from.name) return true;
      return (dag[from.name] ?? []).includes(to.name);
    }
    case "client": {
      return to.kind === "shared" || (to.kind === "client" && to.name === from.name);
    }
    default: {
      return false;
    }
  }
}

/**
 * @param {{ kind: string, name: string }} layer
 * @returns {string}
 */
function describeLayer(layer) {
  if (layer.kind === "feature") return `feature '${layer.name}'`;
  if (layer.kind === "client") return `client '${layer.name}'`;
  if (layer.kind === "root") return "the composition root";
  return `the ${layer.kind} layer`;
}

const layerBoundaries = defineRule({
  meta: {
    docs: {
      description:
        "Require imports to follow the declared layer direction and feature DAG.",
    },
    messages: {
      forbidden:
        "{{from}} may not import {{to}}. See CONTEXT.md for the layer direction; if this edge is legitimate, declare it in the feedfathom/layer-boundaries options.",
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          features: {
            additionalProperties: { items: { type: "string" }, type: "array" },
            description:
              "The declared feature-to-feature edges, as feature name -> features it may import. Must stay acyclic.",
            type: "object",
          },
        },
        type: "object",
      },
    ],
    type: "problem",
  },
  createOnce(context) {
    /** @type {Record<string, string[]>} */
    let dag = {};
    let path = "";
    /** @type {{ kind: string, name: string } | null} */
    let from = null;

    /**
     * @param {{ source: { value: unknown } | null }} node
     */
    const check = (node) => {
      if (!from) return;
      const specifier = node.source?.value;
      if (typeof specifier !== "string") return;
      const target = targetOf(path, specifier);
      if (target === null) return;
      const to = layerOf(target);
      if (!to || allows(from, to, dag)) return;
      context.report({
        data: { from: describeLayer(from), to: describeLayer(to) },
        messageId: "forbidden",
        node,
      });
    };

    return {
      before() {
        dag = readFeatureDag(context.options[0]);
        path = repoRelative(context.filename);
        from = path.endsWith(".test.ts") ? null : layerOf(path);
      },
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
      ImportDeclaration: check,
      ImportExpression: check,
    };
  },
});

const directivePatterns = [
  /^\s*(?:eslint|oxlint)-(?:disable|enable)/,
  /^\s*@ts-expect-error/,
  /^\s*[#@]__(?:PURE|NO_SIDE_EFFECTS)__\s*$/,
  /^\/\s*<reference /,
];

/**
 * @param {string} value
 * @returns {boolean}
 */
function isTypeOnlyJSDoc(value) {
  if (!value.startsWith("*")) return false;
  const lines = value
    .split("\n")
    .map((line) => line.replace(/^\s*\*+/, "").trim())
    .filter((line) => line !== "" && line !== "/");
  if (lines.length === 0) return false;
  return lines.every((line) =>
    /^@(?:type|param|returns|typedef|template)\b/.test(line),
  );
}

/**
 * @param {{ type: string, value: string }} comment
 * @returns {boolean}
 */
function isDirective(comment) {
  if (comment.type === "Shebang") return true;
  if (directivePatterns.some((pattern) => pattern.test(comment.value))) {
    return true;
  }
  return comment.type === "Block" && isTypeOnlyJSDoc(comment.value);
}

/**
 * @param {unknown} options
 * @returns {Record<string, number>}
 */
function readBudget(options) {
  if (typeof options !== "object" || options === null) return {};
  if (!("budget" in options)) return {};
  const { budget } = options;
  if (typeof budget !== "object" || budget === null) return {};
  /** @type {Record<string, number>} */
  const result = {};
  for (const [path, count] of Object.entries(budget)) {
    if (typeof count === "number") result[path] = count;
  }
  return result;
}

const noComments = defineRule({
  meta: {
    docs: {
      description:
        "Disallow prose comments. Record decisions in docs/adr/ instead; lint directives stay allowed.",
    },
    messages: {
      comment:
        "Comments are banned. Delete it if the code already says it; move a decision into docs/adr/; file an issue for a workaround. See docs/adr/0023-no-comments-in-source.md.",
      overBudget:
        "This file may keep {{budget}} comment(s) from before the ban and has {{count}}. Delete the new comment instead of raising the budget.",
      staleBudget:
        "This file has {{count}} comment(s) but its budget in .oxlintrc.json is {{budget}}. Lower the budget to {{count}} so the deleted comments cannot come back.",
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          budget: {
            additionalProperties: { minimum: 0, type: "integer" },
            description:
              "Path suffix -> number of pre-existing comments the file may keep. Only ever lower these.",
            type: "object",
          },
        },
        type: "object",
      },
    ],
    type: "suggestion",
  },
  createOnce(context) {
    return {
      "Program:exit"(node) {
        const path = context.filename.replaceAll("\\", "/");
        const budgets = readBudget(context.options[0]);
        const key = Object.keys(budgets).find((suffix) =>
          path.endsWith(suffix),
        );
        const budget = key === undefined ? 0 : (budgets[key] ?? 0);
        const comments = context.sourceCode
          .getAllComments()
          .filter((comment) => !isDirective(comment));
        if (budget === 0) {
          for (const comment of comments) {
            context.report({ messageId: "comment", node: comment });
          }
          return;
        }
        const data = { budget: String(budget), count: String(comments.length) };
        if (comments.length > budget) {
          context.report({ data, messageId: "overBudget", node });
        } else if (comments.length < budget) {
          context.report({ data, messageId: "staleBudget", node });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: "feedfathom" },
  rules: {
    "await-async-expect": awaitAsyncExpect,
    "layer-boundaries": layerBoundaries,
    "no-barrel-file": noBarrelFile,
    "no-comments": noComments,
    "schema-compile-module-scope": schemaCompileModuleScope,
  },
});
