import biome from "eslint-config-biome";
import svelte from 'eslint-plugin-svelte';
import globals from "globals";
import ts from 'typescript-eslint';
import svelteConfig from "./svelte.config.js";


export default [
  {
		ignores: [
			"ext/**",
			"build/**",
			"migrations/**",
			"dist/**",
			".svelte-kit/**",
			"drizzle/**",
			"src/cloudflare/**",
			"bin/**",
			"drizzle.config.json",
			"postcss.config.js",
			"tailwind.config.js",
      "eslint.config.js"
		]
	},
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  ...ts.configs.recommended,

  {
    files: ["./src/**/*.ts"],
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
  ...svelte.configs.recommended.map(config => ({
    ...config,
    languageOptions: {
      ...config?.languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        project: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: {
      ...config.rules,
      "svelte/no-at-html-tags": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
    }
  })),
  {
    files: ['**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        project: false,
        extraFileExtensions: ['.svelte'],
        parser: ts.parser,
        svelteConfig,
      }
    }
  },
  {
    files: ['**/*.svelte'],
    processor: 'svelte/svelte',
    languageOptions: {
      parserOptions: {
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
        "off",
      ],
      "svelte/comment-directive": "off",
      "import/named": "off",
      "import/namespace": "off",
      "import/default": "off",
      "import/no-named-as-default-member": "off",
      "import/no-unresolved": "off",
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  biome,
];
