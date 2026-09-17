import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-types/**', 'node_modules/**', 'plugins/**'] },

  // Config files and build scripts are outside the TypeScript projects, so they get
  // untyped linting only.
  {
    files: ['**/*.{js,mjs,cjs}', '*.config.ts'],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },

  // Product code: fully type-aware.
  {
    files: ['{shared,daemon,extension}/src/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Terminal output and project config are untrusted. Nothing is ever built into a
      // shell string or evaluated. See docs/05-security.md.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      /**
       * The window's own names, which a local of the same name can stop shadowing without a word.
       *
       * A menu's entries each called a local `close()` before acting. The local was replaced by a
       * shared helper and the calls were left behind: `close` is `window.close` in a browser, so
       * every entry in that menu became "close the tab". It typechecked, and the only sign was a
       * page that stopped answering. Naming these deliberately is cheap; finding that again is
       * not. `window.close()` still works when it is meant, and says so.
       */
      'no-restricted-globals': [
        'error',
        { name: 'close', message: 'Say window.close() when the tab is what you mean.' },
        { name: 'open', message: 'Say window.open() when a window is what you mean.' },
        { name: 'name', message: 'Say window.name when the window is what you mean.' },
        { name: 'status', message: 'Say window.status when the window is what you mean.' },
      ],
    },
  },

  // Command line entry points, whose entire job is writing to stdout.
  {
    files: ['daemon/src/*-cli.ts'],
    rules: { 'no-console': 'off' },
  },
);
