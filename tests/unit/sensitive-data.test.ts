import { describe, expect, it } from 'vitest';
import {
  anonymizeHostPaths,
  detectSensitiveText,
  redactSensitiveText,
} from '../../src/core/sensitive-data.js';
import { scanSyntheticFixtureBytes } from '../compatibility/support/generate-v016-fixtures.js';

describe('shared sensitive-data rules', () => {
  it.each([
    ['openai-key', 'sk-' + 'a'.repeat(32)],
    ['github-token', 'ghp_' + 'b'.repeat(32)],
    ['aws-access-key', 'AKIA' + 'A'.repeat(16)],
    ['bearer-token', 'Bearer ' + 'b'.repeat(32)],
    ['credential-assignment', 'API_KEY=secret-value-123'],
    ['credential-assignment', 'api-key=secret-value-123'],
    ['bearer-token', 'Bearer abcdefghijk='],
    ['private-key', '-----BEGIN PRIVATE KEY-----\nQUJDRA=='],
    ['jwt', 'eyJ' + 'a'.repeat(10) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12)],
  ])('detects and redacts %s consistently across consumers', (rule, input) => {
    const first = detectSensitiveText(input);
    expect(first).toEqual(expect.arrayContaining([expect.objectContaining({ rule })]));
    expect(detectSensitiveText(input)).toEqual(first);
    expect(scanSyntheticFixtureBytes('fixture.json', Buffer.from(input))).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule })])
    );
    const redacted = redactSensitiveText(input);
    expect(redacted.text).toContain('[REDACTED');
    expect(redacted.text).not.toContain(input);
    expect(redactSensitiveText(input)).toEqual(redacted);
  });

  it('keeps fixture-only PII checks separate from credential redaction', () => {
    const text = 'person@example.test /home/alice/project';
    expect(detectSensitiveText(text)).toEqual([]);
    expect(redactSensitiveText(text).text).toBe(text);
    expect(scanSyntheticFixtureBytes('fixture.json', Buffer.from(text))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'email-address' }),
        expect.objectContaining({ rule: 'posix-home-path' }),
      ])
    );
    expect(anonymizeHostPaths(text)).toBe('person@example.test /home/<user>/project');
  });
  it('preserves the released fixture scanner coverage for credential assignments', () => {
    for (const name of [
      'password',
      'passwd',
      'secret',
      'api-key',
      'api_key',
      'APIKEY',
      'access-token',
      'access_token',
    ]) {
      for (const value of ['abcdef', 'ab;cd!', '123456']) {
        expect(scanSyntheticFixtureBytes('fixture.json', Buffer.from(`${name}=${value}`))).toEqual(
          expect.arrayContaining([expect.objectContaining({ rule: 'credential-assignment' })])
        );
      }
    }
  });
});
