import biome from "eslint-config-biome";
import canon from "eslint-config-canonical/configurations/index.js";
import eslintConfigPrettier from "eslint-config-prettier";
import svelte from 'eslint-plugin-svelte';
import globals from "globals";
import ts from 'typescript-eslint';
import svelteConfig from "./svelte.config.js";

import typescriptCompatibility from "eslint-config-canonical/configurations/typescript-compatibility.js";
import typescriptTypeChecking from "eslint-config-canonical/configurations/typescript-type-checking.js";

const { browser, canonical, module, node, regexp, typescript } = canon;


const canonicalArray = [
  browser.recommended,
  canonical.recommended,
  module.recommended,
  node.recommended,
  regexp.recommended,
  typescript.recommended,
  typescriptCompatibility.recommended,
  typescriptTypeChecking.recommended,
].map((config) => ({
  ...config,
  rules: Object.fromEntries(
    Object.entries({
      ...config.rules,
      ...eslintConfigPrettier.rules,
      quotes: "off",
      ...(config?.plugins?.["@typescript-eslint"]
        ? {
          "@typescript-eslint/no-unused-vars": [
            "error",
            {
              varsIgnorePattern: "^_",
              argsIgnorePattern: "^_",
            },
          ],
          "@typescript-eslint/naming-convention": [
            "error",
            {
              format: ["camelCase", "UPPER_CASE", "PascalCase"],
              selector: "variable",
              leadingUnderscore: "allowSingleOrDouble",
              trailingUnderscore: "allowSingleOrDouble",
            },
          ],
        }
        : {}),
    }).filter(([key]) => !key.startsWith("@stylistic/"))
  ),
}));

export default [
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  ...ts.configs.recommended,
  ...canonicalArray,
  ...svelte.configs.recommended.map(config => ({
    ...config,
    rules: {
      ...config.rules,
      "@typescript-eslint/no-unused-expressions": "off",
    }
  })),
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte'],
        parser: ts.parser,
        svelteConfig,
      }
    }
  },
  {
    rules: {
      "canonical/filename-match-regex": "off",
      "@typescript-eslint/no-redeclare": "off",
      "id-length": "off",
      "canonical/import-specifier-newline": "off",
      "canonical/destructuring-property-newline": "off",
      "no-inline-comments": "off",
      "canonical/id-match": "off",
      "no-control-regex": "off",
      "perfectionist/sort-imports": "off",
      "import/consistent-type-specifier-style": "off",
      "canonical/prefer-inline-type-import": "off",
      "perfectionist/sort-named-imports": "off",
      "import/extensions": "off",

      // Performance optimizations for slow rules
      "import/no-cycle": ["error", { ignoreExternal: true }],
      "n/no-extraneous-import": "off",
      "@typescript-eslint/naming-convention": "off",
    },
  },
  biome,
];
