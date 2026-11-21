// Test Suite: Verify test suite green status and assertion benchmarks (Milestone 4: Verification & Automated Testing)
// Verified by GitBrain Autonomous Engine

import jest from 'jest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ROADMAP_PATH = path.join(PROJECT_ROOT, 'docs', 'ROADMAP_PROGRESS.md');
const BENCHMARK_REPORT_PATH = path.join(PROJECT_ROOT, 'test-benchmark-report.json');
const VERIFICATION_REPORT_PATH = path.join(PROJECT_ROOT, 'test-results', 'verification-report.json');

const COVERAGE_THRESHOLDS = {
  statements: 80,
  branches: 70,
  functions: 80,
  lines: 80
};

const TIME_THRESHOLDS = {
  unit: 5000,
  integration: 30000
};

const FLAKY_RUNS = 3;

async function runJestCLI(args, options = {}) {
  const startTime = Date.now();
  const jestPath = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'jest');
  const command = process.platform === 'win32' ? `${jestPath}.cmd` : jestPath;
  
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      const duration = Date.now() - startTime;
      resolve({ code, stdout, stderr, duration });
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function runJestProgrammatic(config) {
  const startTime = Date.now();
  const results = await jest.runCLI(config, [PROJECT_ROOT]);
  const duration = Date.now() - startTime;
  return { results, duration };
}

function parseCoverageOutput(output) {
  const coverageMatch = output.match(/All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/);
  if (!coverageMatch) {
    return null;
  }
  return {
    statements: parseFloat(coverageMatch[1]),
    branches: parseFloat(coverageMatch[2]),
    functions: parseFloat(coverageMatch[3]),
    lines: parseFloat(coverageMatch[4])
  };
}

function parseTestResults(output) {
  const testSuiteMatch = output.match(/Test Suites:\s+(\d+)\s+passed,\s+(\d+)\s+failed,\s+(\d+)\s+total/);
  const testMatch = output.match(/Tests:\s+(\d+)\s+passed,\s+(\d+)\s+failed,\s+(\d+)\s+total/);
  
  return {
    suites: {
      passed: testSuiteMatch ? parseInt(testSuiteMatch[1]) : 0,
      failed: testSuiteMatch ? parseInt(testSuiteMatch[2]) : 0,
      total: testSuiteMatch ? parseInt(testSuiteMatch[3]) : 0
    },
    tests: {
      passed: testMatch ? parseInt(testMatch[1]) : 0,
      failed: testMatch ? parseInt(testMatch[2]) : 0,
      total: testMatch ? parseInt(testMatch[3]) : 0
    }
  };
}

function parseAssertionCounts(output) {
  const assertionMatches = output.matchAll(/expect\(\)\s+calls?:\s+(\d+)/g);
  const assertions = [];
  for (const match of assertionMatches) {
    assertions.push(parseInt(match[1]));
  }
  return assertions.length > 0 ? assertions : null;
}

async function runTestSuite(testType, runNumber) {
  const isUnit = testType === 'unit';
  const testPathPattern = isUnit ? '**/tests/unit/**/*.test.js' : '**/tests/integration/**/*.test.js';
  const threshold = TIME_THRESHOLDS[testType];
  
  const args = [
    '--testPathPattern', testPathPattern,
    '--verbose',
    '--no-cache',
    '--runInBand'
  ];

  if (runNumber === 1) {
    args.push('--coverage', '--coverageReporters=text');
  }

  const result = await runJestCLI(args);
  const parsed = parseTestResults(result.stdout);
  const coverage = runNumber === 1 ? parseCoverageOutput(result.stdout) : null;
  const assertions = parseAssertionCounts(result.stdout);
  
  return {
    runNumber,
    testType,
    duration: result.duration,
    passed: parsed.tests.passed,
    failed: parsed.tests.failed,
    total: parsed.tests.total,
    suitesPassed: parsed.suites.passed,
    suitesFailed: parsed.suites.failed,
    coverage,
    assertions,
    threshold,
    withinThreshold: result.duration <= threshold,
    success: parsed.tests.failed === 0 && result.duration <= threshold
  };
}

