# Quickstart: Replace adm-zip with jszip

This guide covers the implementation of feature 007-replace-adm-zip.

## Prerequisites

- Node.js 20 LTS or higher
- npm or pnpm

## Step 1: Update Dependencies

```bash
# Remove adm-zip
npm uninstall adm-zip @types/adm-zip

# Install jszip
npm install jszip
```

## Step 2: Update Imports

Replace in affected files:

```typescript
// Before
import AdmZip from 'adm-zip';

// After
import JSZip from 'jszip';
import { readFile, writeFile } from 'node:fs/promises';
```

## Step 3: Key API Patterns

### Creating a zip archive

```typescript
// Before (adm-zip)
const zip = new AdmZip();
zip.addLocalFile('/path/to/file.txt', 'dir/', 'file.txt');
zip.addFile('manifest.json', Buffer.from(JSON.stringify(data)));
zip.writeZip('/path/to/output.zip');

// After (jszip)
const zip = new JSZip();
const fileContent = await readFile('/path/to/file.txt');
zip.file('dir/file.txt', fileContent);
zip.file('manifest.json', JSON.stringify(data));
const content = await zip.generateAsync({ type: 'nodebuffer' });
await writeFile('/path/to/output.zip', content);
```

### Reading from a zip archive

```typescript
// Before (adm-zip)
const zip = new AdmZip('/path/to/archive.zip');
const buffer = zip.readFile('manifest.json');

// After (jszip)
const data = await readFile('/path/to/archive.zip');
const zip = await JSZip.loadAsync(data);
const buffer = await zip.file('manifest.json')?.async('nodebuffer');
```

### Iterating files

```typescript
// Before (adm-zip)
const zip = new AdmZip('/path/to/archive.zip');
const entries = zip.getEntries();
for (const entry of entries) {
  console.log(entry.entryName);
}

// After (jszip)
const data = await readFile('/path/to/archive.zip');
const zip = await JSZip.loadAsync(data);
zip.forEach((relativePath, file) => {
  console.log(relativePath);
});
```

## Step 4: Function Signature Changes

Several functions must change from sync to async:

| Function | Before | After |
|----------|--------|-------|
| `openBackupDatabase()` | `function` | `async function` |
| `readBackupManifest()` | `function` | `async function` |
| `validateBackup()` | `function` | `async function` |
| `restoreBackup()` | `function` | `async function` |
| `listBackups()` | `function` | `async function` |

Update all callers to use `await`.

## Step 5: Library API Updates

Update `src/lib/backup.ts` to make the wrapper functions async:

```typescript
// Before
export function restoreBackup(config: RestoreConfig): RestoreResult {
  return coreRestoreBackup(config);
}

// After
export async function restoreBackup(config: RestoreConfig): Promise<RestoreResult> {
  return coreRestoreBackup(config);
}
```

## Step 6: Testing

1. Build the project:
   ```bash
   npm run build
   ```

2. Test backup operations:
   ```bash
   node dist/cli/index.js backup
   node dist/cli/index.js backup list
   node dist/cli/index.js backup validate <backup-file>
   ```

3. Test ESM bundling:
   ```bash
   # Create a test project that bundles cursor-history as ESM
   # Verify no "Dynamic require of 'fs' is not supported" errors
   ```

## Files to Modify

1. `src/core/backup.ts` - Main backup implementation (6 AdmZip usages)
2. `src/core/storage.ts` - Backup data source (1 AdmZip usage)
3. `src/lib/backup.ts` - Library API wrappers
4. `package.json` - Dependency update

## Validation Checklist

- [ ] All existing backup tests pass
- [ ] Backup create works (creates valid zip)
- [ ] Backup restore works (extracts all files)
- [ ] Backup validate works (checks checksums)
- [ ] Backup list works (reads manifests)
- [ ] Reading from backup works (`--backup` flag)
- [ ] Old backup files can be read by new code
- [ ] New backup files are standard ZIP format
