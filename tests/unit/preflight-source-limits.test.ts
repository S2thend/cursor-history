import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import JSZip from 'jszip';

import {
  POLICY_ARTIFACT_SHA256,
  POLICY_ARTIFACTS,
  POLICY_FINGERPRINT,
  REPOSITORY_ROOT,
  checkPolicyArtifacts,
  preflightBackupArchive,
  preflightComposerDatabase,
  readSourcePolicy,
  runPreflight,
  validatePolicyArtifactInventory,
} from '../../scripts/preflight-source-limits.mjs';

const roots: string[] = [];

function privateRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  if (process.platform !== 'win32') chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function createComposerDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const item = db.prepare('INSERT INTO ItemTable(key, value) VALUES (?, ?)');
    db.prepare('INSERT INTO ItemTable(rowid, key, value) VALUES (?, ?, ?)').run(
      -7,
      'negative-rowid-fixture',
      Buffer.alloc(5, 0x40)
    );
    item.run('composer.composerData', Buffer.alloc(11, 0x41));
    item.run('workbench.panel.aichat.view.aichat.chatdata', '测试!');
    const global = db.prepare('INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)');
    global.run('composerData:00000000-0000-4000-8000-000000000001', Buffer.alloc(13, 0x43));
    global.run('bubbleId:00000000-0000-4000-8000-000000000001:b1', Buffer.alloc(17, 0x44));
  } finally {
    db.close();
  }
}

async function createBackup(
  path: string,
  databaseBytes = Buffer.from('synthetic-db')
): Promise<void> {
  const zip = new JSZip();
  zip.file(
    'manifest.json',
    JSON.stringify({ version: '1.0.0', createdAt: '2024-01-01T00:00:00.000Z', files: [] })
  );
  zip.file('globalStorage/state.vscdb', databaseBytes);
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), {
    mode: 0o600,
  });
}

function copyPolicyRepository(): string {
  const root = privateRoot('cursor-history-policy-copy-');
  const source = join(REPOSITORY_ROOT, 'src/core/source-read-limits.ts');
  const target = join(root, 'src/core/source-read-limits.ts');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  for (const artifact of POLICY_ARTIFACTS) {
    const destination = join(root, artifact);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(join(REPOSITORY_ROOT, artifact), destination);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Source Read Limits v1 policy lock', () => {
  it('matches the implementation and every required normative or shipped artifact', () => {
    const result = checkPolicyArtifacts();
    expect(result.fingerprint).toBe(POLICY_FINGERPRINT);
    expect(result.policy).toEqual(readSourcePolicy());
    expect(result.artifacts).toEqual(POLICY_ARTIFACTS);
    expect(Object.keys(POLICY_ARTIFACT_SHA256)).toEqual(POLICY_ARTIFACTS);
    expect(validatePolicyArtifactInventory()).toEqual(POLICY_ARTIFACTS);
    for (const [relativePath, expectedHash] of Object.entries(POLICY_ARTIFACT_SHA256)) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(REPOSITORY_ROOT, relativePath)))
          .digest('hex')
      ).toBe(expectedHash);
    }
  });

  it('fails when an implementation default or implementation policy version drifts', () => {
    const implementationMutation = copyPolicyRepository();
    const sourcePath = join(implementationMutation, 'src/core/source-read-limits.ts');
    writeFileSync(
      sourcePath,
      readFileSync(sourcePath, 'utf8').replace(
        'jsonlRecordBytes: 67_108_864',
        'jsonlRecordBytes: 67_108_865'
      )
    );
    expect(() => checkPolicyArtifacts(implementationMutation)).toThrow(/implementation=.*locked=/u);

    const versionMutation = copyPolicyRepository();
    const versionSourcePath = join(versionMutation, 'src/core/source-read-limits.ts');
    writeFileSync(
      versionSourcePath,
      readFileSync(versionSourcePath, 'utf8').replace(
        "policyVersion: 'source-read-limits/v1'",
        "policyVersion: 'source-read-limits/v2'"
      )
    );
    expect(readSourcePolicy(versionMutation).policyVersion).toBe('source-read-limits/v2');
    expect(() => checkPolicyArtifacts(versionMutation)).toThrow(/implementation=.*locked=/u);
  });

  it('fails when artifact content drifts even if its embedded policy marker remains intact', () => {
    const artifactMutation = copyPolicyRepository();
    const artifactPath = join(artifactMutation, POLICY_ARTIFACTS[0]!);
    writeFileSync(
      artifactPath,
      `${readFileSync(artifactPath, 'utf8')}\n<!-- non-policy content drift -->\n`
    );
    expect(readFileSync(artifactPath, 'utf8')).toContain(POLICY_FINGERPRINT);
    expect(() => checkPolicyArtifacts(artifactMutation)).toThrow(/artifact content drift/u);
  });

  it('rejects spread tokens in the defaults object and deletion from the literal artifact inventory', () => {
    const spreadMutation = copyPolicyRepository();
    const sourcePath = join(spreadMutation, 'src/core/source-read-limits.ts');
    writeFileSync(
      sourcePath,
      readFileSync(sourcePath, 'utf8').replace(
        "  policyVersion: 'source-read-limits/v1',",
        "  ...spreadOverride,\n  policyVersion: 'source-read-limits/v1',"
      )
    );
    expect(() => readSourcePolicy(spreadMutation)).toThrow(/exactly 14 canonical declarations/u);

    expect(() =>
      validatePolicyArtifactInventory(POLICY_ARTIFACTS.slice(0, -1), POLICY_ARTIFACT_SHA256)
    ).toThrow(/artifact inventory drift/u);
  });
});

