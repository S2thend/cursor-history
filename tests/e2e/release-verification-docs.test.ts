import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const documentationPath = resolve('docs/release-verification.md');
const workflowPath = resolve('.github/workflows/npm-publish.yml');
const packagePath = resolve('package.json');

const OFFICIAL_HANDOFF_HEADING = '## Official release-candidate handoff';
const T113_HEADING = '## Private v0.16 full-corpus differential (T113)';
const T115_HEADING = '## Exact-tarball maintainer verification (T115)';
const T113_ATTESTATION_HEADING = '### T113 aggregate attestation';
const T115_ATTESTATION_HEADING = '### T115 aggregate attestation';

const baseOperations = [
  'list',
  'show-index',
  'show-id',
  'search',
  'export-json',
  'export-markdown',
] as const;

function markdownSection(source: string, heading: string): string | undefined {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return undefined;
  const level = /^#+/u.exec(heading)?.[0].length;
  if (!level) return undefined;
  const end = lines.findIndex((line, index) => {
    if (index <= start) return false;
    const match = /^(#+)\s/u.exec(line);
    return match !== null && match[1]!.length <= level;
  });
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

function textFence(section: string): string | undefined {
  return /```text\s*\n([\s\S]*?)\n```/u.exec(section)?.[1];
}

function attestationFields(section: string): Map<string, string> {
  const block = textFence(section);
  if (!block) return new Map();
  return new Map(
    block
      .split(/\r?\n/u)
      .map((line) => /^([a-z][a-z0-9_]*):\s*(.*)$/u.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1]!, match[2]!] as const)
  );
}

function tableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return [];
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function operationTokens(cell: string): string[] {
  return [...cell.matchAll(/`([a-z][a-z-]*)`/gu)].map((match) => match[1]!);
}

