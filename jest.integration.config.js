module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.integration.test.js'],
  testTimeout: 30000,
  collectCoverageFrom: [
    'src/api/**/*.js',
    '!src/api/**/*.test.js',
    '!src/api/**/*.integration.test.js'
  ],
  setupFilesAfterEnv: [
    '<rootDir>/jest.integration.setup.js'
  ],
  globalSetup: '<rootDir>/jest.integration.global-setup.js',
  globalTeardown: '<rootDir>/jest.integration.global-teardown.js',
  verbose: true,
  forceExit: true,
  detectOpenHandles: true,
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/build/'
  ],
  moduleFileExtensions: ['js', 'json', 'node'],
  transform: {},
  coverageDirectory: 'coverage/integration',
  coverageReporters: ['text', 'lcov', 'html'],
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: 'reports/integration', outputName: 'junit.xml' }]
  ]
};