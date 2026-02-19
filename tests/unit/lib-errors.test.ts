import { describe, it, expect } from 'vitest';
import {
  DatabaseLockedError,
  isDatabaseLockedError,
  DatabaseNotFoundError,
  isDatabaseNotFoundError,
  InvalidConfigError,
  isInvalidConfigError,
  InvalidFilterError,
  isInvalidFilterError,
  SessionNotFoundError,
  isSessionNotFoundError,
  WorkspaceNotFoundError,
  isWorkspaceNotFoundError,
  SameWorkspaceError,
  isSameWorkspaceError,
  NoSessionsFoundError,
  isNoSessionsFoundError,
  DestinationHasSessionsError,
  isDestinationHasSessionsError,
  NestedPathError,
  isNestedPathError,
  BackupError,
  isBackupError,
  NoDataError,
  isNoDataError,
  FileExistsError,
  isFileExistsError,
  InsufficientSpaceError,
  isInsufficientSpaceError,
  RestoreError,
  isRestoreError,
  BackupNotFoundError,
  isBackupNotFoundError,
  InvalidBackupError,
  isInvalidBackupError,
  TargetExistsError,
  isTargetExistsError,
  IntegrityError,
  isIntegrityError,
} from '../../src/lib/errors.js';

// =============================================================================
// Error class construction
// =============================================================================