function operationRows(section: string): Map<string, readonly [string[], string[]]> {
  const rows = new Map<string, readonly [string[], string[]]>();
  for (const line of section.split(/\r?\n/u)) {
    const cells = tableCells(line);
    if (cells.length !== 3) continue;
    const source = /^`([^`]+)`$/u.exec(cells[0]!)?.[1];
    if (!source) continue;
    rows.set(source, [operationTokens(cells[1]!), operationTokens(cells[2]!)]);
  }
  return rows;
}

function requireFields(
  fields: ReadonlyMap<string, string>,
  required: readonly string[],
  label: string,
  errors: string[]
): void {
  for (const key of required) {
    if (!fields.has(key)) errors.push(`${label} attestation is missing ${key}`);
  }
}

function requireTerms(
  section: string,
  terms: readonly string[],
  label: string,
  errors: string[]
): void {
  const normalizedSection = section.replace(/\s+/gu, ' ');
  for (const term of terms) {
    if (!normalizedSection.includes(term.replace(/\s+/gu, ' '))) {
      errors.push(`${label} is missing ${term}`);
    }
  }
}

function validateOperationMatrix(section: string, errors: string[]): void {
  const rows = operationRows(section);
  for (const source of ['live', 'custom-path', 'created-backup']) {
    const row = rows.get(source);
    if (!row) {
      errors.push(`T115 operation matrix is missing ${source}`);
      continue;
    }
    for (const [interfaceName, operations] of [
      ['Library', row[0]],
      ['CLI', row[1]],
    ] as const) {
      for (const operation of baseOperations) {
        if (!operations.includes(operation)) {
          errors.push(`T115 ${source} ${interfaceName} operations missing ${operation}`);
        }
      }
      if (source !== 'created-backup' && !operations.includes('backup-create')) {
        errors.push(`T115 ${source} ${interfaceName} operations missing backup-create`);
      }
    }
  }
}

function validateReleaseVerificationDocument(
  documentation: string,
  workflow: string,
  packageVersion: string
): string[] {
  const errors: string[] = [];
  const handoff = markdownSection(documentation, OFFICIAL_HANDOFF_HEADING);
  const t113 = markdownSection(documentation, T113_HEADING);
  const t115 = markdownSection(documentation, T115_HEADING);
  const t113Attestation = markdownSection(documentation, T113_ATTESTATION_HEADING);
  const t115Attestation = markdownSection(documentation, T115_ATTESTATION_HEADING);

  for (const [heading, section] of [
    [OFFICIAL_HANDOFF_HEADING, handoff],
    [T113_HEADING, t113],
    [T115_HEADING, t115],
    [T113_ATTESTATION_HEADING, t113Attestation],
    [T115_ATTESTATION_HEADING, t115Attestation],
  ] as const) {
    if (!section) errors.push(`missing section: ${heading}`);
  }

  if (handoff) {
    requireTerms(
      handoff,
      [
        '.github/workflows/npm-publish.yml',
        `v${packageVersion}`,
        'npm-candidate-<sha256>',
        '.tgz',
        'candidate.sha256',
        'candidate-metadata.json',
        'candidate-metadata.json.sha256',
        'candidate-metadata.json.revision',
        'candidate-metadata.json.version',
        'candidate-metadata.json.tag',
        'candidate-metadata.json.tarball',
        'frozen T114 revision',
        'tagged commit',
        'Recompute the tarball SHA-256',
        'exactly one `.tgz`',
        'protected publish job unapproved',
        'gh run download "$RUN_ID"',
        '--name "npm-candidate-$CANDIDATE_SHA256"',
        'sha256sum -c candidate.sha256',
        'test "$ACTUAL_SHA256" = "$CANDIDATE_SHA256"',
      ],
      'official handoff',
      errors
    );
  }

  if ((workflow.match(/\bnpm pack\b/gu) ?? []).length !== 1) {
    errors.push('publish workflow does not pack exactly once');
  }
  for (const workflowToken of [
    'name: npm-candidate-${{ steps.identity.outputs.sha256 }}',
    'candidate.sha256',
    'candidate-metadata.json',
  ]) {
    if (!workflow.includes(workflowToken)) {
      errors.push(`publish workflow is missing ${workflowToken}`);
    }
  }

  if (t115) {
    requireTerms(
      t115,
      [
        'production install',
        'verified official `.tgz`',
        "import 'cursor-history'",
        'package bin installed in that runner',
        'formal tarball',
        'Do not use `npm link`',
        '`npm pack`',
        '`npm run build`',
        'repository `src/`',
        'repository `dist/`',
        'registry installation',
        'npm install --omit=dev --no-audit --no-fund --save-exact "$CANDIDATE_TARBALL"',
        "await import('cursor-history')",
        './node_modules/.bin/cursor-history --version',
        '`0700`',
        '`0600`',
        'do not retain the salt',
        'zero off-scope payload events',
        'zero temporary residue',
      ],
      'T115 tarball-only verification',
      errors
    );
    const executableFences = [...t115.matchAll(/```(?:bash|sh|shell)\s*\n([\s\S]*?)\n```/gu)];
    for (const fence of executableFences) {
      if (/^\s*npm\s+(?:pack|link|run\s+build)\b/mu.test(fence[1]!)) {
        errors.push('T115 executable instructions rebuild, repack, or link the candidate');
      }
      if (/\b(?:src|dist)\//u.test(fence[1]!)) {
        errors.push('T115 executable instructions invoke repository source or build output');
      }
    }
    validateOperationMatrix(t115, errors);
  }

  if (t113 && !/no official tarball hash/iu.test(documentation)) {
    errors.push('T113 is not explicitly separated from the official tarball identity');
  }

  if (t113Attestation) {
    const fields = attestationFields(t113Attestation);
    requireFields(
      fields,
      [
        'task',
        'candidate_source_revision',
        'v016_oracle_revision',
        'external_consumer_arr',
        'external_consumer_provenance',
        'platform',
        'node',
        'corpus_counts',
        'public_value_shape_differential',
        'all_candidate_association',
        'unchanged_consumer_initial_import',
        'forced_transaction_failure',
        'transaction_rollback_reopen',
        'candidate_retry',
        'old_key_binding_preservation',
        'repeated_sync_writes',
        'documented_drift_categories',
        'private_modes',
        'temporary_residue_count',
        'overall_result',
      ],
      'T113',
      errors
    );
    if (fields.get('task') !== 'T113') errors.push('T113 attestation has the wrong task identity');
    if (fields.get('repeated_sync_writes') !== '0') {
      errors.push('T113 repeated_sync_writes must equal 0');
    }
    if (fields.get('temporary_residue_count') !== '0') {
      errors.push('T113 temporary_residue_count must equal 0');
    }
    for (const forbidden of ['official_artifact', 'candidate_sha256']) {
      if (fields.has(forbidden)) errors.push(`T113 attestation must not contain ${forbidden}`);
    }
  }

  if (t115Attestation) {
    const fields = attestationFields(t115Attestation);
    requireFields(
      fields,
      [
        'task',
        'frozen_revision_tag',
        'official_artifact',
        'candidate_sha256',
        'candidate_metadata_binding',
        'platform',
        'node',
        'sqlite_capability_profile',
        'formal_tarball_install',
        'operation_matrix',
        'source_limit_policy',
        'source_limit_policy_sha256',
        'source_limit_carrier_counts',
        'source_limit_maxima',
        'source_limit_exceeded_fields',
        'identity_check',
        'fidelity_states',
        'io_event_totals',
        'off_scope_payload_events',
        'poison_canary_hits',
        'private_modes',
        'temporary_residue_count',
        'overall_approval',
      ],
      'T115',
      errors
    );
    if (fields.get('task') !== 'T115') errors.push('T115 attestation has the wrong task identity');
    if (!fields.get('official_artifact')?.includes('npm-candidate-<sha256>')) {
      errors.push('T115 attestation does not name the official checksum-addressed artifact');
    }
    for (const zeroField of [
      'off_scope_payload_events',
      'poison_canary_hits',
      'temporary_residue_count',
    ]) {
      if (fields.get(zeroField) !== '0') {
        errors.push(`T115 attestation ${zeroField} must equal 0`);
      }
    }
  }

  return errors;
}

function mutateMatrixOperation(
  documentation: string,
  source: string,
  interfaceName: 'Library' | 'CLI',
  operation: string
): string {
  const lines = documentation.split(/\r?\n/u);
  const rowIndex = lines.findIndex((line) => tableCells(line)[0] === `\`${source}\``);
  if (rowIndex < 0) throw new Error(`operation row ${source} is missing`);
  const cells = tableCells(lines[rowIndex]!);
  const cellIndex = interfaceName === 'Library' ? 1 : 2;
  const operations = operationTokens(cells[cellIndex]!).filter((entry) => entry !== operation);
  cells[cellIndex] = operations.map((entry) => `\`${entry}\``).join(', ');
  lines[rowIndex] = `| ${cells.join(' | ')} |`;
  return lines.join('\n');
}

