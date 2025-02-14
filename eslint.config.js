import eslintConfigPrettier from "eslint-config-prettier";
import eslintPluginSvelte from "eslint-plugin-svelte";
import globals from "globals";
import svelteConfig from "./svelte.config.js";
import auto from "eslint-config-canonical/configurations/auto.js";

const ignores = [
  "**/*.js",
  ".svelte-kit/**",
  "node_modules/**", // Ignore node_modules directory
  "dist/**",
  "bin/**",
];

const eslintSvelteConfig = {
  ...eslintPluginSvelte.configs["flat/recommended"],
  files: ["*.svelte"],
  ignores,
  parser: "svelte-eslint-parser",
  parserOptions: {
    extraFileExtensions: [".svelte"],
    parser: "@typescript-eslint/parser",
    project: "tsconfig.json",
    svelteConfig,
    tsconfigRootDir: "./",
  },
};

const autoConfigs = [];
auto.forEach((config) => {
  if (config.plugins.prettier) {
    return;
  }
  autoConfigs.push({
    ...config,
    ignores,
    rules: {
      ...config.rules,
      ...eslintConfigPrettier.rules,
      quotes: "off",
      ...(config.plugins["@typescript-eslint"] ? {
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
            format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
            selector: 'variable',
            leadingUnderscore: "allowSingleOrDouble",
            trailingUnderscore: "allowSingleOrDouble",
          },
        ],
      } : {})
    },
  });
});

export default [
  { files: ["./src/**/*.{js,mjs,cjs,ts}"] },
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  eslintSvelteConfig,
  ...autoConfigs,
  {
    rules: {
      "canonical/filename-match-regex": "off",
      "@typescript-eslint/no-redeclare": "off",
      "id-length": "off",
      "canonical/import-specifier-newline": "off",
      "canonical/destructuring-property-newline": "off",
      "no-inline-comments": "off", // covered by @stylistic/line-comment-position
      "canonical/id-match": "off",
    },
  },
];
