import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import security from 'eslint-plugin-security';
import importPlugin from 'eslint-plugin-import';

export default [
  js.configs.recommended,
  // Base configuration for all files
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        // Node.js globals
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        // Browser globals for web-ui
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        TextDecoder: 'readonly',
        HTMLDivElement: 'readonly',
        SVGSVGElement: 'readonly',
        Event: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'security': security,
      'import': importPlugin,
    },
    rules: {
      // TypeScript rules
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn', // Made less strict
      
      // Security rules (more lenient for development)
      'security/detect-object-injection': 'warn',
      'security/detect-non-literal-fs-filename': 'off', // Common in Node.js apps
      'security/detect-unsafe-regex': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-child-process': 'warn',
      'security/detect-disable-mustache-escape': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-no-csrf-before-method-override': 'error',
      'security/detect-non-literal-regexp': 'off', // Common pattern in many applications
      'security/detect-non-literal-require': 'warn',
      'security/detect-possible-timing-attacks': 'off', // Often false positives
      'security/detect-pseudoRandomBytes': 'error',
      
      // Import rules
      'import/no-unresolved': 'off', // TypeScript handles this
      'import/order': ['warn', {
        'groups': ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'never',
      }],
      
      // General rules
      'no-console': 'off', // Allow console in server code
      'no-debugger': 'error',
      'no-alert': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'prefer-const': 'warn', // Made less strict
      'no-var': 'error',
      'eqeqeq': 'warn',
      'curly': 'warn', // Made less strict
      'no-throw-literal': 'error',
      'no-unused-vars': 'off', // Use TypeScript version instead
      'no-empty': 'warn', // Made less strict
    },
  },
  {
    files: ['**/*.js'],
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
    },
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'coverage/**',
      '**/*.d.ts',
      'packages/*/dist/**',
      'packages/*/node_modules/**',
    ],
  },
];