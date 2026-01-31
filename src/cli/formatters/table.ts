/**
 * Table/text output formatter for CLI with color support
 */

import pc from 'picocolors';
import type { ChatSessionSummary, Workspace, ChatSession, SearchResult, MessageType } from '../../core/types.js';
import { MESSAGE_TYPES } from '../../core/types.js';

/**
 * Check if output supports colors
 */
export function supportsColor(): boolean {
  // Respect NO_COLOR environment variable
  if (process.env['NO_COLOR'] !== undefined) {
    return false;
  }

  // Check if stdout is a TTY
  return process.stdout.isTTY === true;
}

/**
 * Format a date for display
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Format a timestamp for display (time only)
 */
function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Truncate string with ellipsis
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Truncate path from the beginning (keep the end which is more specific)
 */
function truncatePath(path: string, maxLength: number): string {
  if (path.length <= maxLength) {
    return path;
  }
  return '...' + path.slice(-(maxLength - 3));
}

/**
 * Pad string to fixed width
 */
function padRight(str: string, width: number): string {
  return str.padEnd(width);
}

/**
 * Format sessions list as table
 */
export function formatSessionsTable(sessions: ChatSessionSummary[], showIds = false): string {
  if (sessions.length === 0) {
    return pc.yellow('No chat sessions found.');
  }

  const lines: string[] = [];

  // Header
  if (showIds) {
    lines.push(
      pc.bold(
        `${padRight('#', 4)} ${padRight('Date', 12)} ${padRight('Msgs', 5)} ${padRight('Workspace', 25)} ${padRight('Composer ID', 38)} Preview`
      )
    );
    lines.push(pc.dim('─'.repeat(130)));
  } else {
    lines.push(
      pc.bold(
        `${padRight('#', 4)} ${padRight('Date', 12)} ${padRight('Messages', 8)} ${padRight('Workspace', 30)} Preview`
      )
    );
    lines.push(pc.dim('─'.repeat(100)));
  }

  // Rows
  for (const session of sessions) {
    const idx = pc.cyan(padRight(String(session.index), 4));
    const date = padRight(formatDate(session.createdAt), 12);

    if (showIds) {
      const msgs = padRight(String(session.messageCount), 5);
      const workspace = pc.dim(padRight(truncatePath(session.workspacePath, 25), 25));
      const composerId = pc.gray(padRight(session.id, 38));
      const preview = truncate(session.preview, 30);
      lines.push(`${idx} ${date} ${msgs} ${workspace} ${composerId} ${preview}`);
    } else {
      const msgs = padRight(String(session.messageCount), 8);
      const workspace = pc.dim(padRight(truncatePath(session.workspacePath, 30), 30));
      const preview = truncate(session.preview, 40);
      lines.push(`${idx} ${date} ${msgs} ${workspace} ${preview}`);
    }
  }

  lines.push('');
  lines.push(pc.dim(`Showing ${sessions.length} session(s). Use "show <#>" to view details.`));
  if (showIds) {
    lines.push(pc.dim(`Composer IDs can be used with external tools for export.`));
  }

  return lines.join('\n');
}

/**
 * Format workspaces list as table
 */
export function formatWorkspacesTable(workspaces: Workspace[]): string {
  if (workspaces.length === 0) {
    return pc.yellow('No workspaces with chat history found.');
  }

  const lines: string[] = [];

  // Header
  lines.push(pc.bold(`${padRight('Sessions', 10)} Path`));
  lines.push(pc.dim('─'.repeat(80)));

  // Rows
  for (const workspace of workspaces) {
    const count = pc.cyan(padRight(String(workspace.sessionCount), 10));
    const path = workspace.path;
    lines.push(`${count} ${path}`);
  }

  lines.push('');
  lines.push(pc.dim(`Found ${workspaces.length} workspace(s) with chat history.`));

  return lines.join('\n');
}

/**
 * Check if content is a tool call (formatted by storage layer)
 */
export function isToolCall(content: string): boolean {
  return content.startsWith('[Tool:');
}

/**
 * Check if content is thinking/reasoning text
 */
export function isThinking(content: string): boolean {
  return content.startsWith('[Thinking]');
}

/**
 * Check if content is an error message
 */