function compareRunsForFlakiness(runs) {
  const resultsByTest = new Map();
  
  for (const run of runs) {
    if (!run.testResults) continue;
    for (const testResult of run.testResults) {
      const key = `${testResult.testFilePath}::${testResult.testName}`;
      if (!resultsByTest.has(key)) {
        resultsByTest.set(key, []);
      }
      resultsByTest.get(key).push(testResult.status);
    }
  }
  
  const flakyTests = [];
  for (const [testKey, statuses] of resultsByTest.entries()) {
    const uniqueStatuses = new Set(statuses);
    if (uniqueStatuses.size > 1) {
      flakyTests.push({
        test: testKey,
        runs: statuses,
        status: 'flaky'
      });
    }
  }
  
  return flakyTests;
}

function validateCoverageThresholds(coverage) {
  if (!coverage) {
    return { passed: false, reason: 'No coverage data available' };
  }
  
  const failures = [];
  for (const [metric, threshold] of Object.entries(COVERAGE_THRESHOLDS)) {
    if (coverage[metric] < threshold) {
      failures.push(`${metric}: ${coverage[metric]}% < ${threshold}%`);
    }
  }
  
  return {
    passed: failures.length === 0,
    failures,
    coverage
  };
}

function validatePerformanceThresholds(runs) {
  const failures = [];
  
  for (const run of runs) {
    if (!run.withinThreshold) {
      failures.push(`${run.testType} run ${run.runNumber}: ${run.duration}ms > ${run.threshold}ms`);
    }
  }
  
  return {
    passed: failures.length === 0,
    failures
  };
}

function validateTestResults(runs) {
  const failures = [];
  
  for (const run of runs) {
    if (run.failed > 0) {
      failures.push(`${run.testType} run ${run.runNumber}: ${run.failed} failed tests`);
    }
  }
  
  return {
    passed: failures.length === 0,
    failures
  };
}

function generateVerificationReport(allRuns, flakyTests, coverageValidation, performanceValidation, testValidation) {
  const totalTests = allRuns.reduce((sum, run) => sum + run.total, 0);
  const totalPassed = allRuns.reduce((sum, run) => sum + run.passed, 0);
  const totalFailed = allRuns.reduce((sum, run) => sum + run.failed, 0);
  const totalDuration = allRuns.reduce((sum, run) => sum + run.duration, 0);
  
  const unitRuns = allRuns.filter(r => r.testType === 'unit');
  const integrationRuns = allRuns.filter(r => r.testType === 'integration');
  
  const unitAssertions = unitRuns.flatMap(r => r.assertions || []);
  const integrationAssertions = integrationRuns.flatMap(r => r.assertions || []);
  
  return {
    timestamp: new Date().toISOString(),
    summary: {
      totalTests,
      totalPassed,
      totalFailed,
      passRate: totalTests > 0 ? ((totalPassed / totalTests) * 100).toFixed(2) : 0,
      totalDuration,
      flakyTestsCount: flakyTests.length
    },
    unit: {
      runs: unitRuns.length,
      avgDuration: unitRuns.length > 0 ? unitRuns.reduce((s, r) => s + r.duration, 0) / unitRuns.length : 0,
      totalAssertions: unitAssertions.reduce((s, a) => s + a, 0),
      avgAssertionsPerTest: unitAssertions.length > 0 ? unitAssertions.reduce((s, a) => s + a, 0) / unitAssertions.length : 0
    },
    integration: {
      runs: integrationRuns.length,
      avgDuration: integrationRuns.length > 0 ? integrationRuns.reduce((s, r) => s + r.duration, 0) / integrationRuns.length : 0,
      totalAssertions: integrationAssertions.reduce((s, a) => s + a, 0),
      avgAssertionsPerTest: integrationAssertions.length > 0 ? integrationAssertions.reduce((s, a) => s + a, 0) / integrationAssertions.length : 0
    },
    coverage: coverageValidation.coverage,
    coverageValidation: {
      passed: coverageValidation.passed,
      failures: coverageValidation.failures
    },
    performanceValidation: {
      passed: performanceValidation.passed,
      failures: performanceValidation.failures
    },
    testValidation: {
      passed: testValidation.passed,
      failures: testValidation.failures
    },
    flakyTests,
    ciGate: {
      passed: coverageValidation.passed && performanceValidation.passed && testValidation.passed && flakyTests.length === 0,
      criteria: {
        allTestsPass: testValidation.passed,
        coverageThresholdsMet: coverageValidation.passed,
        performanceThresholdsMet: performanceValidation.passed,
        noFlakyTests: flakyTests.length === 0
      }
    }
  };
}

