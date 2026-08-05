#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKIP_PREFIXES = Object.freeze({
  win32: ['platform:posix:'],
  posix: ['platform:windows:'],
});

export class TestResultVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TestResultVerificationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TestResultVerificationError(code, message);
}

function asFiniteCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_TEST_RESULTS', `${field} must be a non-negative safe integer.`);
  }
  return value;
}

function assertionName(assertion) {
  const ancestors = Array.isArray(assertion.ancestorTitles)
    ? assertion.ancestorTitles.filter((value) => typeof value === 'string')
    : [];
  return [...ancestors, assertion.title].join(' > ');
}

function isAllowedPlatformSkip(name, platform) {
  const family = platform === 'win32' ? 'win32' : 'posix';
  return SKIP_PREFIXES[family].some((prefix) => name.startsWith(prefix));
}

function collectAssertions(testResults) {
  const assertions = [];
  for (const suite of testResults) {
    if (typeof suite !== 'object' || suite === null || !Array.isArray(suite.assertionResults)) {
      fail('INVALID_TEST_RESULTS', 'Each test result must contain assertionResults.');
    }
    for (const assertion of suite.assertionResults) {
      if (
        typeof assertion !== 'object' ||
        assertion === null ||
        typeof assertion.title !== 'string' ||
        typeof assertion.status !== 'string'
      ) {
        fail('INVALID_TEST_RESULTS', 'Each assertion must contain string title and status fields.');
      }
      assertions.push(assertion);
    }
  }
  return assertions;
}

function containsTimeout(report, assertions) {
  if (report.timedOut === true || report.timeout === true) return true;
  return assertions.some((assertion) => {
    if (['timeout', 'timedout', 'timed-out'].includes(assertion.status.toLowerCase())) return true;
    return Array.isArray(assertion.failureMessages)
      ? assertion.failureMessages.some((message) =>
          typeof message === 'string' ? /timed?\s*out|timeout/i.test(message) : false
        )
      : false;
  });
}

function containsCancellation(report, assertions) {
  if (
    report.wasInterrupted === true ||
    report.cancelled === true ||
    report.canceled === true ||
    report.interrupted === true
  ) {
    return true;
  }
  return assertions.some((assertion) =>
    ['cancelled', 'canceled', 'interrupted'].includes(assertion.status.toLowerCase())
  );
}

/**
 * Verify one Vitest JSON reporter document using the release-blocking policy.
 *
 * @param {unknown} value Parsed Vitest JSON reporter output.
 * @param {{ platform?: NodeJS.Platform }} [options] Verification environment.
 * @returns {{ executed: number, passed: number, allowedSkipped: number }} Stable summary.
 * @throws {TestResultVerificationError} If the report is empty, malformed, failed, interrupted,
 * timed out, or contains an unapproved skip.
 */
export function verifyVitestResults(value, options = {}) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_TEST_RESULTS', 'Vitest result must be a JSON object.');
  }

  const report = value;
  if (!Array.isArray(report.testResults)) {
    fail('INVALID_TEST_RESULTS', 'Vitest result must contain testResults.');
  }

  const assertions = collectAssertions(report.testResults);
  const total = asFiniteCount(report.numTotalTests, 'numTotalTests');
  const reportedPassed = asFiniteCount(report.numPassedTests, 'numPassedTests');
  const reportedFailed = asFiniteCount(report.numFailedTests, 'numFailedTests');
  const reportedPending = asFiniteCount(report.numPendingTests ?? 0, 'numPendingTests');
  const reportedTodo = asFiniteCount(report.numTodoTests ?? 0, 'numTodoTests');

  if (total === 0 || assertions.length === 0) {
    fail('ZERO_TESTS', 'The required test command did not execute any tests.');
  }
  if (assertions.length !== total) {
    fail(
      'INVALID_TEST_RESULTS',
      `Reporter assertion count ${assertions.length} does not match numTotalTests ${total}.`
    );
  }

  if (containsTimeout(report, assertions)) {
    fail('TEST_TIMEOUT', 'The required test command timed out.');
  }
  if (containsCancellation(report, assertions)) {
    fail('TEST_CANCELLED', 'The required test command was cancelled or interrupted.');
  }

  const passed = assertions.filter((assertion) => assertion.status === 'passed');
  const failed = assertions.filter((assertion) => assertion.status === 'failed');
  const skipped = assertions.filter((assertion) =>
    ['pending', 'skipped', 'todo'].includes(assertion.status)
  );
  const unknown = assertions.filter(
    (assertion) => !['passed', 'failed', 'pending', 'skipped', 'todo'].includes(assertion.status)
  );

  if (unknown.length > 0) {
    fail(
      'INVALID_TEST_RESULTS',
      `Reporter contains unsupported assertion status: ${unknown[0].status}.`
    );
  }
  if (
    passed.length !== reportedPassed ||
    failed.length !== reportedFailed ||
    skipped.length !== reportedPending ||
    skipped.filter((assertion) => assertion.status === 'todo').length !== reportedTodo
  ) {
    fail('INVALID_TEST_RESULTS', 'Vitest aggregate counters do not match assertion results.');
  }

  if (
    report.success !== true ||
    failed.length > 0 ||
    (typeof report.numFailedTestSuites === 'number' && report.numFailedTestSuites > 0)
  ) {
    fail('TEST_FAILURE', 'The required test command reported a failure.');
  }

  const platform = options.platform ?? process.platform;
  for (const assertion of skipped) {
    const name = assertionName(assertion);
    if (assertion.status === 'todo' || !isAllowedPlatformSkip(name, platform)) {
      fail('UNEXPECTED_SKIP', `Required test was skipped without an allowlist match: ${name}`);
    }
  }

  const executed = passed.length + failed.length;
  if (executed === 0) {
    fail('ZERO_TESTS', 'The required test command skipped every collected test.');
  }

  return { executed, passed: passed.length, allowedSkipped: skipped.length };
}

function main(argv) {
  const resultPath = argv[2];
  if (!resultPath || argv.length > 3) {
    fail('INVALID_ARGUMENTS', 'Usage: node scripts/verify-test-results.mjs <vitest-results.json>');
  }
  const value = JSON.parse(readFileSync(resultPath, 'utf8'));
  const summary = verifyVitestResults(value);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv);
  } catch (error) {
    const code = error instanceof TestResultVerificationError ? error.code : 'INVALID_TEST_RESULTS';
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  }
}
