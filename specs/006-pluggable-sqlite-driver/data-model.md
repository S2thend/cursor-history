# Data Model: Pluggable SQLite Driver

**Feature**: 006-pluggable-sqlite-driver
**Date**: 2026-01-02

## Entities

### Statement

Represents a prepared SQL statement that can be executed multiple times with different parameters.

| Field | Type | Description |
|-------|------|-------------|
| get | `(...params: unknown[]) => unknown` | Run and return first row |
| all | `(...params: unknown[]) => unknown[]` | Run and return all rows |
| run | `(...params: unknown[]) => RunResult` | Run for side effects (INSERT/UPDATE/DELETE) |

### RunResult

Result of running a statement that modifies data.

| Field | Type | Description |
|-------|------|-------------|
| changes | `number` | Number of rows affected |
| lastInsertRowid | `number \| bigint` | ID of last inserted row |

### Database

Represents an open database connection.

| Field | Type | Description |
|-------|------|-------------|
| prepare | `(sql: string) => Statement` | Create a prepared statement |
| execSQL | `(sql: string) => void` | Run raw SQL directly (no return) |
| close | `() => void` | Close the database connection |

### DatabaseOptions

Options for opening a database connection.

| Field | Type | Description |
|-------|------|-------------|
| readonly | `boolean` | If true, open in read-only mode |

### DatabaseDriver

Represents a pluggable SQLite driver implementation.

| Field | Type | Description |
|-------|------|-------------|
| name | `string` | Unique driver identifier (e.g., "better-sqlite3", "node:sqlite") |
| isAvailable | `() => Promise<boolean>` | Check if driver can be used in current environment |
| open | `(path: string, options: DatabaseOptions) => Database` | Open a database connection |

### DriverRegistry (Singleton)

Manages available drivers and current selection.

| Field | Type | Description |
|-------|------|-------------|
| drivers | `Map<string, DatabaseDriver>` | Registered drivers by name |
| currentDriver | `DatabaseDriver \| null` | Currently active driver |
| initialized | `boolean` | Whether auto-detection has run |

**Methods**:

| Method | Signature | Description |
|--------|-----------|-------------|
| register | `(driver: DatabaseDriver) => void` | Add a driver to the registry |
| setDriver | `(name: string) => void` | Manually select a driver by name |
| getActiveDriver | `() => string` | Get name of current driver |
| autoSelect | `() => Promise<DatabaseDriver>` | Auto-detect and select best available driver |
| openDatabase | `(path: string) => Database` | Open readonly database with current driver |
| openDatabaseReadWrite | `(path: string) => Database` | Open read-write database with current driver |

## State Transitions

### DriverRegistry Lifecycle

```
┌─────────────┐     register()      ┌──────────────┐
│ Uninitialized │ ────────────────▶ │   Registered   │
│  (no drivers) │                   │ (drivers added)│
└─────────────┘                    └──────────────┘
                                          │
                                          │ autoSelect() or setDriver()
                                          ▼
                                   ┌──────────────┐
                                   │    Active      │
                                   │(driver selected)│
                                   └──────────────┘
                                          │
                                          │ setDriver() (runtime switch)
                                          ▼
                                   ┌──────────────┐
                                   │   Switched     │
                                   │(new driver)    │
                                   └──────────────┘
```

### Driver Selection Flow

```
┌─────────────────┐
│ Check env var    │
│ CURSOR_HISTORY_  │
│ SQLITE_DRIVER    │
└────────┬────────┘
         │
         ▼ (if set)
┌─────────────────┐     not available     ┌─────────────┐
│ Use specified    │ ──────────────────▶ │ Throw Error  │
│ driver           │                      │              │
└─────────────────┘                      └─────────────┘
         │
         ▼ (if not set)
┌─────────────────┐
│ Try node:sqlite  │
│ (dynamic import) │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
 success   failure
    │         │
    ▼         ▼
┌────────┐  ┌─────────────────┐
│ Use     │  │ Try better-     │
│ node:   │  │ sqlite3         │
│ sqlite  │  └────────┬────────┘
└────────┘           │
              ┌──────┴──────┐
              │             │
           success       failure
              │             │
              ▼             ▼
         ┌────────┐    ┌─────────────┐
         │ Use     │    │ Throw Error  │
         │ better- │    │ (no driver)  │
         │ sqlite3 │    └─────────────┘
         └────────┘
```

## Validation Rules

1. **Driver name uniqueness**: Each registered driver must have a unique name
2. **Driver availability**: `isAvailable()` must be called before `open()`
3. **Readonly enforcement**: On node:sqlite adapter, throw error if `run()` called on readonly connection
4. **Path validation**: Database path must be a non-empty string

## Relationships

```
┌──────────────────┐
│  DriverRegistry   │ (singleton)
│                  │
│  - drivers       │──────┐
│  - currentDriver │      │ 1:N
└──────────────────┘      │
                          ▼
                  ┌──────────────────┐
                  │  DatabaseDriver   │
                  │                  │
                  │  - name          │
                  │  - isAvailable() │
                  │  - open()        │──────┐
                  └──────────────────┘      │ creates
                                            ▼
                                    ┌──────────────────┐
                                    │    Database       │
                                    │                  │
                                    │  - prepare()     │──────┐
                                    │  - execSQL()     │      │ creates
                                    │  - close()       │      │
                                    └──────────────────┘      ▼
                                                      ┌──────────────────┐
                                                      │   Statement       │
                                                      │                  │
                                                      │  - get()         │
                                                      │  - all()         │
                                                      │  - run()         │
                                                      └──────────────────┘
```

## Configuration Integration

### LibraryConfig Extension

| Field | Type | Description |
|-------|------|-------------|
| sqliteDriver | `'better-sqlite3' \| 'node:sqlite' \| undefined` | Manual driver override |

**Priority** (highest to lowest):
1. `LibraryConfig.sqliteDriver` - per-call override
2. `CURSOR_HISTORY_SQLITE_DRIVER` env var - process-wide override
3. Auto-detection - node:sqlite first, then better-sqlite3
