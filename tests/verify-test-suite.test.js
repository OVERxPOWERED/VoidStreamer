```javascript
// Test Suite: Verify test suite green status and assertion benchmarks (Milestone 4: Verification & Automated Testing)
// Verified by GitBrain Autonomous Engine

import jest from 'jest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ROADMAP_PATH = path.join(PROJECT_ROOT, 'docs', 'ROADMAP_PROGRESS.md');
const BENCHMARK_REPORT_PATH = path.join(PROJECT_ROOT, 'test-benchmark-report.json');

const COVERAGE_THRESHOLDS = {
  statements: 80,
  branches: 75,
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
    threshold,
    withinThreshold: result.duration <= threshold,
    success: parsed.tests.failed === 0 && result.duration <= threshold
  };
}

function compareRunsForFlakiness(runs) {
  const firstRun = runs[0];
  for (let i = 1; i < runs.length; i++) {
    const run = runs[i];
    if (run.passed !== firstRun.passed || run.failed !== firstRun.failed) {
      return {
        flaky: true,
        details: `Run ${i + 1} differs from run 1: passed=${run.passed} vs ${firstRun.passed}, failed=${run.failed} vs ${firstRun.failed}`
      };
    }
  }
  return { flaky: false, details: 'All runs consistent' };
}

function validateCoverageThresholds(coverage) {
  if (!coverage) {
    return { valid: false, details: 'No coverage data available' };
  }
  
  const failures = [];
  if (coverage.statements < COVERAGE_THRESHOLDS.statements) {
    failures.push(`Statements: ${coverage.statements}% < ${COVERAGE_THRESHOLDS.statements}%`);
  }
  if (coverage.branches < COVERAGE_THRESHOLDS.branches) {
    failures.push(`Branches: ${coverage.branches}% < ${COVERAGE_THRESHOLDS.branches}%`);
  }
  if (coverage.functions < COVERAGE_THRESHOLDS.functions) {
    failures.push(`Functions: ${coverage.functions}% < ${COVERAGE_THRESHOLDS.functions}%`);
  }
  if (coverage.lines < COVERAGE_THRESHOLDS.lines) {
    failures.push(`Lines: ${coverage.lines}% < ${COVERAGE_THRESHOLDS.lines}%`);
  }
  
  return {
    valid: failures.length === 0,
    details: failures.length > 0 ? failures.join('; ') : 'All coverage thresholds met',
    coverage
  };
}

function generateBenchmarkReport