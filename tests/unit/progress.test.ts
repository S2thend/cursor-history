import { describe, expect, it, vi } from 'vitest';
import { createProgress } from '../../src/cli/progress.js';

describe('stderr progress', () => {
  it('throttles updates, forces phase transitions and clears TTY output', () => {
    let time = 0;
    const write = vi.fn(() => true);
    const progress = createProgress(true, { write, isTTY: true }, () => time);
    progress.update('scan');
    progress.update('too soon');
    time = 300;
    progress.update('1/2');
    progress.update('finalize', true);
    progress.finish();
    progress.finish();
    expect(write.mock.calls.map((call) => call[0])).toEqual([
      '\r\x1b[2Kscan',
      '\r\x1b[2K1/2',
      '\r\x1b[2Kfinalize',
      '\r\x1b[2K',
    ]);
  });
  it('uses plain lines for redirected progress and stays silent when disabled', () => {
    const write = vi.fn(() => true);
    const progress = createProgress(true, { write, isTTY: false });
    progress.update('scan');
    progress.finish();
    createProgress(false, { write }).update('hidden', true);
    expect(write.mock.calls.map((call) => call[0])).toEqual(['scan\n']);
  });
});