export function isError(content: string): boolean {
  return content.startsWith('[Error]');
}

/**
 * Get the type of a message based on its role and content
 */
export function getMessageType(message: { role: string; content: string }): MessageType {
  if (message.role === 'user') {
    return 'user';
  }
  // For assistant messages, check content markers
  if (isToolCall(message.content)) return 'tool';
  if (isThinking(message.content)) return 'thinking';
  if (isError(message.content)) return 'error';
  return 'assistant';
}

/**
 * Filter messages by type
 * Returns all messages if types is empty or contains all types
 */
export function filterMessages<T extends { role: string; content: string }>(
  messages: T[],
  types: MessageType[]
): T[] {
  if (types.length === 0 || types.length === MESSAGE_TYPES.length) {
    return messages; // No filtering needed
  }
  return messages.filter((m) => types.includes(getMessageType(m)));
}

/**
 * Validate message filter types
 * Returns array of invalid types, or empty array if all are valid
 */
export function validateMessageTypes(types: string[]): string[] {
  return types.filter((t) => !MESSAGE_TYPES.includes(t as MessageType));
}

/**
 * Format error message with nice styling
 */
function formatErrorDisplay(content: string, fullError: boolean): string {
  const text = content.replace('[Error]\n', '').trim();
  const lines: string[] = [];
  lines.push(pc.red(pc.bold('❌ Error')));

  if (fullError) {
    // Show full error
    lines.push(pc.red('   ' + text));
  } else {
    // Show truncated error (first 300 chars)
    const truncated = text.slice(0, 300) + (text.length > 300 ? '...' : '');
    lines.push(pc.red('   ' + truncated));
  }

  return lines.join('\n');
}

/**
 * Format thinking text with nice styling
 */
function formatThinkingDisplay(content: string, fullThinking: boolean): string {
  const text = content.replace('[Thinking]\n', '').trim();
  const lines: string[] = [];
  lines.push(pc.yellow(pc.bold('💭 Thinking')));

  if (fullThinking) {
    // Show full thinking text
    lines.push(pc.dim('   ' + text));
  } else {
    // Show truncated thinking text (default)
    lines.push(pc.dim('   ' + text.slice(0, 200) + (text.length > 200 ? '...' : '')));
  }

  return lines.join('\n');
}

/**
 * Format tool call content with nice styling
 */
function formatToolCallDisplay(content: string, fullTool: boolean): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inDiffBlock = false;
  let diffLineCount = 0;
  const MAX_DIFF_LINES = 20; // Show first 20 lines of diff by default

  for (const line of lines) {
    if (line.startsWith('[Tool:')) {
      // Tool header
      const toolName = line.replace('[Tool:', '').replace(']', '').trim();
      result.push(pc.magenta(pc.bold(`🔧 ${toolName}`)));
    } else if (line.startsWith('File:') || line.startsWith('Directory:') || line.startsWith('Command:') || line.startsWith('Target:')) {
      // Target line - truncate command if not fullTool
      if (line.startsWith('Command:') && !fullTool) {
        const cmd = line.replace('Command:', '').trim();
        const truncated = cmd.slice(0, 100) + (cmd.length > 100 ? '...' : '');
        result.push(pc.cyan('   Command: ' + truncated));
      } else {
        result.push(pc.cyan('   ' + line));
      }
    } else if (line === '```diff') {
      // Start of diff block
      inDiffBlock = true;
      diffLineCount = 0;
      result.push('   ' + line);
    } else if (line === '```' && inDiffBlock) {
      // End of diff block
      inDiffBlock = false;
      result.push('   ' + line);
    } else if (inDiffBlock) {
      // Inside diff block
      if (!fullTool && diffLineCount >= MAX_DIFF_LINES) {
        // Skip additional lines and add truncation marker once
        if (diffLineCount === MAX_DIFF_LINES) {
          result.push(pc.dim('   ... (use --tool to see full diff)'));
          diffLineCount++;
        }
      } else {
        // Color diff lines: red for removals, green for additions
        if (line.startsWith('-')) {
          result.push('   ' + pc.red(line));
        } else if (line.startsWith('+')) {
          result.push('   ' + pc.green(line));
        } else {
          result.push('   ' + pc.dim(line));
        }
        diffLineCount++;
      }
    } else if (line.startsWith('Content:')) {
      // Content preview
      const preview = line.replace('Content:', '').trim();

      if (fullTool) {
        // Show full content
        result.push(pc.dim('   Content: ') + pc.gray(preview));
      } else {
        // Show truncated content (default: 100 chars)
        result.push(pc.dim('   Content: ') + pc.gray(preview.slice(0, 100) + (preview.length > 100 ? '...' : '')));
      }
    } else if (line.startsWith('Result:') || line.startsWith('Output:')) {
      // Tool result/output preview
      const prefix = line.startsWith('Result:') ? 'Result:' : 'Output:';
      const preview = line.replace(prefix, '').trim();

      if (fullTool) {
        // Show full result
        result.push(pc.dim('   ' + prefix + ' ') + pc.gray(preview));
      } else {
        // Show truncated result (default: 300 chars)
        result.push(pc.dim('   ' + prefix + ' ') + pc.gray(preview.slice(0, 300) + (preview.length > 300 ? '...' : '')));
      }
    } else {
      result.push('   ' + line);
    }
  }

  return result.join('\n');
}

