#!/usr/bin/env node
/**
 * Test Suite Verification Script
 * 
 * Verifies test suite quality gates post-execution:
 * - Assertion density benchmarks
 * - Performance thresholds
 * - Coverage gates
 * - Flakiness detection
 * - CI-structured JSON output
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

class TestSuiteVerifier {
  constructor(options = {}) {
    this.resultsPath = options.resultsPath || path.join(process.cwd(), 'test-results.json');
    this.coveragePath = options.coveragePath || path.join(process.cwd(), 'coverage', 'coverage-summary.json');
    this.historyPath = options.historyPath || path.join(process.cwd(), '.test-history.json');
    this.config = {
      minAssertionDensity: options.minAssertionDensity || 5,
      thresholds: {
        unit: options.unitThreshold || 500,
        integration: options.integrationThreshold || 5000,
        e2e: options.e2eThreshold || 30000
      },
      coverage: {
        statements: options.statementsThreshold || 80,
        branches: options.branchesThreshold || 75,
        functions: options.functionsThreshold || 80,
        lines: options.linesThreshold || 80
      },
      flakinessRuns: options.flakinessRuns || 3
    };
    this.verificationResults = {
      timestamp: new Date().toISOString(),
      passed: true,
      checks: {},
      summary: {}
    };
  }

  /**
   * Load Jest JSON results from file
   */
  loadJestResults() {
    if (!fs.existsSync(this.resultsPath)) {
      throw new Error(`Jest results not found at ${this.resultsPath}`);
    }
    const content = fs.readFileSync(this.resultsPath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Load coverage summary from file
   */
  loadCoverageSummary() {
    if (!fs.existsSync(this.coveragePath)) {
      throw new Error(`Coverage summary not found at ${this.coveragePath}`);
    }
    const content = fs.readFileSync(this.coveragePath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Load historical test runs for flakiness detection
   */
  loadHistory() {
    if (!fs.existsSync(this.historyPath)) {
      return [];
    }
    const content = fs.readFileSync(this.historyPath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Save current run to history
   */
  saveHistory(runData) {
    const history = this.loadHistory();
    history.push(runData);
    // Keep last 50 runs
    const trimmed = history.slice(-50);
    fs.writeFileSync(this.historyPath, JSON.stringify(trimmed, null, 2));
  }

  /**
   * Check assertion density (assertions per test file)
   */
  checkAssertionDensity(jestResults) {
    const testFiles = new Map();
    let totalAssertions = 0;
    let totalTestFiles = 0;

    for (const testResult of jestResults.testResults || []) {
      const filePath = testResult.name;
      const assertions = testResult.assertionResults?.length || 0;
      
      if (assertions > 0) {
        testFiles.set(filePath, assertions);
        totalAssertions += assertions;
        totalTestFiles++;
      }
    }

    const density = totalTestFiles > 0 ? totalAssertions / totalTestFiles : 0;
    const passed = density >= this.config.minAssertionDensity;

    const details = {
      totalAssertions,
      totalTestFiles,
      density: Math.round(density * 100) / 100,
      threshold: this.config.minAssertionDensity,
      passed,
      files: Array.from(testFiles.entries()).map(([file, count]) => ({
        file,
        assertions: count,
        meetsThreshold: count >= this.config.minAssertionDensity
      }))
    };

    this.verificationResults.checks.assertionDensity = details;
    return passed;
  }

  /**
   * Check performance thresholds by test type
   */
  checkPerformanceThresholds(jestResults) {
    const thresholds = this.config.thresholds;
    const results = {
      unit: { passed: true, maxDuration: 0, threshold: thresholds.unit, violations: [] },
      integration: { passed: true, maxDuration: 0, threshold: thresholds.integration, violations: [] },
      e2e: { passed: true, maxDuration: 0, threshold: thresholds.e2e, violations: [] }
    };

    for (const testResult of jestResults.testResults || []) {
      const filePath = testResult.name;
      const duration = testResult.duration || 0;
      let category = 'unit';

      if (filePath.includes('.e2e.') || filePath.includes('.e2e-') || filePath.includes('/e2e/')) {
        category = 'e2e';
      } else if (filePath.includes('.integration.') || filePath.includes('.int.') || filePath.includes('/integration/')) {
        category = 'integration';
      }

      results[category].maxDuration = Math.max(results[category].maxDuration, duration);

      if (duration > thresholds[category]) {
        results[category].passed = false;
        results[category].violations.push({
          file: filePath,
          duration,
          threshold: thresholds[category]
        });
      }
    }

    const overallPassed = results.unit.passed && results.integration.passed && results.e2e.passed;
    this.verificationResults.checks.performance = {
      ...results,
      passed: overallPassed
    };

    return overallPassed;
  }

  /**
   * Check coverage gates
   */
  checkCoverageGates(coverageSummary) {
    const thresholds = this.config.coverage;
    const total = coverageSummary.total || {};
    const results = {
      statements: { passed: false, actual: 0, threshold: thresholds.statements },
      branches: { passed: false, actual: 0, threshold: thresholds.branches },
      functions: { passed: false, actual: 0, threshold: thresholds.functions },
      lines: { passed: false, actual: 0, threshold: thresholds.lines }
    };

    if (total.statements) {
      results.statements.actual = total.statements.pct;
      results.statements.passed = total.statements.pct >= thresholds.statements;
    }
    if (total.branches) {
      results.branches.actual = total.branches.pct;
      results.branches.passed = total.branches.pct >= thresholds.branches;
    }
    if (total.functions) {
      results.functions.actual = total.functions.pct;
      results.functions.passed = total.functions.pct >= thresholds.functions;
    }
    if (total.lines) {
      results.lines.actual = total.lines.pct;
      results.lines.passed = total.lines.pct >= thresholds.lines;
    }

    const overallPassed = results.statements.passed && 
                          results.branches.passed && 
                          results.functions.passed && 
                          results.lines.passed;

    this.verificationResults.checks.coverage = {
      ...results,
      passed: overallPassed
    };

    return overallPassed;
  }

  /**
   * Check flakiness via historical analysis
   */
  checkFlakiness(jestResults) {
    const history = this.loadHistory();
    const currentRun = {
      timestamp: new Date().toISOString(),
      success: jestResults.success,
      numFailedTests: jestResults.numFailedTests,
      numPassedTests: jestResults.numPassedTests,
      testResults: (jestResults.testResults || []).map(tr => ({
        name: tr.name,
        status: tr.status,
        duration: tr.duration
      }))
    };

    this.saveHistory(currentRun);

    // Need at least flakinessRuns historical runs
    if (history.length < this.config.flakinessRuns) {
      const result = {
        passed: true,
        reason: `Insufficient history (${history.length}/${this.config.flakinessRuns} runs)`,
        consecutiveGreen: history.filter(r => r.success).length,
        required: this.config.flakinessRuns
      };
      this.verificationResults.checks.flakiness = result;
      return true;
    }

    // Check last N runs
    const recentRuns = history.slice(-this.config.flakinessRuns);
    const allGreen = recentRuns.every(r => r.success);
    const consecutiveGreen = recentRuns.filter(r => r.success).length;

    // Detect flaky tests (tests that pass/fail inconsistently)
    const testStatusMap = new Map();
    for (const run of recentRuns) {
      for (const test of run.testResults) {
        if (!testStatusMap.has(test.name)) {
          testStatusMap.set(test.name, { pass: 0, fail: 0 });
        }
        const status = testStatusMap.get(test.name);
        if (test.status === 'passed') status.pass++;
        else if (test.status === 'failed') status.fail++;
      }
    }

    const flakyTests = [];
    for (const [testName, status] of testStatusMap) {
      if (status.pass > 0 && status.fail > 0) {
        flakyTests.push({
          test: testName,
          passCount: status.pass,
          failCount: status.fail,
          flakinessRate: Math.round((status.fail / (status.pass + status.fail)) * 100)
        });
      }
    }

    const result = {
      passed: allGreen && flakyTests.length === 0,
      consecutiveGreen,
      required: this.config.flakinessRuns,
      allRecentGreen: allGreen,
      flakyTests,
      flakyTestCount: flakyTests.length
    };

    this.verificationResults.checks.flakiness = result;
    return result.passed;
  }

  /**
   * Check overall test suite health
   */
  checkTestSuiteHealth(jestResults) {
    const results = {
      passed: jestResults.success,
      totalTests: jestResults.numTotalTests,
      passedTests: jestResults.numPassedTests,
      failedTests: jestResults.numFailedTests,
      pendingTests: jestResults.numPendingTests,
      duration: jestResults.duration,
      testFiles: jestResults.testResults?.length || 0
    };

    this.verificationResults.checks.testSuite = results;
    return results.passed;
  }

  /**
   * Run all verification checks
   */
  async verify() {
    try {
      const jestResults = this.loadJestResults();
      const coverageSummary = this.loadCoverageSummary();

      // Run all checks
      const checks = [
        { name: 'testSuite', fn: () => this.checkTestSuiteHealth(jestResults) },
        { name: 'assertionDensity', fn: () => this.checkAssertionDensity(jestResults) },
        { name: 'performance', fn: () => this.checkPerformanceThresholds(jestResults) },
        { name: 'coverage', fn: () => this.checkCoverageGates(coverageSummary) },
        { name: 'flakiness', fn: () => this.checkFlakiness(jestResults) }
      ];

      let allPassed = true;
      for (const check of checks) {
        try {
          const passed = check.fn();
          if (!passed) allPassed = false;
        } catch (error) {
          console.error(`Check ${check.name} failed with error:`, error.message);
          this.verificationResults.checks[check.name] = {
            passed: false,
            error: error.message
          };
          allPassed = false;
        }
      }

      // Build summary
      this.verificationResults.passed = allPassed;
      this.verificationResults.summary = {
        totalChecks: checks.length,
        passedChecks: checks.filter(c => this.verificationResults.checks[c.name]?.passed).length,
        failedChecks: checks.filter(c => !this.verificationResults.checks[c.name]?.passed).length,
        timestamp: new Date().toISOString()
      };

      return this.verificationResults;
    } catch (error) {
      this.verificationResults.passed = false;
      this.verificationResults.error = error.message;
      return this.verificationResults;
    }
  }

  /**
   * Output results as JSON for CI consumption
   */
  outputResults() {
    console.log(JSON.stringify(this.verificationResults, null, 2));
  }

  /**
   * Get exit code based on verification results
   */
  getExitCode() {
    return this.verificationResults.passed ? 0 : 1;
  }
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);
  const options = {
    resultsPath: process.env.JEST_RESULTS_PATH,
    coveragePath: process.env.COVERAGE_SUMMARY_PATH,
    historyPath: process.env.TEST_HISTORY_PATH,
    minAssertionDensity: parseInt(process.env.MIN_ASSERTION_DENSITY) || 5,
    unitThreshold: parseInt(process.env.UNIT_THRESHOLD_MS) || 500,
    integrationThreshold: parseInt(process.env.INTEGRATION_THRESHOLD_MS) || 5000,
    e2eThreshold: parseInt(process.env.E2E_THRESHOLD_MS) || 30000,
    statementsThreshold: parseInt(process.env.STATEMENTS_THRESHOLD) || 80,
    branchesThreshold: parseInt(process.env.BRANCHES_THRESHOLD) || 75,
    functionsThreshold: parseInt(process.env.FUNCTIONS_THRESHOLD) || 80,
    linesThreshold: parseInt(process.env.LINES_THRESHOLD) || 80,
    flakinessRuns: parseInt(process.env.FLAKINESS_RUNS) || 3
  };

  // Parse CLI args
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--results':
        options.resultsPath = args[++i];
        break;
      case '--coverage':
        options.coveragePath = args[++i];
        break;
      case '--history':
        options.historyPath = args[++i];
        break;
      case '--min-assertions':
        options.minAssertionDensity = parseInt(args[++i]);
        break;
      case '--unit-threshold':
        options.unitThreshold = parseInt(args[++i]);
        break;
      case '--integration-threshold':
        options.integrationThreshold = parseInt(args[++i]);
        break;
      case '--e2e-threshold':
        options.e2eThreshold = parseInt(args[++i]);
        break;
    }
  }

  const verifier = new TestSuiteVerifier(options);
  const results = await verifier.verify();
  verifier.outputResults();
  
  process.exit(verifier.getExitCode());
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Verification script failed:', error);
    process.exit(1);
  });
}

module.exports = { TestSuiteVerifier };