describe('DatabaseLockedError', () => {
  it('has correct properties', () => {
    const err = new DatabaseLockedError('/db/path');
    expect(err.name).toBe('DatabaseLockedError');
    expect(err.path).toBe('/db/path');
    expect(err.message).toContain('/db/path');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('DatabaseNotFoundError', () => {
  it('has correct properties', () => {
    const err = new DatabaseNotFoundError('/missing');
    expect(err.name).toBe('DatabaseNotFoundError');
    expect(err.path).toBe('/missing');
    expect(err.message).toContain('/missing');
  });
});

describe('InvalidConfigError', () => {
  it('has correct properties', () => {
    const err = new InvalidConfigError('limit', -1, 'must be positive');
    expect(err.name).toBe('InvalidConfigError');
    expect(err.field).toBe('limit');
    expect(err.value).toBe(-1);
    expect(err.message).toContain('limit');
  });
});

describe('InvalidFilterError', () => {
  it('has correct properties', () => {
    const err = new InvalidFilterError(['bad'], ['user', 'assistant']);
    expect(err.name).toBe('InvalidFilterError');
    expect(err.invalidTypes).toEqual(['bad']);
    expect(err.validTypes).toEqual(['user', 'assistant']);
    expect(err.message).toContain('bad');
  });
});

describe('SessionNotFoundError', () => {
  it('works with string identifier', () => {
    const err = new SessionNotFoundError('abc-123');
    expect(err.name).toBe('SessionNotFoundError');
    expect(err.identifier).toBe('abc-123');
  });

  it('works with number identifier', () => {
    const err = new SessionNotFoundError(42);
    expect(err.identifier).toBe(42);
    expect(err.message).toContain('42');
  });
});

describe('WorkspaceNotFoundError', () => {
  it('has correct properties', () => {
    const err = new WorkspaceNotFoundError('/workspace');
    expect(err.name).toBe('WorkspaceNotFoundError');
    expect(err.path).toBe('/workspace');
  });
});

describe('SameWorkspaceError', () => {
  it('has correct properties', () => {
    const err = new SameWorkspaceError('/same');
    expect(err.name).toBe('SameWorkspaceError');
    expect(err.path).toBe('/same');
  });
});

describe('NoSessionsFoundError', () => {
  it('has correct properties', () => {
    const err = new NoSessionsFoundError('/empty');
    expect(err.name).toBe('NoSessionsFoundError');
    expect(err.path).toBe('/empty');
  });
});

describe('DestinationHasSessionsError', () => {
  it('has correct properties', () => {
    const err = new DestinationHasSessionsError('/dest', 5);
    expect(err.name).toBe('DestinationHasSessionsError');
    expect(err.path).toBe('/dest');
    expect(err.sessionCount).toBe(5);
    expect(err.message).toContain('5');
  });
});

describe('NestedPathError', () => {
  it('has correct properties', () => {
    const err = new NestedPathError('/src', '/src/sub');
    expect(err.name).toBe('NestedPathError');
    expect(err.source).toBe('/src');
    expect(err.destination).toBe('/src/sub');
  });
});

describe('BackupError', () => {
  it('has correct properties', () => {
    const err = new BackupError('backup failed');
    expect(err.name).toBe('BackupError');
    expect(err.message).toBe('backup failed');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('NoDataError', () => {
  it('has correct properties and extends BackupError', () => {
    const err = new NoDataError('/no-data');
    expect(err.name).toBe('NoDataError');
    expect(err.path).toBe('/no-data');
    expect(err).toBeInstanceOf(BackupError);
  });
});

describe('FileExistsError (lib)', () => {
  it('has correct properties and extends BackupError', () => {
    const err = new FileExistsError('/exists');
    expect(err.name).toBe('FileExistsError');
    expect(err.path).toBe('/exists');
    expect(err).toBeInstanceOf(BackupError);
  });
});

describe('InsufficientSpaceError', () => {
  it('has correct properties and extends BackupError', () => {
    const err = new InsufficientSpaceError(1000000, 500000);
    expect(err.name).toBe('InsufficientSpaceError');
    expect(err.required).toBe(1000000);
    expect(err.available).toBe(500000);
    expect(err).toBeInstanceOf(BackupError);
  });
});

describe('RestoreError', () => {
  it('has correct properties', () => {
    const err = new RestoreError('restore failed');
    expect(err.name).toBe('RestoreError');
    expect(err.message).toBe('restore failed');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('BackupNotFoundError', () => {
  it('has correct properties and extends RestoreError', () => {
    const err = new BackupNotFoundError('/backup.zip');
    expect(err.name).toBe('BackupNotFoundError');
    expect(err.path).toBe('/backup.zip');
    expect(err).toBeInstanceOf(RestoreError);
  });
});

describe('InvalidBackupError', () => {
  it('has correct properties and extends RestoreError', () => {
    const err = new InvalidBackupError('/bad.zip', 'corrupted');
    expect(err.name).toBe('InvalidBackupError');
    expect(err.path).toBe('/bad.zip');
    expect(err.reason).toBe('corrupted');
    expect(err).toBeInstanceOf(RestoreError);
  });
});

describe('TargetExistsError', () => {
  it('has correct properties and extends RestoreError', () => {
    const err = new TargetExistsError('/target');
    expect(err.name).toBe('TargetExistsError');
    expect(err.path).toBe('/target');
    expect(err).toBeInstanceOf(RestoreError);
  });
});

describe('IntegrityError', () => {
  it('has correct properties and extends RestoreError', () => {
    const err = new IntegrityError(['file1.db', 'file2.db']);
    expect(err.name).toBe('IntegrityError');
    expect(err.failedFiles).toEqual(['file1.db', 'file2.db']);
    expect(err).toBeInstanceOf(RestoreError);
  });
});

// =============================================================================
// Type guards
// =============================================================================

describe('type guards', () => {
  const guards = [
    {
      guard: isDatabaseLockedError,
      instance: new DatabaseLockedError('p'),
      name: 'isDatabaseLockedError',
    },
    {
      guard: isDatabaseNotFoundError,
      instance: new DatabaseNotFoundError('p'),
      name: 'isDatabaseNotFoundError',
    },
    {
      guard: isInvalidConfigError,
      instance: new InvalidConfigError('f', 'v', 'r'),
      name: 'isInvalidConfigError',
    },
    {
      guard: isInvalidFilterError,
      instance: new InvalidFilterError([], []),
      name: 'isInvalidFilterError',
    },
    {
      guard: isSessionNotFoundError,
      instance: new SessionNotFoundError('x'),
      name: 'isSessionNotFoundError',
    },
    {
      guard: isWorkspaceNotFoundError,
      instance: new WorkspaceNotFoundError('p'),
      name: 'isWorkspaceNotFoundError',
    },
    {
      guard: isSameWorkspaceError,
      instance: new SameWorkspaceError('p'),
      name: 'isSameWorkspaceError',
    },
    {
      guard: isNoSessionsFoundError,
      instance: new NoSessionsFoundError('p'),
      name: 'isNoSessionsFoundError',
    },
    {
      guard: isDestinationHasSessionsError,
      instance: new DestinationHasSessionsError('p', 1),
      name: 'isDestinationHasSessionsError',
    },
    {
      guard: isNestedPathError,
      instance: new NestedPathError('a', 'b'),
      name: 'isNestedPathError',
    },
    { guard: isBackupError, instance: new BackupError('msg'), name: 'isBackupError' },
    { guard: isNoDataError, instance: new NoDataError('p'), name: 'isNoDataError' },
    { guard: isFileExistsError, instance: new FileExistsError('p'), name: 'isFileExistsError' },
    {
      guard: isInsufficientSpaceError,
      instance: new InsufficientSpaceError(1, 0),
      name: 'isInsufficientSpaceError',
    },
    { guard: isRestoreError, instance: new RestoreError('msg'), name: 'isRestoreError' },
    {
      guard: isBackupNotFoundError,
      instance: new BackupNotFoundError('p'),
      name: 'isBackupNotFoundError',
    },
    {
      guard: isInvalidBackupError,
      instance: new InvalidBackupError('p', 'r'),
      name: 'isInvalidBackupError',
    },
    {
      guard: isTargetExistsError,
      instance: new TargetExistsError('p'),
      name: 'isTargetExistsError',
    },
    { guard: isIntegrityError, instance: new IntegrityError([]), name: 'isIntegrityError' },
  ] as const;

  for (const { guard, instance, name } of guards) {
    it(`${name} returns true for correct instance`, () => {
      expect(guard(instance)).toBe(true);
    });

    it(`${name} returns false for generic Error`, () => {
      expect(guard(new Error('other'))).toBe(false);
    });

    it(`${name} returns false for null`, () => {
      expect(guard(null)).toBe(false);
    });
  }
});
