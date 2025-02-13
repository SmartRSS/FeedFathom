import eslintPluginSvelte from 'eslint-plugin-svelte';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import parser from '@typescript-eslint/parser';
import svelteConfig from './svelte.config.js';
import pluginPromise from 'eslint-plugin-promise';

const ignores = [
  '**/*.js',
  '.svelte-kit/**',
  'node_modules/**', // Ignore node_modules directory
  'dist/**',
  'bin/**',
];

const tsEslintConfigs = tseslint.configs.recommended.map((config) => ({
  ...config,
  languageOptions: {
    parser,
    parserOptions: {
      parser: '@typescript-eslint/parser',
      projectService: true,
      project: '.svelte-kit/tsconfig.json',
    },
  },
  rules: {
    ...config.rules,
    '@typescript-eslint/require-await': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/promise-function-async': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-unnecessary-condition': 'error',
    '@typescript-eslint/no-unused-expressions': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    // '@typescript-eslint/member-ordering': 'error',
    'no-loop-func': 'error',
    'no-inner-declarations': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
      },
    ],
  },
  ignores,
}));

const eslintSvelteConfig = {
  ...eslintPluginSvelte.configs['flat/recommended'],
  files: ['*.svelte'],
  parser: 'svelte-eslint-parser',
  parserOptions: {
    parser: '@typescript-eslint/parser',
    project: 'tsconfig.json',
    tsconfigRootDir: './',
    extraFileExtensions: ['.svelte'],
    svelteConfig,
  },
  ignores,
};

export default [
  {
    ...eslint.configs.recommended,
    ignores,
  },
  ...tsEslintConfigs,
  eslintSvelteConfig,
  pluginPromise.configs['flat/recommended'],
  { ...eslintConfigPrettier, ignores },
];
