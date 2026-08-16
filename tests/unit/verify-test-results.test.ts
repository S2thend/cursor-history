import { describe, expect, it } from 'vitest';

import {
  TestResultVerificationError,
  verifyVitestResults,
} from '../../scripts/verify-test-results.mjs';

interface AssertionFixture {
  ancestorTitles?: string[];
  title: string;
  status: string;
  duration?: number;
  failureMessages?: string[];
}

function report(assertions: AssertionFixture[], overrides: Record<string, unknown> = {}) {
  const passed = assertions.filter((assertion) => assertion.status === 'passed').length;
  const failed = assertions.filter((assertion) => assertion.status === 'failed').length;
  const pending = assertions.filter((assertion) =>
    ['pending', 'skipped', 'todo'].includes(assertion.status)
  ).length;
  return {
    success: failed === 0,
    numTotalTests: assertions.length,
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: pending,
    numTodoTests: assertions.filter((assertion) => assertion.status === 'todo').length,
    testResults: [
      {
        name: '/synthetic/release-gate.test.ts',
        status: failed === 0 ? 'passed' : 'failed',
        assertionResults: assertions,
      },
    ],
    ...overrides,
  };
}

function failureCode(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(TestResultVerificationError);
    return (error as TestResultVerificationError).code;
  }
}

describe('verifyVitestResults', () => {
  it('accepts a nonempty all-passing report', () => {
    const result = verifyVitestResults(
      report([{ title: 'keeps identities stable', status: 'passed', duration: 2 }]),
      { platform: 'linux' }
    );

    expect(result).toEqual({ executed: 1, passed: 1, allowedSkipped: 0 });
  });

  it('rejects a zero-test result even when the reporter says success', () => {
    expect(failureCode(() => verifyVitestResults(report([]), { platform: 'linux' }))).toBe(
      'ZERO_TESTS'
    );
  });

  it('rejects a nonzero failed assertion and a contradictory failed suite', () => {
    expect(
      failureCode(() =>
        verifyVitestResults(
          report([{ title: 'fails', status: 'failed', failureMessages: ['boom'] }]),
          { platform: 'linux' }
        )
      )
    ).toBe('TEST_FAILURE');

    expect(
      failureCode(() =>
        verifyVitestResults(
          report([{ title: 'passes', status: 'passed' }], {
            success: false,
            numFailedTestSuites: 1,
          }),
          { platform: 'linux' }
        )
      )
    ).toBe('TEST_FAILURE');
  });

  it('allows only the documented platform-qualified skip on the opposite platform', () => {
    const windows = verifyVitestResults(
      report([
        { title: 'platform:posix: enforces owner-only mode bits', status: 'pending' },
        { title: 'ordinary test', status: 'passed' },
      ]),
      { platform: 'win32' }
    );
    expect(windows).toEqual({ executed: 1, passed: 1, allowedSkipped: 1 });

    const posix = verifyVitestResults(
      report([
        { title: 'platform:windows: inherits the per-user temp ACL', status: 'pending' },
        { title: 'ordinary test', status: 'passed' },
      ]),
      { platform: 'linux' }
    );
    expect(posix.allowedSkipped).toBe(1);
  });

  it('rejects unexpected skips, same-platform skips, and todo tests', () => {
    for (const assertion of [
      { title: 'ordinary skipped test', status: 'pending' },
      { title: 'platform:posix: should run here', status: 'skipped' },
      { title: 'platform:windows: unfinished work', status: 'todo' },
    ]) {
      expect(
        failureCode(() => verifyVitestResults(report([assertion]), { platform: 'linux' }))
      ).toBe('UNEXPECTED_SKIP');
    }
  });

  it('rejects timeout and cancellation state even when aggregate counters look successful', () => {
    expect(
      failureCode(() =>
        verifyVitestResults(report([{ title: 'slow', status: 'passed' }], { timedOut: true }), {
          platform: 'linux',
        })
      )
    ).toBe('TEST_TIMEOUT');

    expect(
      failureCode(() =>
        verifyVitestResults(
          report([{ title: 'cancelled', status: 'passed' }], { wasInterrupted: true }),
          {
            platform: 'linux',
          }
        )
      )
    ).toBe('TEST_CANCELLED');
  });

  it('rejects malformed or internally inconsistent reporter output', () => {
    expect(failureCode(() => verifyVitestResults(null, { platform: 'linux' }))).toBe(
      'INVALID_TEST_RESULTS'
    );
    expect(
      failureCode(() =>
        verifyVitestResults(report([{ title: 'passes', status: 'passed' }], { numTotalTests: 2 }), {
          platform: 'linux',
        })
      )
    ).toBe('INVALID_TEST_RESULTS');
  });

  it('prevents a downstream publish step after any verifier failure', () => {
    let published = false;

    try {
      verifyVitestResults(
        report([{ title: 'release blocker', status: 'failed', failureMessages: ['fault'] }]),
        { platform: 'linux' }
      );
      published = true;
    } catch (error) {
      expect(error).toBeInstanceOf(TestResultVerificationError);
    }

    expect(published).toBe(false);
  });
});
