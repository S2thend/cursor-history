/**
 * Export-training command - project chat sessions into fine-tuning datasets.
 *
 * Unlike `export` (one document per session), this command streams every
 * selected session into a JSONL dataset using shared messages, ShareGPT or TRL
 * format adapters over the same sanitized projection.
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { dirname } from 'node:path';
import type { WriteStream } from 'node:fs';
import { getSession, listSessionSummaries, createSessionReadContext } from '../../core/storage.js';
import {
  projectSession,
  serializeTrainingLine,
  mergeRedactionCounts,
  assignSplit,
  deriveValidationPath,
  type TrainingDropReason,
  type RedactionCounts,
} from '../../core/training.js';
import {
  validateToolDefinitions,
  type TrainingSchema,
  type TrainingToolDefinition,
} from '../../core/training-formats.js';
import { handleCommandError, CliError, ExitCode, FileExistsError } from '../errors.js';
import { expandPath, contractPath } from '../../lib/platform.js';
import type { ChatSessionSummary, SourceReadLimitsOverride } from '../../core/types.js';
import { validateCliSourceLimitOverrides } from '../source-limit-option.js';
import {
  createAmbiguousSessionDiagnostic,
  createCliDiagnosticCollector,
  createSessionAmbiguityDiagnostic,
} from '../diagnostics.js';
import { SessionAmbiguityError } from '../../core/errors.js';
import { adaptScopedBackupReadError } from '../backup-read-error.js';

interface ExportTrainingOptions {
  output?: string;
  schema?: string;
  toolsFile?: string;
  maxToolChars?: string;
  maxUserChars?: string;
  maxRecordChars?: string;
  minUserTurns?: string;
  validRatio?: string;
  validOutput?: string;
  splitSeed?: string;
  redact?: boolean;
  anonymizePaths?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  systemPrompt?: string;
  systemPromptFile?: string;
  force?: boolean;
  json?: boolean;
  dataPath?: string;
}

const DEFAULTS = Object.freeze({
  output: 'cursor-history-training.jsonl',
  schema: 'messages',
  maxToolChars: 4000,
  maxUserChars: 8000,
  maxRecordChars: 40_000,
  minUserTurns: 1,
});

function parsePositiveInt(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new CliError(
      `Invalid value for ${flag}: ${raw}. Expected a non-negative integer.`,
      ExitCode.USAGE_ERROR
    );
  }
  return value;
}

/** Write a chunk, awaiting drain so large datasets do not balloon memory. */
async function writeChunk(stream: WriteStream, chunk: string): Promise<void> {
  if (stream.errored) throw stream.errored;
  if (!stream.write(chunk)) {
    await once(stream, 'drain');
  }
}