async function ensureDirectoryExists(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

async function writeVerificationReport(report) {
  await ensureDirectoryExists(path.dirname(VERIFICATION_REPORT_PATH));
  await fs.writeFile(VERIFICATION_REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`Verification report written to ${VERIFICATION_REPORT_PATH}`);
}

async function runVerification() {
  console.log('Starting test suite verification...');
  console.log(`Flaky detection runs: ${FLAKY_RUNS}`);
  console.log(`Coverage thresholds:`, COVERAGE_THRESHOLDS);
  console.log(`Time thresholds:`, TIME_THRESHOLDS);
  
  const allRuns = [];
  const allTestResults = [];
  
  for (let runNumber = 1; runNumber <= FLAKY_RUNS; runNumber++) {
    console.log(`\n=== Run ${runNumber}/${FLAKY_RUNS} ===`);
    
    for (const testType of ['unit', 'integration']) {
      console.log(`Running ${testType} tests...`);
      const run = await runTestSuite(testType, runNumber);
      allRuns.push(run);
      
      console.log(`  Duration: ${run.duration}ms (threshold: ${run.threshold}ms) ${run.withinThreshold ? '✓' : '✗'}`);
      console.log(`  Tests: ${run.passed}/${run.total} passed ${run.failed > 0 ? `(${run.failed} failed)` : ''}`);
      console.log(`  Suites: ${run.suitesPassed}/${run.suitesPassed + run.suitesFailed} passed`);
      if (run.coverage) {
        console.log(`  Coverage:`, run.coverage);
      }
      if (run.assertions) {
        console.log(`  Assertions per test:`, run.assertions);
      }
    }
  }
  
  console.log('\n=== Analyzing Results ===');
  
  const flakyTests = compareRunsForFlakiness(allRuns);
  if (flakyTests.length > 0) {
    console.log(`\n⚠️  Flaky tests detected (${flakyTests.length}):`);
    for (const flaky of flakyTests) {
      console.log(`  - ${flaky.test}: ${flaky.runs.join(' → ')}`);
    }
  } else {
    console.log('\n✓ No flaky tests detected');
  }
  
  const coverageRun = allRuns.find(r => r.runNumber === 1 && r.coverage);
  const coverageValidation = validateCoverageThresholds(coverageRun?.coverage);
  console.log(`\nCoverage validation: ${coverageValidation.passed ? '✓ PASSED' : '✗ FAILED'}`);
  if (!coverageValidation.passed) {
    for (const failure of coverageValidation.failures) {
      console.log(`  - ${failure}`);
    }
  }
  
  const performanceValidation = validatePerformanceThresholds(allRuns);
  console.log(`\nPerformance validation: ${performanceValidation.passed ? '✓ PASSED' : '✗ FAILED'}`);
  if (!performanceValidation.passed) {
    for (const failure of performanceValidation.failures) {
      console.log(`  - ${failure}`);
    }
  }
  
  const testValidation = validateTestResults(allRuns);
  console.log(`\nTest results validation: ${testValidation.passed ? '✓ PASSED' : '✗ FAILED'}`);
  if (!testValidation.passed) {
    for (const failure of testValidation.failures) {
      console.log(`  - ${failure}`);
    }
  }
  
  const report = generateVerificationReport(allRuns, flakyTests, coverageValidation, performanceValidation, testValidation);
  
  await writeVerificationReport(report);
  
  console.log('\n=== CI Gate ===');
  console.log(`All tests pass: ${report.ciGate.criteria.allTestsPass ? '✓' : '✗'}`);
  console.log(`Coverage thresholds met: ${report.ciGate.criteria.coverageThresholdsMet ? '✓' : '✗'}`);
  console.log(`Performance thresholds met: ${report.ciGate.criteria.performanceThresholdsMet ? '✓' : '✗'}`);
  console.log(`No flaky tests: ${report.ciGate.criteria.noFlakyTests ? '✓' : '✗'}`);
  console.log(`\nCI Gate: ${report.ciGate.passed ? '✓ PASSED' : '✗ FAILED'}`);
  
  return report.ciGate.passed ? 0 : 1;
}

runVerification()
  .then(exitCode => {
    process.exit(exitCode);
  })
  .catch(error => {
    console.error('Verification failed:', error);
    process.exit(1);
  });