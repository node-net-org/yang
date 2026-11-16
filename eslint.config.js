import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js', 'scripts/*.cjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      'no-restricted-imports': [
        'error',
        {
          // @node-net/yang is protocol-agnostic (docs/rfcs.md).
          patterns: [{ regex: '^@node-net/netconf(-server)?(/|$)', message: '@node-net/yang must never depend on @node-net/netconf or @node-net/netconf-server.' }],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // require(esm) fails for modules with top-level await, and CommonJS consumers must be able to load us.
          selector: 'AwaitExpression:not(:function AwaitExpression)',
          message: 'Top-level await breaks require(esm) for CommonJS consumers.',
        },
        {
          selector: 'ForOfStatement[await=true]:not(:function ForOfStatement)',
          message: 'Top-level for-await breaks require(esm) for CommonJS consumers.',
        },
        {
          // A listener-less 'error' event crashes Node. Never emit one.
          selector: "CallExpression[callee.property.name='emit'][arguments.0.value='error']",
          message: "Do not emit 'error' events; report failures through promises or the 'closed' event.",
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // @node-net/yang/core runs in any JavaScript runtime (src/core.ts): no Node
    // built-ins and no Node-only globals. Only the Node entry and fileSource
    // are exempt. portable:check enforces the same by bundling and running it.
    files: ['src/**/*.ts'],
    ignores: ['src/index.ts', 'src/source/files.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ regex: '^node:', message: 'Portable code (@node-net/yang/core) must not import Node built-ins.' }] },
      ],
      'no-restricted-globals': [
        'error',
        ...['Buffer', 'process', 'require', '__dirname', '__filename', 'setImmediate', 'clearImmediate', 'global'].map((name) => ({
          name,
          message: 'Portable code (@node-net/yang/core) must not use Node-only globals.',
        })),
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', 'scripts/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Developer scripts run directly with node: console output and top-level await are fine.
    files: ['scripts/*.mjs'],
    rules: { 'no-console': 'off', 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off', 'no-console': 'off' },
  },
);