describe('metadata-only carrier measurements', () => {
  it('measures SQLite row/value/page aggregates without returning keys or payload bytes', async () => {
    const root = privateRoot('cursor-history-preflight-sqlite-');
    const databasePath = join(root, 'state.vscdb');
    createComposerDatabase(databasePath);

    const result = await preflightComposerDatabase(databasePath, 2);

    expect(result).toEqual({
      sqlitePageRows: 2,
      sqlitePageBytes: 30,
      sqliteValueBytes: 17,
      sqliteRowCount: 5,
      sqliteDecodedBytes: 53,
    });
    expect(JSON.stringify(result)).not.toContain('composerData');
    expect(JSON.stringify(result)).not.toContain('00000000');
  });

  it('rejects a downstream-shaped SQLite database instead of treating it as Composer input', async () => {
    const root = privateRoot('cursor-history-preflight-downstream-');
    const databasePath = join(root, 'vibe-history.sqlite');
    const db = new Database(databasePath);
    db.exec('CREATE TABLE sessions (id TEXT); CREATE TABLE messages (id TEXT, content TEXT)');
    db.close();

    await expect(preflightComposerDatabase(databasePath, 256)).rejects.toThrow(
      /not a recognized Cursor Composer database/u
    );
  });

  it('reads only central metadata from a cursor-history backup and rejects unrelated ZIPs', async () => {
    const root = privateRoot('cursor-history-preflight-zip-');
    const backupPath = join(root, 'backup.zip');
    await createBackup(backupPath, Buffer.alloc(1_024, 0x61));

    const result = preflightBackupArchive(backupPath);
    // JSZip records the globalStorage directory as an explicit central entry.
    expect(result.zipEntryCount).toBe(3);
    expect(result.zipEntryBytes).toBe(1_024);
    expect(result.zipAggregateBytes).toBeGreaterThan(1_024);
    expect(result.zipCompressedBytes).toBe(statSync(backupPath).size);
    expect(result.zipCompressionRatio).toBeGreaterThan(1);

    const unrelated = join(root, 'unrelated.zip');
    const zip = new JSZip();
    zip.file('messages.sqlite', 'downstream');
    writeFileSync(unrelated, await zip.generateAsync({ type: 'nodebuffer' }));
    expect(() => preflightBackupArchive(unrelated)).toThrow(
      /not a cursor-history Composer backup/u
    );
  });
});

