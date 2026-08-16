import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const documentationPath = resolve('docs/release-verification.md');
const workflowPath = resolve('.github/workflows/npm-publish.yml');
const packagePath = resolve('package.json');

const OFFICIAL_HANDOFF_HEADING = '## Official release-candidate handoff';
const T113_HEADING = '## Private v0.16 deterministic structure-coverage certification (T113)';
const T115_HEADING = '## Exact-tarball maintainer verification (T115)';
const T113_ATTESTATION_HEADING = '### T113 aggregate attestation';
const T115_ATTESTATION_HEADING = '### T115 aggregate attestation';

const T113_STRUCTURE_PREDICATE_KEYS = [
  'id.native',
  'id.absent',
  'id.null',
  'id.empty',
  'type.user',
  'type.assistant',
  'type.tool',
  'type.thinking',
  'type.error',
  'type.thinking-with-tool',
  'type.error-with-tool',
  'source.unknown-bubble-type',
  'payload.fenced-code',
  'shape.optional-present',
  'shape.optional-undefined-own',
  'shape.optional-omitted',
  'tool.single',
  'tool.multiple',
  'tool.completed',
  'tool.cancelled',
  'tool.error',
  'relationship.parent',
  'relationship.sidechain',
  'relationship.active-branch',
  'time.message-created-at',
  'time.message-timing',
  'time.inferred-next',
  'time.inferred-previous',
  'time.session-fallback',
  'time.unknown',
  'time.session-created-stored',
  'time.session-updated-stored',
  'time.session-updated-from-message',
  'time.session-epoch-unknown',
  'scope.global-complete',
  'scope.workspace-fallback',
  'scope.real-path',
  'scope.path-placeholder',
  'occurrence.equivalent',
  'occurrence.divergent',
  'occurrence.uuid-case-variant',
] as const;

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

