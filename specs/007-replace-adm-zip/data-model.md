# Data Model: Replace adm-zip with ESM-Compatible Alternative

**Feature**: 007-replace-adm-zip
**Date**: 2026-01-03

## Overview

This feature is a **dependency replacement** that does not introduce new data entities. The existing data model remains unchanged.

## Existing Entities (No Changes)

### BackupManifest
Unchanged - describes backup contents, file paths, checksums, and metadata.

### BackupArchive
Unchanged - ZIP file structure with manifest.json and database files.

### DatabaseFiles
Unchanged - SQLite files at `globalStorage/state.vscdb` and `workspaceStorage/{id}/state.vscdb`.

## API Impact

### Functions with Signature Changes

The following core functions change from synchronous to asynchronous due to jszip's Promise-based API:

| Function | Before | After |
|----------|--------|-------|
| `openBackupDatabase(backupPath, dbPath)` | `Database` | `Promise<Database>` |
| `readBackupManifest(backupPath)` | `BackupManifest \| null` | `Promise<BackupManifest \| null>` |
| `validateBackup(backupPath)` | `BackupValidation` | `Promise<BackupValidation>` |
| `restoreBackup(config)` | `RestoreResult` | `Promise<RestoreResult>` |
| `listBackups(directory?)` | `BackupInfo[]` | `Promise<BackupInfo[]>` |

### Library API Updates

The library wrappers in `src/lib/backup.ts` must be updated to match:

```typescript
// These become async
export async function restoreBackup(config): Promise<RestoreResult>
export async function validateBackup(path): Promise<BackupValidation>
export async function listBackups(dir?): Promise<BackupInfo[]>
```

## State Transitions

No changes - backup/restore lifecycle remains the same.

## Data Flow

No changes - the same data flows through the system, just processed asynchronously.
