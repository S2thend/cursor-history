/** Throttled stderr progress, independent of command result formatting. */
export function createProgress(
  enabled: boolean,
  stream: Pick<NodeJS.WriteStream, 'write' | 'isTTY'> = process.stderr,
  now: () => number = Date.now
): { update(message: string, force?: boolean): void; finish(): void } {
  let last = -Infinity;
  let visible = false;
  return {
    update(message, force = false) {
      if (!enabled) return;
      const time = now();
      if (!force && time - last < 250) return;
      last = time;
      stream.write(stream.isTTY ? `\r\x1b[2K${message}` : `${message}\n`);
      visible = true;
    },
    finish() {
      if (visible && stream.isTTY) stream.write('\r\x1b[2K');
      visible = false;
    },
  };
}
