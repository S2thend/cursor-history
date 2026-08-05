#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..');
export const POLICY_VERSION = 'source-read-limits/v1';
export const POLICY_FINGERPRINT =
  'b130f4fb03e3ef04f0f01527585ee939df0243e8105a44f6a23fe6d15c9f9108';

export const POLICY_ARTIFACTS = Object.freeze([
  'specs/016-harden-session-integrity/spec.md',
  'specs/016-harden-session-integrity/research.md',
  'specs/016-harden-session-integrity/data-model.md',
  'specs/016-harden-session-integrity/contracts/internal-resolution.md',
  'specs/016-harden-session-integrity/contracts/library-api.md',
  'specs/016-harden-session-integrity/contracts/cli-json.md',
  'specs/016-harden-session-integrity/quickstart.md',
  'specs/016-harden-session-integrity/tasks.md',
  'docs/compatibility.md',
]);

const POLICY_FIELDS = Object.freeze([
  'jsonlRecordBytes',
  'jsonlSourceBytes',
  'jsonlRecordCount',
  'sqlitePageRows',
  'sqlitePageBytes',
  'sqliteValueBytes',
  'sqliteRowCount',
  'sqliteDecodedBytes',
  'zipCompressedBytes',
  'zipEntryCount',
  'zipEntryBytes',
  'zipAggregateBytes',
  'zipCompressionRatio',
]);

const POLICY_MARKER_PREFIX = `<!-- ${POLICY_VERSION} policy-sha256:`;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_EOCD_SEARCH = UINT16_MAX + 22;

function normalizedPolicyJson(policy) {
  const ordered = { policyVersion: policy.policyVersion };
  for (const field of POLICY_FIELDS) ordered[field] = policy[field];
  return JSON.stringify(ordered);
}

export function fingerprintPolicy(policy) {
  return createHash('sha256').update(normalizedPolicyJson(policy)).digest('hex');
}

function parseNumericLiteral(text) {
  return Number(text.replaceAll('_', ''));
}