function shellFences(section: string): string[] {
  return [...section.matchAll(/```(?:bash|sh|shell)\s*\n([\s\S]*?)\n```/gu)].map(
    (match) => match[1] ?? ''
  );
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

function t113PredicateRows(section: string): string[][] {
  return section
    .split(/\r?\n/u)
    .map((line) => tableCells(line))
    .filter((cells) => cells.length === 4 && /^`[^`]+`$/u.test(cells[0] ?? ''));
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
    const executableFences = shellFences(handoff);
    if (executableFences.length === 0) errors.push('official handoff has no executable procedure');
    for (const fence of executableFences) {
      if ((fence.split(/\r?\n/u)[0] ?? '') !== 'set -euo pipefail') {
        errors.push('official handoff executable procedure is not fail-fast');
      }
    }
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
    const executableFences = shellFences(t115);
    if (executableFences.length === 0) errors.push('T115 has no executable bootstrap');
    for (const fence of executableFences) {
      if ((fence.split(/\r?\n/u)[0] ?? '') !== 'set -euo pipefail') {
        errors.push('T115 executable bootstrap is not fail-fast');
      }
      if (/^\s*npm\s+(?:pack|link|run\s+build)\b/mu.test(fence)) {
        errors.push('T115 executable instructions rebuild, repack, or link the candidate');
      }
      if (/\b(?:src|dist)\//u.test(fence)) {
        errors.push('T115 executable instructions invoke repository source or build output');
      }
    }
    validateOperationMatrix(t115, errors);
  }

  if (t113) {
    requireTerms(
      t113,
      [
        'fresh owner-private directory',
        'reject unsafe archive members',
        'entire extracted tree',
        'before dynamic imports or data access',
        'one checksum-addressed pre-freeze packed candidate',
        'real-corpus lane',
        'Store provably empty',
        'fictional-transaction lane',
        '`t113-structure-coverage/v1`',
        'at most eight logical sessions',
        'Every key in this finite registry is required',
        'the released classifier is fixed as',
        'The T113 harness manifest maps each mutant name to a self-test',
        'greatest number of currently uncovered predicates',
        'greater total number of registry predicates',
        'earlier v0.16 global ordinal',
        'must not participate in scoring or tie-breaking',
        'An empty corpus fails certification',
        'same selected set',
        'four isolated copies',
        'locked additive-field allowlist',
        '“additive” is not a wildcard that suppresses drift',
        'Every non-additive difference must satisfy exactly one predicate',
        'zero session/content mutations',
        '`sync_metadata` schema-version upsert',
        'deterministic wholly fictional regression',
        'mutation that proves drift is detected',
        'must never be described as full-corpus real-data certification',
        'T113 writes no repository file',
        'No raw or aggregate real-data result',
        'candidate revision and tracked tree are unchanged after T113',
        'must not copy, transform, hash into, or otherwise derive',
        'Both lanes must pass',
        'neither lane substitutes for the other',
        'non-excepted selected durable old value',
        'predicate-guarded scalar correction',
      ],
      'T113 private certification',
      errors
    );
    const predicateRows = t113PredicateRows(t113);
    const actualPredicateKeys = predicateRows.map((cells) => cells[0]!.slice(1, -1));
    if (JSON.stringify(actualPredicateKeys) !== JSON.stringify(T113_STRUCTURE_PREDICATE_KEYS)) {
      errors.push('T113 structure predicate registry does not match the locked v1 key order');
    }
    if (T113_STRUCTURE_PREDICATE_KEYS.length !== 41) {
      errors.push('T113 locked v1 predicate key list must contain exactly 41 keys');
    }
    if (predicateRows.some((cells) => cells.slice(1).some((cell) => cell.length === 0))) {
      errors.push('T113 structure predicate registry contains an incomplete row');
    }
    const mutants = predicateRows.map((cells) => cells[3]);
    if (new Set(mutants).size !== mutants.length) {
      errors.push('T113 structure predicate registry mutant names must be unique');
    }
  }

  if (t113 && !/no final release-tarball hash/iu.test(documentation)) {
    errors.push('T113 is not explicitly separated from the final release-tarball identity');
  }

  if (t113Attestation) {
    const fields = attestationFields(t113Attestation);
    requireFields(
      fields,
      [
        'task',
        'candidate_source_revision',
        'candidate_artifact_sha256',
        'candidate_artifact_verified_before_import',
        'v016_oracle_revision',
        'v016_oracle_tree',
        'v016_oracle_distribution_sha256',
        'external_consumer_arr',
        'external_consumer_provenance',
        'validation_harness_manifest_sha256',
        'runtime_dependency_tree_sha256',
        'source_archive_maintainer_digest_verified',
        'fresh_safe_extraction',
        'raw_tree_before_after_identical',
        'owner_only_artifacts',
        'platform',
        'node',
        'source_inventory_counts',
        'selection_policy',
        'real_sample_count',
        'structure_registry_predicates',
        'structure_predicates_observed_in_source',
        'structure_predicates_covered_by_sample',
        'structure_predicates_covered_synthetically',
        'structure_predicates_unmapped',
        'same_sample_public_and_consumer',
        'sample_projection_selected_values_exact',
        'sample_projection_unselected_payload_records',
        'public_sample_value_shape_differential',
        'public_sample_association',
        'real_sample_initial_import',
        'real_sample_initial_import_session_content_mutations',
        'real_sample_initial_import_sync_metadata_upserts',
        'real_sample_initial_import_sync_metadata_value_changes',
        'real_sample_v016_repeat_session_content_mutations',
        'real_sample_v016_repeat_sync_metadata_upserts',
        'real_sample_v016_repeat_sync_metadata_value_changes',
        'real_sample_candidate_upgrade',
        'real_sample_candidate_upgrade_session_content_mutations',
        'real_sample_candidate_upgrade_sync_metadata_upserts',
        'real_sample_candidate_upgrade_sync_metadata_value_changes',
        'real_sample_old_binding_preservation',
        'real_sample_durable_exception_counts',
        'real_sample_candidate_repeat_session_content_mutations',
        'real_sample_candidate_repeat_sync_metadata_upserts',
        'real_sample_candidate_repeat_sync_metadata_value_changes',
        'fictional_transaction_baseline_import',
        'fictional_transaction_baseline_import_session_content_mutations',
        'fictional_transaction_baseline_import_sync_metadata_upserts',
        'fictional_transaction_baseline_import_sync_metadata_value_changes',
        'fictional_transaction_forced_failure',
        'fictional_transaction_forced_failure_attempted_session_content_mutations',
        'fictional_transaction_forced_failure_committed_session_content_mutations',
        'fictional_transaction_forced_failure_sync_metadata_upserts',
        'fictional_transaction_forced_failure_sync_metadata_value_changes',
        'fictional_transaction_rollback_reopen',
        'fictional_transaction_retry_complete_replacement',
        'fictional_transaction_retry_session_content_mutations',
        'fictional_transaction_retry_sync_metadata_upserts',
        'fictional_transaction_retry_sync_metadata_value_changes',
        'fictional_transaction_final_repeat_session_content_mutations',
        'fictional_transaction_final_repeat_sync_metadata_upserts',
        'fictional_transaction_final_repeat_sync_metadata_value_changes',
        'fictional_transaction_real_values_derived',
        'documented_drift_categories',
        'private_modes',
        'temporary_residue_count',
        'private_material_deleted',
        'overall_result',
      ],
      'T113',
      errors
    );
    if (fields.get('task') !== 'T113') errors.push('T113 attestation has the wrong task identity');
    if (fields.get('selection_policy') !== 't113-structure-coverage/v1') {
      errors.push('T113 attestation has the wrong selection policy');
    }
    if (fields.get('real_sample_count') !== '[1..8]') {
      errors.push('T113 attestation real_sample_count must declare the 1..8 bound');
    }
    if (fields.get('structure_registry_predicates') !== '41') {
      errors.push('T113 attestation structure_registry_predicates must equal 41');
    }
    for (const zeroField of [
      'real_sample_v016_repeat_session_content_mutations',
      'real_sample_candidate_repeat_session_content_mutations',
      'real_sample_v016_repeat_sync_metadata_value_changes',
      'real_sample_candidate_upgrade_sync_metadata_value_changes',
      'real_sample_candidate_repeat_sync_metadata_value_changes',
      'fictional_transaction_forced_failure_committed_session_content_mutations',
      'fictional_transaction_forced_failure_sync_metadata_value_changes',
      'fictional_transaction_retry_sync_metadata_value_changes',
      'fictional_transaction_final_repeat_session_content_mutations',
      'fictional_transaction_final_repeat_sync_metadata_value_changes',
      'fictional_transaction_real_values_derived',
      'structure_predicates_unmapped',
      'sample_projection_unselected_payload_records',
      'temporary_residue_count',
    ]) {
      if (fields.get(zeroField) !== '0') {
        errors.push(`T113 attestation ${zeroField} must equal 0`);
      }
    }
    for (const oneField of [
      'real_sample_v016_repeat_sync_metadata_upserts',
      'real_sample_initial_import_sync_metadata_upserts',
      'real_sample_candidate_upgrade_sync_metadata_upserts',
      'real_sample_candidate_repeat_sync_metadata_upserts',
      'fictional_transaction_baseline_import_sync_metadata_upserts',
      'fictional_transaction_forced_failure_sync_metadata_upserts',
      'fictional_transaction_retry_sync_metadata_upserts',
      'fictional_transaction_final_repeat_sync_metadata_upserts',
    ]) {
      if (fields.get(oneField) !== '1') {
        errors.push(`T113 attestation ${oneField} must equal 1`);
      }
    }
    for (const forbidden of [
      'official_artifact',
      'candidate_sha256',
      'corpus_counts',
      'all_candidate_association',
      'real_corpus_v016_repeat_writes',
      'real_corpus_candidate_repeat_writes',
      'fictional_transaction_final_repeat_writes',
    ]) {
      if (fields.has(forbidden)) errors.push(`T113 attestation must not contain ${forbidden}`);
    }
    if (fields.get('real_sample_initial_import_sync_metadata_value_changes') !== '1') {
      errors.push(
        'T113 attestation real_sample_initial_import_sync_metadata_value_changes must equal 1'
      );
    }
    if (fields.get('fictional_transaction_baseline_import_sync_metadata_value_changes') !== '1') {
      errors.push(
        'T113 attestation fictional_transaction_baseline_import_sync_metadata_value_changes must equal 1'
      );
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

  it('rejects artifact handoff or tarball bootstrap instructions that can continue after failure', () => {
    const noHandoffFailFast = documentation.replace(
      '```sh\nset -euo pipefail\numask 077',
      '```sh\numask 077'
    );
    expect(
      validateReleaseVerificationDocument(noHandoffFailFast, workflow, packageVersion)
    ).toContain('official handoff executable procedure is not fail-fast');

    const noBootstrapFailFast = documentation.replace(
      '```sh\nset -euo pipefail\nCANDIDATE_TARBALL=',
      '```sh\nCANDIDATE_TARBALL='
    );
    expect(
      validateReleaseVerificationDocument(noBootstrapFailFast, workflow, packageVersion)
    ).toContain('T115 executable bootstrap is not fail-fast');
  });

  it('rejects merged or missing T113 and T115 attestation boundaries', () => {
    for (const heading of [T113_ATTESTATION_HEADING, T115_ATTESTATION_HEADING]) {
      const mutated = documentation.replace(heading, `${heading} removed`);
      expect(validateReleaseVerificationDocument(mutated, workflow, packageVersion)).toContain(
        `missing section: ${heading}`
      );
    }
  });

  it('rejects a T113 contract that merges, weakens, or mislabels its two private lanes', () => {
    const section = markdownSection(documentation, T113_HEADING);
    expect(section).toBeDefined();
    for (const [target, expectedError] of [
      ['real-corpus lane', 'T113 private certification is missing real-corpus lane'],
      ['Store provably empty', 'T113 private certification is missing Store provably empty'],
      [
        'fictional-transaction lane',
        'T113 private certification is missing fictional-transaction lane',
      ],
      ['Both lanes must pass', 'T113 private certification is missing Both lanes must pass'],
      [
        'neither lane substitutes for the other',
        'T113 private certification is missing neither lane substitutes for the other',
      ],
      [
        '`t113-structure-coverage/v1`',
        'T113 private certification is missing `t113-structure-coverage/v1`',
      ],
      ['same selected set', 'T113 private certification is missing same selected set'],
      [
        'zero session/content mutations',
        'T113 private certification is missing zero session/content mutations',
      ],
      [
        '`sync_metadata` schema-version upsert',
        'T113 private certification is missing `sync_metadata` schema-version upsert',
      ],
    ] as const) {
      const mutatedSection = section!.split(target).join('removed contract phrase');
      const mutated = documentation.replace(section!, mutatedSection);
      expect(validateReleaseVerificationDocument(mutated, workflow, packageVersion)).toContain(
        expectedError
      );
    }
  });

  it('rejects drift in the finite T113 structure predicate registry', () => {
    const removedPredicate = documentation.replace(/^\| `type\.thinking-with-tool` \|.*\n/mu, '');
    expect(
      validateReleaseVerificationDocument(removedPredicate, workflow, packageVersion)
    ).toContain('T113 structure predicate registry does not match the locked v1 key order');

    const wrongRegistryCount = documentation.replace(
      'structure_registry_predicates: 41',
      'structure_registry_predicates: 40'
    );
    expect(
      validateReleaseVerificationDocument(wrongRegistryCount, workflow, packageVersion)
    ).toContain('T113 attestation structure_registry_predicates must equal 41');

    const duplicateMutant = documentation.replace(
      '`thinking-tool-hidden` |',
      '`error-tool-hidden` |'
    );
    expect(
      validateReleaseVerificationDocument(duplicateMutant, workflow, packageVersion)
    ).toContain('T113 structure predicate registry mutant names must be unique');
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

  it('rejects invalid content-mutation, bookkeeping, off-scope, poison, and residue evidence', () => {
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

    const wrongSelectionPolicy = documentation.replace(
      'selection_policy: t113-structure-coverage/v1',
      'selection_policy: full-corpus/v0'
    );
    expect(
      validateReleaseVerificationDocument(wrongSelectionPolicy, workflow, packageVersion)
    ).toContain('T113 attestation has the wrong selection policy');

    for (const field of [
      'real_sample_v016_repeat_session_content_mutations',
      'real_sample_candidate_repeat_session_content_mutations',
      'real_sample_v016_repeat_sync_metadata_value_changes',
      'real_sample_candidate_upgrade_sync_metadata_value_changes',
      'real_sample_candidate_repeat_sync_metadata_value_changes',
      'fictional_transaction_forced_failure_committed_session_content_mutations',
      'fictional_transaction_forced_failure_sync_metadata_value_changes',
      'fictional_transaction_retry_sync_metadata_value_changes',
      'fictional_transaction_final_repeat_session_content_mutations',
      'fictional_transaction_final_repeat_sync_metadata_value_changes',
      'fictional_transaction_real_values_derived',
      'structure_predicates_unmapped',
      'sample_projection_unselected_payload_records',
    ]) {
      const mutated = documentation.replace(`${field}: 0`, `${field}: 1`);
      expect(validateReleaseVerificationDocument(mutated, workflow, packageVersion)).toContain(
        `T113 attestation ${field} must equal 0`
      );
    }

    for (const field of [
      'real_sample_initial_import_sync_metadata_upserts',
      'real_sample_v016_repeat_sync_metadata_upserts',
      'real_sample_candidate_upgrade_sync_metadata_upserts',
      'real_sample_candidate_repeat_sync_metadata_upserts',
      'fictional_transaction_baseline_import_sync_metadata_upserts',
      'fictional_transaction_forced_failure_sync_metadata_upserts',
      'fictional_transaction_retry_sync_metadata_upserts',
      'fictional_transaction_final_repeat_sync_metadata_upserts',
    ]) {
      const mutated = documentation.replace(`${field}: 1`, `${field}: 0`);
      expect(validateReleaseVerificationDocument(mutated, workflow, packageVersion)).toContain(
        `T113 attestation ${field} must equal 1`
      );
    }

    for (const field of [
      'real_sample_initial_import_sync_metadata_value_changes',
      'fictional_transaction_baseline_import_sync_metadata_value_changes',
    ]) {
      const mutated = documentation.replace(`${field}: 1`, `${field}: 0`);
      expect(validateReleaseVerificationDocument(mutated, workflow, packageVersion)).toContain(
        `T113 attestation ${field} must equal 1`
      );
    }

    const unboundedSample = documentation.replace(
      'real_sample_count: [1..8]',
      'real_sample_count: [1..all]'
    );
    expect(
      validateReleaseVerificationDocument(unboundedSample, workflow, packageVersion)
    ).toContain('T113 attestation real_sample_count must declare the 1..8 bound');

    const t113Residue = documentation.replace(
      'temporary_residue_count: 0',
      'temporary_residue_count: 1'
    );
    expect(validateReleaseVerificationDocument(t113Residue, workflow, packageVersion)).toContain(
      'T113 attestation temporary_residue_count must equal 0'
    );
  });
});