/**
 * Format a single session with full messages
 */
export function formatSessionDetail(
  session: ChatSession,
  workspacePath?: string,
  options?: {
    short?: boolean;
    fullThinking?: boolean;
    fullTool?: boolean;
    fullError?: boolean;
    messageFilter?: MessageType[];
    originalMessageCount?: number;
  }
): string {
  const lines: string[] = [];
  const {
    short = false,
    fullThinking = false,
    fullTool = false,
    fullError = false,
    messageFilter,
    originalMessageCount,
  } = options ?? {};

  // Header
  lines.push(pc.bold(`Chat Session #${session.index}`));
  lines.push(pc.dim('═'.repeat(60)));
  lines.push('');

  if (session.title) {
    lines.push(`${pc.bold('Title:')} ${session.title}`);
  }
  lines.push(`${pc.bold('Date:')} ${formatDate(session.createdAt)}`);
  if (workspacePath) {
    lines.push(`${pc.bold('Workspace:')} ${workspacePath}`);
  }
  // Show original message count and filter info if filtering is active
  if (messageFilter && messageFilter.length > 0 && originalMessageCount !== undefined) {
    lines.push(
      `${pc.bold('Messages:')} ${session.messages.length} of ${originalMessageCount} ${pc.dim(`(filter: ${messageFilter.join(', ')})`)}`
    );
  } else {
    lines.push(`${pc.bold('Messages:')} ${session.messageCount}`);
  }
  lines.push('');
  lines.push(pc.dim('─'.repeat(60)));
  lines.push('');

  // Handle empty filter result
  if (messageFilter && messageFilter.length > 0 && session.messages.length === 0) {
    lines.push(pc.yellow(`No messages match the filter: ${messageFilter.join(', ')}`));
    lines.push('');
    lines.push(pc.dim('Use --only without arguments to see all messages.'));
    return lines.join('\n');
  }

  // Messages - with consecutive duplicate folding
  let i = 0;
  while (i < session.messages.length) {
    const message = session.messages[i]!;
    const timestamps: Date[] = [message.timestamp];

    // Check for consecutive duplicates (same role and content)
    let j = i + 1;
    while (j < session.messages.length) {
      const nextMsg = session.messages[j]!;
      if (nextMsg.role === message.role && nextMsg.content === message.content) {
        timestamps.push(nextMsg.timestamp);
        j++;
      } else {
        break;
      }
    }

    // Format timestamps
    const timestampDisplay =
      timestamps.length > 1
        ? pc.dim(`${timestamps.map((t) => formatTime(t)).join(', ')} `) + pc.yellow(`(×${timestamps.length})`)
        : pc.dim(formatTime(message.timestamp));

    // Check if this is a tool call
    if (isToolCall(message.content)) {
      lines.push(`${pc.cyan(pc.bold('Tool:'))} ${timestampDisplay}`);
      lines.push(formatToolCallDisplay(message.content, fullTool));
      lines.push('');
      lines.push(pc.dim('─'.repeat(40)));
      lines.push('');
      i = j;
      continue;
    }

    // Check if this is an error message
    if (isError(message.content)) {
      lines.push(`${pc.red(pc.bold('Error:'))} ${timestampDisplay}`);
      lines.push(formatErrorDisplay(message.content, fullError));
      lines.push('');
      lines.push(pc.dim('─'.repeat(40)));
      lines.push('');
      i = j;
      continue;
    }

    // Check if this is thinking/reasoning
    if (isThinking(message.content)) {
      lines.push(`${pc.magenta(pc.bold('Thinking:'))} ${timestampDisplay}`);
      lines.push(formatThinkingDisplay(message.content, fullThinking));
      lines.push('');
      lines.push(pc.dim('─'.repeat(40)));
      lines.push('');
      i = j;
      continue;
    }

    const roleLabel =
      message.role === 'user'
        ? `${pc.blue(pc.bold('You:'))} ${timestampDisplay}`
        : `${pc.green(pc.bold('Assistant:'))} ${timestampDisplay}`;

    lines.push(roleLabel);
    lines.push('');

    // Apply short mode truncation for user and assistant messages
    if (short) {
      const truncatedContent = truncate(message.content, 300);
      lines.push(truncatedContent);
    } else {
      lines.push(message.content);
    }

    lines.push('');
    lines.push(pc.dim('─'.repeat(40)));
    lines.push('');

    i = j;
  }

  return lines.join('\n');
}

