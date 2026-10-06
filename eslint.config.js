const globals = require('globals');
const tseslint = require('typescript-eslint');
const executorBrowserGlobals = require('./config/executor-browser-globals');

const unusedVarsOptions = {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
};

module.exports = [
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'mobile_app/**',
      'node_modules/**',
      'releases/**',
      'scratch/**',
      'test-artifacts/**'
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.jest,
        Swal: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', unusedVarsOptions],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: [
      'controllers/executor*.js',
      'controllers/executor/**/*.js',
      'routes/executor*.js',
      'services/executor*.js',
      'middlewares/*Executor*.js',
      'utils/executor*.js',
      'tests/executor*.test.js',
      'tests/helpers/executor*.js',
      'public/js/executor/**/*.js',
    ],
    rules: {
      'no-unused-vars': ['error', unusedVarsOptions],
    },
  },
  ...executorBrowserGlobals,
  {
    files: ['public/js/executor/**/*.js'],
    languageOptions: {
      globals: {
        executorApiFetch: 'readonly',
        readExecutorApiResponse: 'readonly',
        bootstrap: 'readonly',
        Chart: 'readonly',
      },
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', unusedVarsOptions],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