describe('aggregate evidence boundary', () => {
  it('writes only aggregate maxima to a new owner-private file outside the repository', async () => {
    const root = privateRoot('cursor-history-preflight-run-');
    const cursorRoot = join(root, 'Cursor', 'User');
    const databasePath = join(cursorRoot, 'globalStorage', 'state.vscdb');
    createComposerDatabase(databasePath);
    const backupPath = join(root, 'backup.zip');
    await createBackup(backupPath);
    const evidencePath = join(root, 'evidence', 'aggregate.json');
    mkdirSync(dirname(evidencePath), { mode: 0o700 });

    const { evidence, outputPath } = await runPreflight({
      composerRoots: [cursorRoot, cursorRoot],
      backups: [backupPath, backupPath],
      output: evidencePath,
    });

    expect(outputPath).toBe(evidencePath);
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      policyFingerprint: POLICY_FINGERPRINT,
      carrierCounts: { composerDatabases: 1, backupArchives: 1 },
      withinDefaults: true,
      exceeded: [],
    });
    const bytes = readFileSync(evidencePath, 'utf8');
    expect(bytes).not.toContain(cursorRoot);
    expect(bytes).not.toContain(backupPath);
    expect(bytes).not.toContain('composerData:');
    if (process.platform !== 'win32') expect(statSync(evidencePath).mode & 0o777).toBe(0o600);
  });

  it('rejects repository evidence paths and symlinked Composer inputs before scanning', async () => {
    const root = privateRoot('cursor-history-preflight-reject-');
    const databasePath = join(root, 'state.vscdb');
    createComposerDatabase(databasePath);
    const link = join(root, 'linked.vscdb');
    symlinkSync(databasePath, link, 'file');

    await expect(
      runPreflight({ composerRoots: [link], output: join(root, 'symlink-evidence.json') })
    ).rejects.toThrow(/must not be a symlink/u);
    await expect(
      runPreflight({
        composerRoots: [databasePath],
        output: join(REPOSITORY_ROOT, '.source-limit-evidence-forbidden.json'),
      })
    ).rejects.toThrow(/outside the repository/u);
    expect(existsSync(join(REPOSITORY_ROOT, '.source-limit-evidence-forbidden.json'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects canonical repository escapes and never overwrites an existing evidence file',
    async () => {
      const root = privateRoot('cursor-history-preflight-output-security-');
      const policyRepository = copyPolicyRepository();
      const databasePath = join(root, 'state.vscdb');
      createComposerDatabase(databasePath);

      const repositoryLink = join(root, 'repository-link');
      symlinkSync(policyRepository, repositoryLink, 'dir');
      const escapedOutput = join(repositoryLink, 'specs', 'evidence.json');
      await expect(
        runPreflight({
          composerRoots: [databasePath],
          output: escapedOutput,
          repositoryRoot: policyRepository,
        })
      ).rejects.toThrow(/outside the repository/u);
      expect(existsSync(join(policyRepository, 'specs', 'evidence.json'))).toBe(false);

      const missingRepositoryChild = join(policyRepository, 'missing-evidence-parent');
      expect(existsSync(missingRepositoryChild)).toBe(false);
      await expect(
        runPreflight({
          composerRoots: [databasePath],
          output: join(repositoryLink, 'missing-evidence-parent', 'evidence.json'),
          repositoryRoot: policyRepository,
        })
      ).rejects.toThrow(/parent must already exist/u);
      expect(existsSync(missingRepositoryChild)).toBe(false);

      const privateTarget = join(root, 'private-target');
      mkdirSync(privateTarget, { mode: 0o700 });
      const parentLink = join(root, 'linked-parent');
      symlinkSync(privateTarget, parentLink, 'dir');
      await expect(
        runPreflight({
          composerRoots: [databasePath],
          output: join(parentLink, 'evidence.json'),
        })
      ).rejects.toThrow(/parent must not be a symlink/u);
      expect(existsSync(join(privateTarget, 'evidence.json'))).toBe(false);

      const existingOutput = join(root, 'existing-evidence.json');
      writeFileSync(existingOutput, 'do-not-overwrite', { mode: 0o600 });
      await expect(
        runPreflight({ composerRoots: [databasePath], output: existingOutput })
      ).rejects.toThrow(/EEXIST|file already exists/u);
      expect(readFileSync(existingOutput, 'utf8')).toBe('do-not-overwrite');
    }
  );
});

describe('authorized Composer carrier discovery', () => {
  it('accepts documented User roots with only global data and workspaceStorage roots with only workspace data', async () => {
    const root = privateRoot('cursor-history-preflight-carriers-');

    const globalUserRoot = join(root, 'global-only', 'Cursor', 'User');
    createComposerDatabase(join(globalUserRoot, 'globalStorage', 'state.vscdb'));
    const globalResult = await runPreflight({
      composerRoots: [globalUserRoot],
      output: join(root, 'global-only-evidence.json'),
    });
    expect(globalResult.evidence.carrierCounts.composerDatabases).toBe(1);

    const workspaceRoot = join(root, 'workspace-only', 'User', 'workspaceStorage');
    createComposerDatabase(join(workspaceRoot, 'fictional-workspace', 'state.vscdb'));
    const workspaceResult = await runPreflight({
      composerRoots: [workspaceRoot],
      output: join(root, 'workspace-only-evidence.json'),
    });
    expect(workspaceResult.evidence.carrierCounts.composerDatabases).toBe(1);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects nested global database and global or workspace container symlinks before opening them',
    async () => {
      const root = privateRoot('cursor-history-preflight-carrier-symlinks-');

      const globalUserRoot = join(root, 'global-case', 'Cursor', 'User');
      const outsideGlobal = join(root, 'outside-global.vscdb');
      createComposerDatabase(outsideGlobal);
      mkdirSync(join(globalUserRoot, 'globalStorage'), { recursive: true, mode: 0o700 });
      symlinkSync(outsideGlobal, join(globalUserRoot, 'globalStorage', 'state.vscdb'), 'file');
      await expect(
        runPreflight({
          composerRoots: [globalUserRoot],
          output: join(root, 'global-symlink-evidence.json'),
        })
      ).rejects.toThrow(/globalStorage\/state\.vscdb must not be a symlink/u);

      const globalContainerUserRoot = join(root, 'global-container-case', 'Cursor', 'User');
      const outsideGlobalContainer = join(root, 'outside-global-container');
      createComposerDatabase(join(outsideGlobalContainer, 'state.vscdb'));
      mkdirSync(globalContainerUserRoot, { recursive: true, mode: 0o700 });
      symlinkSync(outsideGlobalContainer, join(globalContainerUserRoot, 'globalStorage'), 'dir');
      await expect(
        runPreflight({
          composerRoots: [globalContainerUserRoot],
          output: join(root, 'global-container-symlink-evidence.json'),
        })
      ).rejects.toThrow(/globalStorage must not be a symlink/u);

      const workspaceContainerUserRoot = join(root, 'workspace-container-case', 'Cursor', 'User');
      const outsideWorkspaceContainer = join(root, 'outside-workspace-container');
      createComposerDatabase(join(outsideWorkspaceContainer, 'fictional-workspace', 'state.vscdb'));
      mkdirSync(workspaceContainerUserRoot, { recursive: true, mode: 0o700 });
      symlinkSync(
        outsideWorkspaceContainer,
        join(workspaceContainerUserRoot, 'workspaceStorage'),
        'dir'
      );
      await expect(
        runPreflight({
          composerRoots: [workspaceContainerUserRoot],
          output: join(root, 'workspace-container-symlink-evidence.json'),
        })
      ).rejects.toThrow(/workspaceStorage must not be a symlink/u);

      const workspaceRoot = join(root, 'workspace-case', 'User', 'workspaceStorage');
      const outsideWorkspace = join(root, 'outside-workspace');
      createComposerDatabase(join(outsideWorkspace, 'state.vscdb'));
      mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
      symlinkSync(outsideWorkspace, join(workspaceRoot, 'fictional-workspace'), 'dir');
      await expect(
        runPreflight({
          composerRoots: [workspaceRoot],
          output: join(root, 'workspace-symlink-evidence.json'),
        })
      ).rejects.toThrow(/workspaceStorage entries must not be symlinks/u);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a workspace state database symlink before opening it',
    async () => {
      const root = privateRoot('cursor-history-preflight-workspace-db-symlink-');
      const workspaceRoot = join(root, 'User', 'workspaceStorage');
      const workspaceInstance = join(workspaceRoot, 'fictional-workspace');
      const outsideDatabase = join(root, 'outside-workspace.vscdb');
      createComposerDatabase(outsideDatabase);
      mkdirSync(workspaceInstance, { recursive: true, mode: 0o700 });
      symlinkSync(outsideDatabase, join(workspaceInstance, 'state.vscdb'), 'file');

      await expect(
        runPreflight({
          composerRoots: [workspaceRoot],
          output: join(root, 'workspace-db-symlink-evidence.json'),
        })
      ).rejects.toThrow(
        /workspaceStorage\/fictional-workspace\/state\.vscdb must not be a symlink/u
      );
    }
  );
});
