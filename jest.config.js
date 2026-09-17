module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js', '**/tests/**/*.test.ts'],
  testPathIgnorePatterns: ['<rootDir>/delivery/', '<rootDir>/ahram_app/', '<rootDir>/node_modules/'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.jsx?$': 'babel-jest',
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  moduleNameMapper: {
    '^.*/Domain/Entities/User$': '<rootDir>/models/User',
    '^.*/Domain/Entities/Employee$': '<rootDir>/models/Employee',
    '^.*/Domain/Entities/Transaction$': '<rootDir>/models/Transaction',
    '^.*/Domain/Entities/Ledger$': '<rootDir>/models/Ledger',
    '^.*/Domain/Entities/JournalEvent$': '<rootDir>/models/JournalEvent',
    '^.*/Domain/Entities/Tenant$': '<rootDir>/models/Tenant',
    '^uuid$': '<rootDir>/node_modules/uuid/dist-node/index.js'
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(uuid)/)'
  ]
};