export function registerExportTrainingCommand(program: Command): void {
  program
    .command('export-training')
    .description('Export all sessions as a JSONL dataset for fine-tuning an AI agent')
    .option('-o, --output <path>', 'Output .jsonl file', DEFAULTS.output)
    .option(
      '--schema <schema>',
      'Export profile: messages, sharegpt, or trl (HF object arguments)',
      DEFAULTS.schema
    )
    .option(
      '--tools-file <path>',
      'JSON array of function schemas (required for TRL unless --no-tools)'
    )
    .option('--max-tool-chars <n>', 'Max characters kept per tool result (0 = unlimited)')
    .option('--max-user-chars <n>', 'Max characters kept per user message (0 = unlimited)')
    .option(
      '--max-record-chars <n>',
      'Split sessions larger than this many characters at user turns'
    )
    .option('--min-user-turns <n>', 'Skip records with fewer user turns than this')
    .option(
      '--valid-ratio <r>',
      'Hold out this fraction (0-1) of sessions as a validation split (split by session, not record)'
    )
    .option('--valid-output <path>', 'Validation split path (default: <output>.validation.jsonl)')
    .option('--split-seed <n>', 'Seed for deterministic split assignment', '42')
    .option('--no-redact', 'Disable credential/secret redaction (NOT recommended)')
    .option('--no-anonymize-paths', 'Keep absolute home-directory paths as-is')
    .option('--no-tools', 'Drop structured tool calls and tool results')
    .option('--no-reasoning', 'Drop assistant reasoning/thinking text')
    .option('--system-prompt <text>', 'System prompt prepended to every record')
    .option('--system-prompt-file <path>', 'Read the system prompt from a file')
    .option('--force', 'Overwrite an existing output file')
    .addHelpText(
      'after',
      `\nExamples:\n  cursor-history export-training -o dataset.jsonl\n  cursor-history export-training --schema trl --no-tools --no-reasoning -o sft.jsonl\n  cursor-history export-training --schema trl --tools-file tools.json -o agent.jsonl\n  cursor-history export-training --schema sharegpt -o sharegpt.jsonl\n`
    )
    .action(async (options: ExportTrainingOptions, command: Command) => {
      const globalOptions = command.parent?.opts() as {
        json?: boolean;
        dataPath?: string;
        workspace?: string;
        includeCrossWorkspaceSources?: boolean;
        sourceLimit?: SourceReadLimitsOverride;
      };
      const useJson = options.json ?? globalOptions?.json ?? false;
      const customPath = options.dataPath ?? globalOptions?.dataPath;
      const workspaceFilter = globalOptions?.workspace;
      const includeCrossWorkspaceSources = globalOptions?.includeCrossWorkspaceSources ?? false;

      try {
        const sourceReadLimits = validateCliSourceLimitOverrides(globalOptions?.sourceLimit);
        const requestedSchema = options.schema ?? DEFAULTS.schema;
        if (!['messages', 'sharegpt', 'trl'].includes(requestedSchema)) {
          throw new CliError(
            `Unknown --schema: ${requestedSchema}. Expected "messages", "sharegpt" or "trl".`,
            ExitCode.USAGE_ERROR
          );
        }
        const schema = requestedSchema as TrainingSchema;
        if (options.toolsFile !== undefined && (options.tools === false || schema === 'sharegpt')) {
          throw new CliError(
            '--tools-file requires tools enabled and --schema messages or trl.',
            ExitCode.USAGE_ERROR
          );
        }
        if (schema === 'trl' && options.tools !== false && options.toolsFile === undefined) {
          throw new CliError(
            'TRL tool export requires --tools-file <path>. For text-only SFT, use --no-tools.',
            ExitCode.USAGE_ERROR
          );
        }
        let toolDefinitions: TrainingToolDefinition[] | undefined;
        if (options.toolsFile !== undefined) {
          const text = readFileSync(expandPath(options.toolsFile), 'utf-8').replace(/^\uFEFF/, '');
          try {
            toolDefinitions = validateToolDefinitions(JSON.parse(text));
          } catch (error) {
            throw new CliError(
              `Invalid --tools-file: ${error instanceof Error ? error.message : String(error)}`,
              ExitCode.USAGE_ERROR
            );
          }
        }

        const systemPrompt =
          options.systemPromptFile !== undefined
            ? readFileSync(expandPath(options.systemPromptFile), 'utf-8').trim()
            : options.systemPrompt?.trim();

        const outputPath = expandPath(options.output ?? DEFAULTS.output);
        const validRatio =
          options.validRatio === undefined ? 0 : Number.parseFloat(options.validRatio);
        if (!Number.isFinite(validRatio) || validRatio < 0 || validRatio > 1) {
          throw new CliError(
            `Invalid --valid-ratio: ${options.validRatio}. Expected a number between 0 and 1.`,
            ExitCode.USAGE_ERROR
          );
        }
        const splitSeed = parsePositiveInt(options.splitSeed, 42, '--split-seed');
        const validationPath =
          validRatio > 0
            ? expandPath(options.validOutput ?? deriveValidationPath(outputPath))
            : undefined;
        if (validationPath !== undefined && validationPath === outputPath) {
          throw new CliError(
            'Validation output must differ from the training output.',
            ExitCode.USAGE_ERROR
          );
        }
        for (const path of [outputPath, validationPath]) {
          if (path !== undefined && existsSync(path) && !options.force) {
            throw new FileExistsError(path);
          }
        }
        const outputDir = dirname(outputPath);
        if (outputDir !== '.' && !existsSync(outputDir)) {
          mkdirSync(outputDir, { recursive: true });
        }

        const projectionOptions = {
          schema,
          ...(toolDefinitions !== undefined ? { toolDefinitions } : {}),
          includeToolCalls: options.tools !== false,
          includeReasoning: options.reasoning !== false,
          maxToolResultChars: parsePositiveInt(
            options.maxToolChars,
            DEFAULTS.maxToolChars,
            '--max-tool-chars'
          ),
          maxUserChars: parsePositiveInt(
            options.maxUserChars,
            DEFAULTS.maxUserChars,
            '--max-user-chars'
          ),
          maxCharsPerRecord: parsePositiveInt(
            options.maxRecordChars,
            DEFAULTS.maxRecordChars,
            '--max-record-chars'
          ),
          minUserTurns: parsePositiveInt(
            options.minUserTurns,
            DEFAULTS.minUserTurns,
            '--min-user-turns'
          ),
          redact: options.redact !== false,
          anonymizePaths: options.anonymizePaths !== false,
          ...(systemPrompt ? { systemPrompt } : {}),
        };

        const expanded = customPath ? expandPath(customPath) : undefined;
        const diagnosticCollector = createCliDiagnosticCollector();
        const context = createSessionReadContext({
          dataPath: expanded,
          backupPath: undefined,
          workspacePath: workspaceFilter,
          ...(includeCrossWorkspaceSources ? { includeCrossWorkspaceSources: true } : {}),
          resolvedSessionCapacity: 0,
          sourceReadLimits,
          onDiagnostic: diagnosticCollector.onDiagnostic,
        });

        const drops: Record<string, number> = {};
        let redaction: RedactionCounts = { privateKey: 0, jwt: 0, apiKey: 0, secretAssignment: 0 };
        let recordsWritten = 0;
        let sessionsScanned = 0;
        let bytesWritten = 0;
        const splitCounts: Record<'train' | 'validation', number> = { train: 0, validation: 0 };
        const streams = new Map<'train' | 'validation', WriteStream>();
        const streamCompletions: Promise<void>[] = [];

        const streamFor = (split: 'train' | 'validation'): WriteStream => {
          const existing = streams.get(split);
          if (existing) return existing;
          const target = split === 'validation' ? validationPath! : outputPath;
          const created = createWriteStream(target, { encoding: 'utf-8' });
          const completion = finished(created);
          // Observe errors immediately; propagate them when finalizing all outputs.
          void completion.catch(() => {});
          streamCompletions.push(completion);
          streams.set(split, created);
          return created;
        };

        try {
          const logicalSessions = await listSessionSummaries(
            {
              limit: 0,
              all: true,
              workspacePath: workspaceFilter,
              ...(includeCrossWorkspaceSources ? { includeCrossWorkspaceSources: true } : {}),
              ...(sourceReadLimits ? { sourceReadLimits } : {}),
            },
            expanded,
            undefined,
            context
          );

          if (logicalSessions.length === 0) {
            throw new CliError('No sessions to export.', ExitCode.NOT_FOUND);
          }

          for (const summary of logicalSessions) {
            if (summary.resolutionState === 'ambiguous') {
              diagnosticCollector.onDiagnostic(createAmbiguousSessionDiagnostic(summary));
            }
          }
          const sessions = logicalSessions.filter(
            (summary): summary is ChatSessionSummary => summary.resolutionState !== 'ambiguous'
          );

          for (const summary of sessions) {
            try {
              const session = await getSession(
                summary.id,
                expanded,
                undefined,
                context,
                summary.index
              );
              if (!session) continue;
              sessionsScanned += 1;

              const projection = projectSession(session, projectionOptions);
              redaction = mergeRedactionCounts(redaction, projection.redaction);

              if (projection.records.length === 0) {
                const reason: TrainingDropReason = projection.dropReason ?? 'empty';
                drops[reason] = (drops[reason] ?? 0) + 1;
                continue;
              }

              for (let index = 0; index < projection.records.length; index += 1) {
                const record =
                  schema === 'sharegpt' ? projection.shareGpt[index]! : projection.records[index]!;
                const split = assignSplit(record.id, validRatio, splitSeed);
                let line: string;
                try {
                  line = `${serializeTrainingLine(record, schema)}\n`;
                } catch (error) {
                  throw new CliError(
                    error instanceof Error ? error.message : String(error),
                    ExitCode.USAGE_ERROR
                  );
                }
                const stream = streamFor(split);
                await writeChunk(stream, line);
                recordsWritten += 1;
                splitCounts[split] += 1;
                bytesWritten += Buffer.byteLength(line, 'utf-8');
              }
            } catch (error) {
              if (!(error instanceof SessionAmbiguityError)) throw error;
              diagnosticCollector.onDiagnostic(
                createSessionAmbiguityDiagnostic(
                  error.details.sessionId,
                  error.details.occurrenceRefs
                )
              );
            } finally {
              context.releaseSession(summary.id);
            }
          }
        } finally {
          try {
            for (const stream of streams.values()) stream.end();
            // Both splits can finish in the same tick. Their listeners were registered
            // at creation, so neither completion can be missed while awaiting the other.
            await Promise.all(streamCompletions);
          } finally {
            await context.dispose();
          }
        }

        const result = {
          output: contractPath(outputPath),
          ...(validationPath ? { validationOutput: contractPath(validationPath) } : {}),
          schema,
          sessionsScanned,
          recordsWritten,
          ...(validRatio > 0
            ? { split: { ratio: validRatio, seed: splitSeed, counts: splitCounts } }
            : {}),
          bytesWritten,
          dropped: drops,
          redaction,
          diagnostics: diagnosticCollector.diagnostics,
        };

        if (useJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const lines = [
            pc.green(`Wrote ${recordsWritten} training record(s) to ${contractPath(outputPath)}`),
            pc.dim(`Schema: ${schema} | Sessions scanned: ${sessionsScanned}`),
          ];
          if (validationPath) {
            lines.push(
              pc.green(
                `Wrote ${splitCounts.validation} validation record(s) (${splitCounts.train} train) to ` +
                  `${contractPath(validationPath)}`
              )
            );
            lines.push(
              pc.dim(
                `Split by session (segments stay together) at ratio ${validRatio} with seed ${splitSeed}`
              )
            );
          }
          const droppedTotal = Object.values(drops).reduce((sum, count) => sum + count, 0);
          if (droppedTotal > 0) {
            lines.push(pc.yellow(`Skipped ${droppedTotal} session(s):`));
            for (const [reason, count] of Object.entries(drops).sort((a, b) => b[1] - a[1])) {
              lines.push(pc.dim(`  ${count}  ${reason}`));
            }
          }
          const redactedTotal =
            redaction.privateKey + redaction.jwt + redaction.apiKey + redaction.secretAssignment;
          if (redactedTotal > 0) {
            lines.push(
              pc.yellow(
                `Redacted ${redactedTotal} secret(s): ` +
                  `${redaction.privateKey} private-key, ${redaction.jwt} jwt, ` +
                  `${redaction.apiKey} api-key, ${redaction.secretAssignment} assignment`
              )
            );
          }
          console.log(lines.join('\n'));
        }
      } catch (error) {
        handleCommandError(adaptScopedBackupReadError(error, false), { json: useJson });
      }
    });
}
