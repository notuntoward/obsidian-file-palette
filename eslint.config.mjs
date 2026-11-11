import globals from 'globals';
import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'main.js'
    ]
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021
      }
    },
    plugins: {
      obsidianmd
    },
    rules: {
      'obsidianmd/commands/no-command-in-command-id': 'error',
      'obsidianmd/commands/no-command-in-command-name': 'error',
      'obsidianmd/commands/no-default-hotkeys': 'error',
      'obsidianmd/commands/no-plugin-id-in-command-id': 'error',
      'obsidianmd/commands/no-plugin-name-in-command-name': 'error',
      'obsidianmd/detach-leaves': 'error',
      'obsidianmd/editor-drop-paste': 'error',
      'obsidianmd/hardcoded-config-path': 'error',
      'obsidianmd/no-global-this': 'error',
      'obsidianmd/no-plugin-as-component': 'error',
      'obsidianmd/no-sample-code': 'error',
      'obsidianmd/no-tfile-tfolder-cast': 'error',
      'obsidianmd/no-unsupported-api': 'error',
      'obsidianmd/object-assign': 'error',
      'obsidianmd/platform': 'error',
      'obsidianmd/prefer-abstract-input-suggest': 'error',
      'obsidianmd/prefer-get-language': 'error',
      'obsidianmd/prefer-instanceof': 'error',
      'obsidianmd/prefer-window-timers': 'error',
      'obsidianmd/regex-lookbehind': 'error',
      'obsidianmd/validate-license': 'error',
      'obsidianmd/validate-manifest': 'error',
      'obsidianmd/settings-tab/no-deprecated-display': 'error',
      'obsidianmd/settings-tab/prefer-setting-definitions': 'error',
      'obsidianmd/settings-tab/prefer-update-over-display': 'error'
    }
  }
];