function replaceLast(source: string, target: string, replacement: string): string {
  const index = source.lastIndexOf(target);
  if (index < 0) throw new Error(`mutation target is missing: ${target}`);
  return `${source.slice(0, index)}${replacement}${source.slice(index + target.length)}`;
}

describe('private release-verification documentation contract', () => {
  const documentation = readFileSync(documentationPath, 'utf8');
  const workflow = readFileSync(workflowPath, 'utf8');
  const packageVersion = (JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string })
    .version;

  it('binds separate private gates to the one official packed candidate', () => {
    expect(validateReleaseVerificationDocument(documentation, workflow, packageVersion)).toEqual(
      []
    );
  });

  it('rejects missing candidate metadata and local repacking instructions', () => {
    const missingMetadata = documentation.replaceAll(
      'candidate-metadata.json',
      'candidate-metadata.removed'
    );
    expect(
      validateReleaseVerificationDocument(missingMetadata, workflow, packageVersion)
    ).toContain('official handoff is missing candidate-metadata.json');

    const localPack = documentation.replace(
      T115_HEADING,
      `${T115_HEADING}\n\n\`\`\`sh\nnpm pack\n\`\`\``
    );
    expect(validateReleaseVerificationDocument(localPack, workflow, packageVersion)).toContain(
      'T115 executable instructions rebuild, repack, or link the candidate'
    );

    const registryInstall = documentation.replace(
      'npm install --omit=dev --no-audit --no-fund --save-exact "$CANDIDATE_TARBALL"',
      'npm install cursor-history'
    );
    expect(
      validateReleaseVerificationDocument(registryInstall, workflow, packageVersion)
    ).toContain(
      'T115 tarball-only verification is missing npm install --omit=dev --no-audit --no-fund --save-exact "$CANDIDATE_TARBALL"'
    );
  });

  it('rejects merged or missing T113 and T115 attestation boundaries', () => {
    for (const heading of [T113_ATTESTATION_HEADING, T115_ATTESTATION_HEADING]) {
      const mutated = documentation.replace(heading, `${heading} removed`);
      expect(validateReleaseVerificationDocument(mutated, workflow, packageVersion)).toContain(
        `missing section: ${heading}`
      );
    }
  });

  it('rejects missing interface, source, and addressing operations', () => {
    for (const [source, interfaceName, operation] of [
      ['custom-path', 'CLI', 'search'],
      ['live', 'Library', 'show-id'],
      ['created-backup', 'CLI', 'export-markdown'],
    ] as const) {
      const mutated = mutateMatrixOperation(documentation, source, interfaceName, operation);
      expect(validateReleaseVerificationDocument(mutated, workflow, packageVersion)).toContain(
        `T115 ${source} ${interfaceName} operations missing ${operation}`
      );
    }
  });

  it('rejects nonzero off-scope, poison-canary, and residue evidence', () => {
    for (const field of [
      'off_scope_payload_events',
      'poison_canary_hits',
      'temporary_residue_count',
    ]) {
      const mutated = replaceLast(documentation, `${field}: 0`, `${field}: 1`);
      expect(validateReleaseVerificationDocument(mutated, workflow, packageVersion)).toContain(
        `T115 attestation ${field} must equal 0`
      );
    }

    const t113Residue = documentation.replace(
      'temporary_residue_count: 0',
      'temporary_residue_count: 1'
    );
    expect(validateReleaseVerificationDocument(t113Residue, workflow, packageVersion)).toContain(
      'T113 temporary_residue_count must equal 0'
    );
  });
});
