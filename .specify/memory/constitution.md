<!--
  SYNC IMPACT REPORT
  ==================
  Version change: 1.0.0 → 1.1.0

  Modified Sections:
  - Technical Standards: Python → TypeScript/Node.js

  Rationale: JavaScript chosen for future GUI extensibility (Electron/Tauri)

  Templates Requiring Updates:
  - .specify/templates/plan-template.md ✅ (generic, no updates needed)
  - .specify/templates/spec-template.md ✅ (generic, no updates needed)
  - .specify/templates/tasks-template.md ✅ (generic, no updates needed)

  Follow-up TODOs:
  - None
-->

# Cursor Chat History Constitution

## Core Principles

### I. Simplicity First

Every implementation MUST choose the simplest solution that meets requirements.

- Start with the minimal viable approach; add complexity only when proven necessary
- YAGNI (You Aren't Gonna Need It): Do not implement features for hypothetical future needs
- Prefer standard library solutions over external dependencies
- Each function MUST do one thing well
- If a solution requires explanation beyond a brief comment, it is likely too complex

**Rationale**: A CLI tool for parsing chat history has a focused scope. Simplicity ensures
maintainability, reduces bugs, and makes the codebase accessible to contributors.

### II. CLI-Native Design

The tool MUST follow Unix philosophy and CLI conventions.

- Text in, text out: stdin/arguments as input, stdout for results, stderr for errors
- Exit codes MUST be meaningful: 0 for success, non-zero for specific error categories
- Support both human-readable and machine-parseable output (JSON flag)
- Flags and arguments MUST follow POSIX conventions (short `-f`, long `--flag`)
- Help text (`--help`) MUST be comprehensive and include examples

**Rationale**: Users expect CLI tools to integrate with pipelines, scripts, and other tools.
Adhering to conventions ensures composability and reduces friction.

### III. Documentation-Driven

Documentation MUST be treated as a first-class deliverable, not an afterthought.

- README MUST explain installation, basic usage, and common workflows
- Every public function/command MUST have docstrings explaining purpose, parameters, and return
- Examples MUST be tested or derived from actual tool output
- Breaking changes MUST be documented in a CHANGELOG with migration guidance
- Error messages MUST be actionable: describe what went wrong and how to fix it

**Rationale**: A tool for extracting and reading chat history should itself be easy to
understand. Good documentation reduces support burden and increases adoption.

### IV. Incremental Delivery

Features MUST be delivered in small, independently usable increments.

- Each user story MUST be testable and demonstrable on its own
- MVP first: deliver the core parse-and-display workflow before advanced features
- Avoid large PRs; prefer focused commits that can be reviewed and reverted independently
- Integration points (file formats, output schemas) MUST be stable before building on them

**Rationale**: Incremental delivery reduces risk, enables early feedback, and ensures that
partially complete work still provides value.

### V. Defensive Parsing

The parser MUST handle malformed, incomplete, or unexpected input gracefully.

- Never crash on bad input; emit structured errors and continue where possible
- Validate input formats early and fail fast with clear error messages
- Unknown fields in input MUST be ignored, not rejected (forward compatibility)
- Encoding issues (UTF-8 BOM, mixed encodings) MUST be handled explicitly
- Large files MUST be processed with bounded memory (streaming where feasible)

**Rationale**: Cursor chat history files may vary across versions or be partially corrupted.
Robust parsing ensures the tool remains useful in real-world conditions.

## Technical Standards

- **Language**: TypeScript 5.0+ (strict mode enabled)
- **Runtime**: Node.js 20 LTS (or Bun for faster execution)
- **Packaging**: npm package; `bun build --compile` for standalone binary distribution
- **Dependencies**: Minimize external dependencies; document rationale for each
- **Testing**: Vitest for unit/integration tests; aim for coverage of parsing edge cases
- **Linting**: ESLint + Prettier; enforce via pre-commit hooks or lint-staged
- **Type Safety**: `strict: true` in tsconfig; no `any` without explicit justification
- **GUI Extensibility**: Core logic MUST be decoupled from CLI to enable future Electron/Tauri GUI

## Development Workflow

1. **Spec before code**: Write or update spec.md before implementing a feature
2. **Small PRs**: Each PR addresses one concern; avoid bundling unrelated changes
3. **Review checklist**: Verify simplicity, CLI conventions, and documentation
4. **Manual testing**: Run the tool on real Cursor chat exports before merging
5. **Release notes**: Update CHANGELOG for every user-facing change

## Governance

This constitution supersedes conflicting guidance elsewhere in the repository.

**Amendment Procedure**:
1. Propose changes via PR with rationale
2. Changes MUST be reviewed and approved before merge
3. Update version according to semantic versioning:
   - MAJOR: Principle removal or backward-incompatible redefinition
   - MINOR: New principle or materially expanded guidance
   - PATCH: Clarifications, wording, typo fixes

**Compliance Review**:
- All PRs MUST verify adherence to Core Principles
- Complexity beyond simplest solution MUST be justified in PR description

**Version**: 1.1.0 | **Ratified**: 2025-12-18 | **Last Amended**: 2025-12-18