/**
 * Format search results
 */
export function formatSearchResultsTable(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return pc.yellow(`No results found for: "${query}"`);
  }

  const lines: string[] = [];
  const totalMatches = results.reduce((sum, r) => sum + r.matchCount, 0);

  lines.push(pc.bold(`Search results for "${query}"`));
  lines.push(pc.dim(`Found ${totalMatches} match(es) in ${results.length} session(s)`));
  lines.push('');
  lines.push(pc.dim('─'.repeat(80)));
  lines.push('');

  for (const result of results) {
    lines.push(
      `${pc.cyan(`#${result.index}`)} ${pc.dim(formatDate(result.createdAt))} ${pc.dim(result.workspacePath)}`
    );
    lines.push(`  ${pc.dim(`${result.matchCount} match(es)`)}`);

    // Show first snippet with highlighting
    if (result.snippets.length > 0) {
      const snippet = result.snippets[0]!;
      const roleLabel = snippet.messageRole === 'user' ? pc.blue('[You]') : pc.green('[AI]');

      // Highlight matches in snippet
      let highlighted = snippet.text;
      // Apply highlights in reverse order to preserve positions
      const sortedPositions = [...snippet.matchPositions].sort((a, b) => b[0] - a[0]);
      for (const [start, end] of sortedPositions) {
        const before = highlighted.slice(0, start);
        const match = highlighted.slice(start, end);
        const after = highlighted.slice(end);
        highlighted = before + pc.bgYellow(pc.black(match)) + after;
      }

      lines.push(`  ${roleLabel} ${highlighted}`);
    }

    lines.push('');
  }

  lines.push(pc.dim('Use --show <#> to view full session.'));

  return lines.join('\n');
}

/**
 * Format export success message
 */
export function formatExportSuccess(exported: { index: number; path: string }[]): string {
  const lines: string[] = [];

  lines.push(pc.green(`✓ Exported ${exported.length} session(s):`));
  for (const { index, path } of exported) {
    lines.push(`  ${pc.cyan(`#${index}`)} → ${path}`);
  }

  return lines.join('\n');
}

/**
 * Format empty state message for no history
 */
export function formatNoHistory(): string {
  const lines = [
    pc.yellow('No chat history found.'),
    '',
    'To start recording chat history:',
    '  1. Open a project in Cursor',
    '  2. Start a conversation with the AI assistant',
    '  3. Run this command again',
  ];

  return lines.join('\n');
}

/**
 * Format error message for Cursor not installed
 */
export function formatCursorNotFound(searchPath: string): string {
  const lines = [
    pc.red('Cursor data not found.'),
    '',
    `Searched in: ${searchPath}`,
    '',
    'Make sure Cursor is installed and has been used at least once.',
    '',
    'You can specify a custom path with:',
    `  ${pc.cyan('--data-path <path>')}`,
    `  ${pc.cyan('CURSOR_DATA_PATH')} environment variable`,
  ];

  return lines.join('\n');
}
