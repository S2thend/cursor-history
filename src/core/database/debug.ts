/**
 * Debug Logging Utility
 *
 * Outputs diagnostic messages to stderr when DEBUG or CURSOR_HISTORY_DEBUG
 * environment variable is set.
 */

/**
 * Log a debug message to stderr if debug mode is enabled
 * @param message - Message to log
 */
export function debugLog(message: string): void {
  if (process.env['DEBUG'] || process.env['CURSOR_HISTORY_DEBUG']) {
    console.error(`[cursor-history:sqlite] ${message}`);
  }
}