export function readSourcePolicy(repositoryRoot = REPOSITORY_ROOT) {
  const sourcePath = join(repositoryRoot, 'src/core/source-read-limits.ts');
  const source = readFileSync(sourcePath, 'utf8');
  const policy = { policyVersion: POLICY_VERSION };
  for (const field of POLICY_FIELDS) {
    const match = new RegExp(`\\b${field}:\\s*([0-9][0-9_]*)[,\\n]`, 'u').exec(source);
    if (!match) throw new Error(`Policy field ${field} is missing from ${sourcePath}`);
    const value = parseNumericLiteral(match[1]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Policy field ${field} is not a positive safe integer`);
    }
    policy[field] = value;
  }
  return Object.freeze(policy);
}

export function checkPolicyArtifacts(repositoryRoot = REPOSITORY_ROOT) {
  const policy = readSourcePolicy(repositoryRoot);
  const fingerprint = fingerprintPolicy(policy);
  if (fingerprint !== POLICY_FINGERPRINT) {
    throw new Error(
      `Source Read Limits policy drift: implementation=${fingerprint}, locked=${POLICY_FINGERPRINT}`
    );
  }
  const expectedMarker = `${POLICY_MARKER_PREFIX} ${fingerprint} -->`;
  for (const relativePath of POLICY_ARTIFACTS) {
    const path = join(repositoryRoot, relativePath);
    const content = readFileSync(path, 'utf8');
    if (!content.includes(expectedMarker)) {
      throw new Error(`Source Read Limits policy marker drift in ${relativePath}`);
    }
  }
  return { policy, fingerprint, artifacts: [...POLICY_ARTIFACTS] };
}

function safeNumber(value, label) {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe integers`);
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function safeSignedInteger(value, label) {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`${label} exceeds safe integers`);
    }
    return Number(value);
  }
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is invalid`);
  return value;
}

function readExactly(descriptor, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const bytes = readSync(descriptor, buffer, offset, length - offset, position + offset);
    if (bytes === 0) throw new Error('Unexpected end of ZIP metadata');
    offset += bytes;
  }
  return buffer;
}

function readUInt64LE(buffer, offset, label) {
  return safeNumber(buffer.readBigUInt64LE(offset), label);
}

function findEocd(descriptor, fileSize) {
  const searchLength = Math.min(fileSize, MAX_EOCD_SEARCH);
  const start = fileSize - searchLength;
  const tail = readExactly(descriptor, searchLength, start);
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + 22 + commentLength === tail.length) return { tail, index, offset: start + index };
  }
  throw new Error('Backup ZIP has no valid end-of-central-directory record');
}

function readCentralLocation(descriptor, fileSize) {
  const { tail, index, offset } = findEocd(descriptor, fileSize);
  const disk = tail.readUInt16LE(index + 4);
  const centralDisk = tail.readUInt16LE(index + 6);
  if (disk !== 0 || centralDisk !== 0) throw new Error('Multi-disk ZIP archives are unsupported');
  let entryCount = tail.readUInt16LE(index + 10);
  let centralSize = tail.readUInt32LE(index + 12);
  let centralOffset = tail.readUInt32LE(index + 16);
  if (entryCount !== UINT16_MAX && centralSize !== UINT32_MAX && centralOffset !== UINT32_MAX) {
    return { entryCount, centralSize, centralOffset };
  }
  if (offset < 20) throw new Error('ZIP64 locator is missing');
  const locator = readExactly(descriptor, 20, offset - 20);
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) {
    throw new Error('ZIP64 locator is invalid');
  }
  if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
    throw new Error('Multi-disk ZIP64 archives are unsupported');
  }
  const zip64Offset = readUInt64LE(locator, 8, 'ZIP64 end record offset');
  const zip64 = readExactly(descriptor, 56, zip64Offset);
  if (zip64.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
    throw new Error('ZIP64 end-of-central-directory record is invalid');
  }
  entryCount = readUInt64LE(zip64, 32, 'ZIP64 entry count');
  centralSize = readUInt64LE(zip64, 40, 'ZIP64 central size');
  centralOffset = readUInt64LE(zip64, 48, 'ZIP64 central offset');
  return { entryCount, centralSize, centralOffset };
}

function zip64Sizes(extra, compressed32, uncompressed32) {
  let compressed = compressed32;
  let uncompressed = uncompressed32;
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const end = offset + 4 + size;
    if (end > extra.length) throw new Error('Malformed ZIP extra field');
    if (id === 0x0001) {
      let cursor = offset + 4;
      if (uncompressed32 === UINT32_MAX) {
        if (cursor + 8 > end) throw new Error('ZIP64 uncompressed size is missing');
        uncompressed = readUInt64LE(extra, cursor, 'ZIP64 entry size');
        cursor += 8;
      }
      if (compressed32 === UINT32_MAX) {
        if (cursor + 8 > end) throw new Error('ZIP64 compressed size is missing');
        compressed = readUInt64LE(extra, cursor, 'ZIP64 compressed size');
      }
      break;
    }
    offset = end;
  }
  if (compressed === UINT32_MAX || uncompressed === UINT32_MAX) {
    throw new Error('ZIP64 entry sizes are missing');
  }
  return { compressed, uncompressed };
}

export function preflightBackupArchive(path) {
  const descriptor = openSync(path, 'r');
  try {
    const fileSize = safeNumber(fstatSync(descriptor).size, 'archive size');
    const location = readCentralLocation(descriptor, fileSize);
    if (location.centralOffset + location.centralSize > fileSize) {
      throw new Error('ZIP central directory is outside the archive');
    }
    let cursor = location.centralOffset;
    let totalCompressed = 0;
    let totalUncompressed = 0;
    let maxEntryBytes = 0;
    let maxEntryRatio = 0;
    let infiniteRatio = false;
    let hasManifest = false;
    let hasComposerDatabase = false;
    for (let index = 0; index < location.entryCount; index += 1) {
      const fixed = readExactly(descriptor, 46, cursor);
      if (fixed.readUInt32LE(0) !== CENTRAL_SIGNATURE) {
        throw new Error(`Invalid central record at index ${index}`);
      }
      const compressed32 = fixed.readUInt32LE(20);
      const uncompressed32 = fixed.readUInt32LE(24);
      const nameLength = fixed.readUInt16LE(28);
      const extraLength = fixed.readUInt16LE(30);
      const commentLength = fixed.readUInt16LE(32);
      const variable = readExactly(descriptor, nameLength + extraLength, cursor + 46);
      const name = variable.subarray(0, nameLength).toString('utf8');
      const extra = variable.subarray(nameLength);
      const sizes = zip64Sizes(extra, compressed32, uncompressed32);
      totalCompressed += sizes.compressed;
      totalUncompressed += sizes.uncompressed;
      if (!Number.isSafeInteger(totalCompressed) || !Number.isSafeInteger(totalUncompressed)) {
        throw new Error('ZIP aggregate size exceeds safe integers');
      }
      maxEntryBytes = Math.max(maxEntryBytes, sizes.uncompressed);
      if (sizes.uncompressed > 0 && sizes.compressed === 0) infiniteRatio = true;
      else if (sizes.uncompressed > 0) {
        maxEntryRatio = Math.max(maxEntryRatio, sizes.uncompressed / sizes.compressed);
      }
      hasManifest ||= name === 'manifest.json';
      hasComposerDatabase ||=
        name === 'globalStorage/state.vscdb' ||
        /^workspaceStorage\/[^/]+\/state\.vscdb$/u.test(name);
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    if (cursor !== location.centralOffset + location.centralSize) {
      throw new Error('ZIP central-directory size does not match its records');
    }
    if (!hasManifest || !hasComposerDatabase) {
      throw new Error('Archive is not a cursor-history Composer backup carrier');
    }
    const aggregateRatio =
      totalUncompressed === 0
        ? 0
        : totalCompressed === 0
          ? Number.POSITIVE_INFINITY
          : totalUncompressed / totalCompressed;
    return {
      zipCompressedBytes: fileSize,
      zipEntryCount: location.entryCount,
      zipEntryBytes: maxEntryBytes,
      zipAggregateBytes: totalUncompressed,
      zipCompressionRatio: Math.max(maxEntryRatio, aggregateRatio),
      zipCompressionRatioInfinite: infiniteRatio || !Number.isFinite(aggregateRatio),
    };
  } finally {
    closeSync(descriptor);
  }
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function openReadonlyDatabase(path) {
  const imported = await import('better-sqlite3');
  const Database = imported.default;
  return new Database(path, { readonly: true, fileMustExist: true });
}

export async function preflightComposerDatabase(path, pageRows) {
  const db = await openReadonlyDatabase(path);
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ItemTable', 'cursorDiskKV') ORDER BY name"
      )
      .all()
      .map((row) => row.name);
    if (tables.length === 0)
      throw new Error('SQLite input is not a recognized Cursor Composer database');
    let maxPageRows = 0;
    let maxPageBytes = 0;
    let maxValueBytes = 0;
    let rowCount = 0;
    let decodedBytes = 0;
    for (const table of tables) {
      const quoted = quoteIdentifier(table);
      const page = db.prepare(
        `SELECT rowid AS rowId, length(CAST(value AS BLOB)) AS valueBytes FROM ${quoted} WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`
      );
      let lastRowId = Number.MIN_SAFE_INTEGER;
      while (true) {
        const rows = page.all(lastRowId, pageRows);
        if (rows.length === 0) break;
        let pageBytes = 0;
        for (const row of rows) {
          const bytes =
            row.valueBytes === null ? 0 : safeNumber(row.valueBytes, 'SQLite value length');
          pageBytes += bytes;
          decodedBytes += bytes;
          rowCount += 1;
          maxValueBytes = Math.max(maxValueBytes, bytes);
          lastRowId = safeSignedInteger(row.rowId, 'SQLite rowid');
        }
        if (!Number.isSafeInteger(pageBytes) || !Number.isSafeInteger(decodedBytes)) {
          throw new Error('SQLite aggregate size exceeds safe integers');
        }
        maxPageRows = Math.max(maxPageRows, rows.length);
        maxPageBytes = Math.max(maxPageBytes, pageBytes);
      }
    }
    return {
      sqlitePageRows: maxPageRows,
      sqlitePageBytes: maxPageBytes,
      sqliteValueBytes: maxValueBytes,
      sqliteRowCount: rowCount,
      sqliteDecodedBytes: decodedBytes,
    };
  } finally {
    db.close();
  }
}

function collectComposerDatabases(inputPath) {
  const path = resolve(inputPath);
  if (!existsSync(path)) throw new Error(`Composer input does not exist: ${inputPath}`);
  if (lstatSync(path).isSymbolicLink()) throw new Error('Composer input must not be a symlink');
  if (statSync(path).isFile()) {
    if (extname(path) !== '.vscdb') throw new Error('Composer database must use the .vscdb suffix');
    return [path];
  }
  const candidates = new Set();
  const directGlobal = join(path, 'globalStorage', 'state.vscdb');
  const siblingGlobal = join(dirname(path), 'globalStorage', 'state.vscdb');
  for (const candidate of [directGlobal, siblingGlobal]) {
    if (existsSync(candidate) && statSync(candidate).isFile())
      candidates.add(realpathSync(candidate));
  }
  const workspaceRoots = [join(path, 'workspaceStorage'), path];
  for (const workspaceRoot of workspaceRoots) {
    if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) continue;
    for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = join(workspaceRoot, entry.name, 'state.vscdb');
      if (existsSync(candidate) && statSync(candidate).isFile())
        candidates.add(realpathSync(candidate));
    }
  }
  if (candidates.size === 0)
    throw new Error('No recognized Composer state.vscdb inputs were found');
  return [...candidates].sort();
}

function maxInto(target, observation) {
  for (const [field, value] of Object.entries(observation)) {
    if (field.endsWith('Infinite')) continue;
    target[field] = Math.max(target[field] ?? 0, value);
  }
  if (observation.zipCompressionRatioInfinite) target.zipCompressionRatioInfinite = true;
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function assertPrivateOutput(outputPath, repositoryRoot) {
  const resolvedOutput = resolve(outputPath);
  if (isInside(realpathSync(repositoryRoot), resolvedOutput)) {
    throw new Error('Preflight evidence must be written outside the repository');
  }
  const parent = dirname(resolvedOutput);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && (statSync(parent).mode & 0o077) !== 0) {
    throw new Error('Preflight evidence parent must be owner-private (mode 0700)');
  }
  return resolvedOutput;
}

export async function runPreflight({
  composerRoots = [],
  backups = [],
  output,
  repositoryRoot = REPOSITORY_ROOT,
}) {
  const { policy, fingerprint } = checkPolicyArtifacts(repositoryRoot);
  if (composerRoots.length === 0 && backups.length === 0) {
    throw new Error(
      'At least one authorized Composer root/database or cursor-history backup is required'
    );
  }
  const observations = Object.fromEntries(POLICY_FIELDS.map((field) => [field, 0]));
  const composerDatabases = new Set();
  for (const root of composerRoots) {
    for (const path of collectComposerDatabases(root)) {
      composerDatabases.add(realpathSync(path));
    }
  }
  for (const path of [...composerDatabases].sort()) {
    maxInto(observations, await preflightComposerDatabase(path, policy.sqlitePageRows));
  }
  const backupArchives = new Set(backups.map((path) => realpathSync(resolve(path))));
  for (const path of [...backupArchives].sort()) {
    if (extname(path).toLowerCase() !== '.zip') {
      throw new Error('Only cursor-history backup ZIP carriers are accepted by --backup');
    }
    maxInto(observations, preflightBackupArchive(path));
  }
  const exceeded = POLICY_FIELDS.filter((field) => {
    if (field === 'zipCompressionRatio' && observations.zipCompressionRatioInfinite) return true;
    return observations[field] > policy[field];
  });
  const maxima = Object.fromEntries(POLICY_FIELDS.map((field) => [field, observations[field]]));
  if (observations.zipCompressionRatioInfinite) maxima.zipCompressionRatio = null;
  const evidence = {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    policyFingerprint: fingerprint,
    carrierCounts: {
      composerDatabases: composerDatabases.size,
      backupArchives: backupArchives.size,
    },
    maxima,
    ...(observations.zipCompressionRatioInfinite ? { zipCompressionRatioInfinite: true } : {}),
    exceeded,
    withinDefaults: exceeded.length === 0,
  };
  const outputPath = assertPrivateOutput(output, repositoryRoot);
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(outputPath, 0o600);
  return { evidence, outputPath };
}

function parseArguments(argv) {
  const composerRoots = [];
  const backups = [];
  let output;
  let checkPolicyOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--composer-root' || arg === '--composer-db') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a path`);
      composerRoots.push(value);
    } else if (arg === '--backup') {
      const value = argv[++index];
      if (!value) throw new Error('--backup requires a path');
      backups.push(value);
    } else if (arg === '--output') {
      output = argv[++index];
      if (!output) throw new Error('--output requires a path');
    } else if (arg === '--check-policy') {
      checkPolicyOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { composerRoots, backups, output, checkPolicyOnly };
}

function printHelp() {
  process.stdout.write(
    [
      'Usage:',
      '  node scripts/preflight-source-limits.mjs --check-policy',
      '  node scripts/preflight-source-limits.mjs [--composer-root PATH ...] [--backup FILE.zip ...] --output PRIVATE.json',
      '',
      'Inputs must be maintainer-authorized Cursor Composer carriers readable by cursor-history v0.16.',
      'Never pass a downstream vibe-history database/archive. Evidence is aggregate-only and must be outside the repository.',
      '',
    ].join('\n')
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.checkPolicyOnly) {
    const result = checkPolicyArtifacts();
    process.stdout.write(
      `${JSON.stringify({ policyVersion: POLICY_VERSION, policyFingerprint: result.fingerprint })}\n`
    );
    return;
  }
  if (!options.output) throw new Error('--output is required for carrier preflight');
  const { evidence } = await runPreflight(options);
  process.stdout.write(
    `${JSON.stringify({ policyVersion: POLICY_VERSION, withinDefaults: evidence.withinDefaults, exceeded: evidence.exceeded })}\n`
  );
  if (!evidence.withinDefaults) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
