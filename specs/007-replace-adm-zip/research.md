# Research: Replace adm-zip with ESM-Compatible Alternative

**Feature**: 007-replace-adm-zip
**Date**: 2026-01-03
**Status**: Complete

## Research Questions

### 1. Which ESM-compatible zip library should replace adm-zip?

**Decision**: jszip v3.10.1

**Rationale**:
- Pure JavaScript implementation with no native bindings
- Proper ESM support with `exports` field in package.json
- No dynamic `require()` calls that break Node.js v24+ ESM bundling
- Actively maintained (last release 2022, but stable API)
- MIT licensed (compatible with project)
- Well-documented Promise-based API
- Recommended in the original GitHub issue

**Alternatives Considered**:

| Library | Pros | Cons | Decision |
|---------|------|------|----------|
| jszip | Pure JS, ESM-compatible, Promise API | Async-only (sync code needs refactoring) | ✅ Selected |
| archiver + yauzl | Separate create/read packages, ESM-friendly | Two dependencies instead of one | ❌ Rejected (complexity) |
| yazl + yauzl | Lightweight, streaming | Two packages, lower-level API | ❌ Rejected (complexity) |
| fflate | Very fast, ESM-native | Lower-level API, less documentation | ❌ Rejected (API complexity) |

### 2. What API changes are required for jszip migration?

**Decision**: Convert synchronous zip operations to async

**Rationale**:
jszip's API is Promise-based by design. This aligns with modern JavaScript patterns and doesn't block the event loop during zip operations.

**Key Transformations**:

```typescript
// adm-zip (sync)
const zip = new AdmZip(backupPath);
const buffer = zip.readFile('manifest.json');

// jszip (async)
const data = await readFile(backupPath);
const zip = await JSZip.loadAsync(data);
const buffer = await zip.file('manifest.json')?.async('nodebuffer');
```

### 3. Are there backwards compatibility concerns with existing backup files?

**Decision**: No compatibility issues expected

**Rationale**:
- Both adm-zip and jszip use standard ZIP format (DEFLATE compression)
- jszip can read any valid ZIP file regardless of which library created it
- The ZIP file structure (manifest.json, database file paths) is controlled by our code, not the library
- Cross-platform path handling (forward slashes in ZIP entries) is standard

**Verification Needed**:
- Test reading backup files created by adm-zip with jszip
- Test that new backups are readable by older cursor-history versions (if installed)

### 4. What is the impact on function signatures?

**Decision**: Several functions must change from sync to async

**Functions Affected**:

| Function | Current | After Migration | Breaking? |
|----------|---------|-----------------|-----------|
| `createBackup()` | async | async | No |
| `openBackupDatabase()` | sync | async | Yes (internal) |
| `readBackupManifest()` | sync | async | Yes (internal) |
| `validateBackup()` | sync | async | Yes (internal) |
| `restoreBackup()` | sync | async | Yes (internal) |
| `listBackups()` | sync | async | Yes (internal) |
| `readWorkspaceJsonFromBackup()` | sync | async | No (private) |

**Mitigation**:
- All affected functions are internal (`src/core/`) not public library API
- Library exports (`src/lib/index.ts`) may need updates if they wrap these
- CLI commands already use async patterns, minimal changes expected

### 5. Performance considerations

**Decision**: No significant performance regression expected

**Rationale**:
- jszip is pure JavaScript vs adm-zip's pure JavaScript (no difference in this regard)
- Async operations may actually improve perceived performance by not blocking
- For typical backup sizes (<100MB), any difference is negligible
- jszip has options for compression level that match defaults

**Verification Needed**:
- Benchmark backup creation for 50MB and 100MB test cases
- Ensure no more than 10% regression per spec requirements

## Dependencies

### Add

```json
{
  "dependencies": {
    "jszip": "^3.10.1"
  }
}
```

### Remove

```json
{
  "dependencies": {
    "adm-zip": "^0.5.16"
  },
  "devDependencies": {
    "@types/adm-zip": "^0.5.7"
  }
}
```

**Net Change**: -1 dependency (jszip has built-in types)

## Implementation Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| API differences cause bugs | Medium | High | Comprehensive manual testing |
| Performance regression | Low | Medium | Benchmark before/after |
| Async refactoring breaks callers | Low | High | Update all callers in same PR |
| Backup file incompatibility | Very Low | High | Test with existing backups |

## Conclusion

jszip is the clear choice for replacing adm-zip. The migration requires:

1. Update `package.json` dependencies
2. Refactor 7 functions from sync to async in `backup.ts`
3. Update 1 function in `storage.ts`
4. Update any CLI commands or library exports that call these functions
5. Add tests for backup operations
6. Verify backwards compatibility with existing backup files
