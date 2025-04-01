import biome from "eslint-config-biome";
import svelte from 'eslint-plugin-svelte';
import globals from "globals";
import ts from 'typescript-eslint';
import svelteConfig from "./svelte.config.js";


export default [
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  ...ts.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: ts.parser,
      parserOptions: {
        project: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: {
      ...ts.configs.strictTypeChecked.rules,
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: ts.parser,
      parserOptions: {
        project: true,
        tsconfigRootDir: process.cwd(),
      },
    },
  },
  ...svelte.configs.recommended.map(config => ({
    ...config,
    rules: {
      ...config.rules,
      "svelte/no-at-html-tags": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
    }
  })),
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        project: true,
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
      "n/no-extraneous-import": "off",
      "@typescript-eslint/naming-convention": "off",
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
    },
  },
  biome,
];
