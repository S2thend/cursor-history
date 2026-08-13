/**
 * Pure metadata catalog and same-tier replica reconciliation primitives.
 *
 * Discovery adapters supply private physical instances. This module groups
 * them without opening conversation payloads, keeps public logical identity
 * separate from locators, and hydrates only the replica tier selected by the
 * caller's Composer/Store arbitration decision.
 */

import { SessionAmbiguityError } from './errors.js';
import { REPLICA_EQUIVALENCE_VERSION, sha256CanonicalJsonV1 } from './session-identity.js';
import type {
  AmbiguousSessionSummary,
  IndexScope,
  MessageRole,
  ResolutionState,
  SessionSourceInstance,
  SourceRepresentation,
  SourceRole,
  WorkspaceMatchKind,
  WorkspaceMembership,
} from './types.js';
import { normalizeWorkspacePath } from './workspace-scope.js';
import { logicalSessionIdKey, selectNativeSessionIdSpelling } from './session-id.js';

const SOURCE_ROLE_ORDER = ['composer', 'store'] as const satisfies readonly SourceRole[];
const REPRESENTATION_ORDER = [
  'composer-global',
  'composer-workspace',
  'store-db',
  'store-transcript',
  'store-metadata',
] as const satisfies readonly SourceRepresentation[];

export type ReplicaFidelityTier = 'complete' | 'partial';
export type ReplicaState = 'single' | 'equivalent' | 'divergent';
export type CanonicalWorkspacePathKind = 'composer-configuration' | 'composer-folder' | 'store-cwd';

const FIDELITY_ORDER = ['complete', 'partial'] as const satisfies readonly ReplicaFidelityTier[];
const CANONICAL_PATH_KIND_ORDER = [
  'composer-configuration',
  'composer-folder',
  'store-cwd',
] as const satisfies readonly CanonicalWorkspacePathKind[];
const INSTANCE_STATE_ORDER = [
  'contributed',
  'equivalent-replica',
  'omitted-by-scope',
  'failed',
  'superseded',
] as const satisfies readonly SessionSourceInstance['state'][];

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function compareByDeclaration<T extends string>(order: readonly T[], left: T, right: T): number {
  return order.indexOf(left) - order.indexOf(right);
}

function requireNonempty(name: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
}

function canonicalStrings(values: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(values.map((value) => normalizeWorkspacePath(value)))].sort(compareCodePoints)
  );
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = compareCodePoints(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function representationBelongsToRole(
  sourceRole: SourceRole,
  representation: SourceRepresentation
): boolean {
  return sourceRole === 'composer'
    ? representation === 'composer-global' || representation === 'composer-workspace'
    : representation === 'store-db' ||
        representation === 'store-transcript' ||
        representation === 'store-metadata';
}

export interface CanonicalWorkspaceCandidate {
  readonly workspacePath: string;
  readonly kind: CanonicalWorkspacePathKind;
}

/** Consumed tool fields participating in replica-equivalence v1. */
export interface ReplicaConsumedToolCall {
  readonly id: string;
  readonly name: string;
  readonly status: 'completed' | 'cancelled' | 'error';
  readonly params?: unknown;
  readonly result?: string;
  readonly error?: string;
  /** Provenance, files, durations, and unknown enrichment fields are ignored. */
  readonly [key: string]: unknown;
}

/** Consumed message fields participating in replica-equivalence v1. */
export interface ReplicaConsumedMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: string;
  /** Raw directly-stored value only; never an inferred display timestamp. */
  readonly directTimestamp?: string | number | null;
  readonly thinking?: string;
  readonly error?: unknown;
  readonly parentMessageId?: string;
  readonly isSidechain?: boolean;
  readonly toolCalls?: readonly ReplicaConsumedToolCall[];
  /** Presentation and provenance fields are deliberately ignored. */
  readonly [key: string]: unknown;
}

/** Exact unchanged-consumer payload used by equivalence v1. */
export interface ReplicaConsumedPayload {
  readonly messages: readonly ReplicaConsumedMessage[];
  readonly activeBranchMessageIds?: readonly string[];
  readonly leafMessageId?: string;
  readonly sourceRelationships?: unknown;
  /** Titles, paths, provenance, and other presentation fields are ignored. */
  readonly [key: string]: unknown;
}

export interface PhysicalSessionInstance<TLocator = unknown> {
  /** Private stable key for this occurrence; never included in public output. */
  readonly instanceKey: string;
  readonly logicalSessionId: string;
  readonly sourceRole: SourceRole;
  readonly representation: SourceRepresentation;
  readonly fidelityTier: ReplicaFidelityTier;
  /** Exact private database/record/file locator; never included in public output. */
  readonly locator: TLocator;
  readonly workspacePaths: readonly string[];
  readonly canonicalWorkspaceCandidates?: readonly CanonicalWorkspaceCandidate[];
  /** Stable native order within one representation, independent of discovery order. */
  readonly sourceOrder: number;
  /** Optional lazy payload loader. Catalog construction never invokes it. */
  readonly loadConsumedPayload?: () => Promise<ReplicaConsumedPayload> | ReplicaConsumedPayload;
}

export interface ReplicaGroup<TLocator = unknown> {
  readonly logicalSessionId: string;
  readonly sourceRole: SourceRole;
  readonly representation: SourceRepresentation;
  readonly fidelityTier: ReplicaFidelityTier;
  readonly equivalenceVersion: typeof REPLICA_EQUIVALENCE_VERSION;
  readonly candidates: readonly PhysicalSessionInstance<TLocator>[];
}

export interface LogicalSessionCatalogRecord<TLocator = unknown> {
  readonly id: string;
  readonly canonicalWorkspacePath?: string;
  readonly matchedWorkspacePath?: string;
  readonly workspaceMatchKind?: WorkspaceMatchKind;
  readonly workspaceMemberships: readonly WorkspaceMembership[];
  readonly instances: readonly PhysicalSessionInstance<TLocator>[];
  readonly replicaGroups: readonly ReplicaGroup<TLocator>[];
}

export interface SessionCatalogBuildOptions {
  readonly activeWorkspace?: {
    readonly matchedWorkspacePath: string;
    readonly matchKind: WorkspaceMatchKind;
  };
}

function normalizePhysicalInstance<TLocator>(
  input: PhysicalSessionInstance<TLocator>
): PhysicalSessionInstance<TLocator> {
  requireNonempty('Physical instance key', input.instanceKey);
  requireNonempty('Logical session ID', input.logicalSessionId);
  if (!representationBelongsToRole(input.sourceRole, input.representation)) {
    throw new TypeError(
      `Representation ${input.representation} does not belong to source role ${input.sourceRole}.`
    );
  }
  if (!Number.isSafeInteger(input.sourceOrder) || input.sourceOrder < 0) {
    throw new TypeError('Physical instance sourceOrder must be a non-negative safe integer.');
  }

  const workspacePaths = canonicalStrings(input.workspacePaths);
  const workspaceSet = new Set(workspacePaths);
  const canonicalWorkspaceCandidates = input.canonicalWorkspaceCandidates?.map((candidate) => {
    const workspacePath = normalizeWorkspacePath(candidate.workspacePath);
    if (!workspaceSet.has(workspacePath)) {
      throw new TypeError('A canonical workspace candidate must also be a verified membership.');
    }
    if (
      (input.sourceRole === 'composer' && candidate.kind === 'store-cwd') ||
      (input.sourceRole === 'store' && candidate.kind !== 'store-cwd')
    ) {
      throw new TypeError(
        `Canonical path kind ${candidate.kind} does not belong to source role ${input.sourceRole}.`
      );
    }
    return Object.freeze({ workspacePath, kind: candidate.kind });
  });

  return Object.freeze({
    ...input,
    workspacePaths,
    ...(canonicalWorkspaceCandidates
      ? { canonicalWorkspaceCandidates: Object.freeze(canonicalWorkspaceCandidates) }
      : {}),
  });
}

function compareInstances<TLocator>(
  left: PhysicalSessionInstance<TLocator>,
  right: PhysicalSessionInstance<TLocator>
): number {
  if (left.sourceOrder !== right.sourceOrder) return left.sourceOrder - right.sourceOrder;
  const byPaths = compareStringArrays(left.workspacePaths, right.workspacePaths);
  if (byPaths !== 0) return byPaths;
  return compareCodePoints(left.instanceKey, right.instanceKey);
}

function compareGroups<TLocator>(
  left: ReplicaGroup<TLocator>,
  right: ReplicaGroup<TLocator>
): number {
  const byRole = compareByDeclaration(SOURCE_ROLE_ORDER, left.sourceRole, right.sourceRole);
  if (byRole !== 0) return byRole;
  const byRepresentation = compareByDeclaration(
    REPRESENTATION_ORDER,
    left.representation,
    right.representation
  );
  if (byRepresentation !== 0) return byRepresentation;
  return compareByDeclaration(FIDELITY_ORDER, left.fidelityTier, right.fidelityTier);
}

function buildMemberships<TLocator>(
  instances: readonly PhysicalSessionInstance<TLocator>[]
): readonly WorkspaceMembership[] {
  const memberships = new Map<string, { sourceRoles: Set<SourceRole>; count: number }>();
  for (const instance of instances) {
    for (const workspacePath of instance.workspacePaths) {
      const membership = memberships.get(workspacePath) ?? {
        sourceRoles: new Set<SourceRole>(),
        count: 0,
      };
      membership.sourceRoles.add(instance.sourceRole);
      membership.count++;
      memberships.set(workspacePath, membership);
    }
  }
  return Object.freeze(
    [...memberships.entries()]
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([workspacePath, value]) => {
        const sourceRoles = [...value.sourceRoles].sort((left, right) =>
          compareByDeclaration(SOURCE_ROLE_ORDER, left, right)
        );
        Object.freeze(sourceRoles);
        return Object.freeze({
          workspacePath,
          sourceRoles,
          contributingInstanceCount: value.count,
        });
      })
  );
}

function defaultCanonicalCandidates<TLocator>(
  instance: PhysicalSessionInstance<TLocator>
): readonly CanonicalWorkspaceCandidate[] {
  if (instance.canonicalWorkspaceCandidates) return instance.canonicalWorkspaceCandidates;
  return instance.workspacePaths.map((workspacePath) => ({
    workspacePath,
    kind:
      instance.sourceRole === 'store'
        ? 'store-cwd'
        : workspacePath.toLowerCase().endsWith('.code-workspace')
          ? 'composer-configuration'
          : 'composer-folder',
  }));
}

function selectCanonicalWorkspacePath<TLocator>(
  instances: readonly PhysicalSessionInstance<TLocator>[]
): string | undefined {
  const composerBacked = instances.some((instance) => instance.sourceRole === 'composer');
  const candidates = instances
    .filter((instance) => (composerBacked ? instance.sourceRole === 'composer' : true))
    .flatMap((instance) => defaultCanonicalCandidates(instance));
  if (candidates.length === 0) return undefined;

  const bestByPath = new Map<string, CanonicalWorkspacePathKind>();
  for (const candidate of candidates) {
    const existing = bestByPath.get(candidate.workspacePath);
    if (
      !existing ||
      compareByDeclaration(CANONICAL_PATH_KIND_ORDER, candidate.kind, existing) < 0
    ) {
      bestByPath.set(candidate.workspacePath, candidate.kind);
    }
  }
  return [...bestByPath.entries()].sort(([leftPath, leftKind], [rightPath, rightKind]) => {
    const byKind = compareByDeclaration(CANONICAL_PATH_KIND_ORDER, leftKind, rightKind);
    return byKind || compareCodePoints(leftPath, rightPath);
  })[0]?.[0];
}

/**
 * Group metadata-only physical inventory into one deterministic row per native
 * UUID. No payload loader is called by this operation.
 */
export function buildSessionCatalog<TLocator>(
  physicalInstances: readonly PhysicalSessionInstance<TLocator>[],
  options: SessionCatalogBuildOptions = {}
): readonly LogicalSessionCatalogRecord<TLocator>[] {
  const seenInstanceKeys = new Set<string>();
  const bySession = new Map<string, PhysicalSessionInstance<TLocator>[]>();
  for (const input of physicalInstances) {
    if (seenInstanceKeys.has(input.instanceKey)) {
      throw new TypeError(`Duplicate physical instance key: ${input.instanceKey}`);
    }
    seenInstanceKeys.add(input.instanceKey);
    const instance = normalizePhysicalInstance(input);
    const logicalKey = logicalSessionIdKey(instance.logicalSessionId);
    const sessionInstances = bySession.get(logicalKey) ?? [];
    sessionInstances.push(instance);
    bySession.set(logicalKey, sessionInstances);
  }

  const activeWorkspace = options.activeWorkspace
    ? {
        matchedWorkspacePath: normalizeWorkspacePath(options.activeWorkspace.matchedWorkspacePath),
        matchKind: options.activeWorkspace.matchKind,
      }
    : undefined;

  return Object.freeze(
    [...bySession.entries()]
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([_logicalKey, unsortedInstances]) => {
        // Composer is the compatibility authority for a cross-stack logical UUID. Within that
        // role, prefer the highest-fidelity/representation tier before choosing a deterministic
        // real spelling. A Store case variant must never rewrite a v0.16 Composer public ID.
        const preferredRole = unsortedInstances.some(({ sourceRole }) => sourceRole === 'composer')
          ? 'composer'
          : 'store';
        const roleInstances = unsortedInstances.filter(
          ({ sourceRole }) => sourceRole === preferredRole
        );
        const bestRepresentation = [...roleInstances].sort((left, right) => {
          const byRepresentation = compareByDeclaration(
            REPRESENTATION_ORDER,
            left.representation,
            right.representation
          );
          return (
            byRepresentation ||
            compareByDeclaration(FIDELITY_ORDER, left.fidelityTier, right.fidelityTier)
          );
        })[0]!;
        const preferredTier = roleInstances.filter(
          ({ representation, fidelityTier }) =>
            representation === bestRepresentation.representation &&
            fidelityTier === bestRepresentation.fidelityTier
        );
        const id = selectNativeSessionIdSpelling(
          preferredTier.map(({ logicalSessionId }) => logicalSessionId)
        )!;
        const instances = Object.freeze([...unsortedInstances].sort(compareInstances));
        const grouped = new Map<string, PhysicalSessionInstance<TLocator>[]>();
        for (const instance of instances) {
          // Case spelling is a physical occurrence detail, not another representation. Candidates
          // from one logical UUID must compete inside the same replica group so divergence cannot
          // be hidden behind two differently cased map keys.
          const key = [instance.sourceRole, instance.representation, instance.fidelityTier].join(
            '\0'
          );
          const candidates = grouped.get(key) ?? [];
          candidates.push(instance);
          grouped.set(key, candidates);
        }
        const replicaGroups = Object.freeze(
          [...grouped.values()]
            .map((candidates): ReplicaGroup<TLocator> => {
              const first = candidates[0]!;
              return Object.freeze({
                logicalSessionId: id,
                sourceRole: first.sourceRole,
                representation: first.representation,
                fidelityTier: first.fidelityTier,
                equivalenceVersion: REPLICA_EQUIVALENCE_VERSION,
                candidates: Object.freeze([...candidates].sort(compareInstances)),
              });
            })
            .sort(compareGroups)
        );
        const workspaceMemberships = buildMemberships(instances);
        const canonicalWorkspacePath = selectCanonicalWorkspacePath(instances);
        const matched = activeWorkspace
          ? workspaceMemberships.some(
              (membership) => membership.workspacePath === activeWorkspace.matchedWorkspacePath
            )
          : false;
        return Object.freeze({
          id,
          ...(canonicalWorkspacePath ? { canonicalWorkspacePath } : {}),
          ...(matched
            ? {
                matchedWorkspacePath: activeWorkspace!.matchedWorkspacePath,
                workspaceMatchKind: activeWorkspace!.matchKind,
              }
            : {}),
          workspaceMemberships,
          instances,
          replicaGroups,
        });
      })
  );
}

function optionalMember(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

/** Project only fields consumed by equivalence contract v1. */
export function projectConsumedPayloadEquivalenceV1(
  payload: ReplicaConsumedPayload
): Record<string, unknown> {
  const messages = payload.messages.map((message) => {
    requireNonempty('Replica message ID', message.id);
    const projected: Record<string, unknown> = {
      id: message.id,
      role: message.role,
      content: message.content,
    };
    optionalMember(projected, 'directTimestamp', message.directTimestamp);
    optionalMember(projected, 'thinking', message.thinking);
    optionalMember(projected, 'error', message.error);
    optionalMember(projected, 'parentMessageId', message.parentMessageId);
    optionalMember(projected, 'isSidechain', message.isSidechain);
    if (message.toolCalls !== undefined) {
      projected['toolCalls'] = message.toolCalls.map((tool) => {
        requireNonempty('Replica tool ID', tool.id);
        requireNonempty('Replica tool name', tool.name);
        const consumed: Record<string, unknown> = {
          id: tool.id,
          name: tool.name,
          status: tool.status,
        };
        optionalMember(consumed, 'params', tool.params);
        optionalMember(consumed, 'result', tool.result);
        optionalMember(consumed, 'error', tool.error);
        return consumed;
      });
    }
    return projected;
  });
  const projected: Record<string, unknown> = {
    equivalenceVersion: REPLICA_EQUIVALENCE_VERSION,
    messages,
  };
  optionalMember(projected, 'activeBranchMessageIds', payload.activeBranchMessageIds);
  optionalMember(projected, 'leafMessageId', payload.leafMessageId);
  optionalMember(projected, 'sourceRelationships', payload.sourceRelationships);
  return projected;
}

/** Full lowercase SHA-256 fingerprint for consumed-payload equivalence v1. */
export function fingerprintConsumedPayloadV1(payload: ReplicaConsumedPayload): string {
  return sha256CanonicalJsonV1(projectConsumedPayloadEquivalenceV1(payload));
}

export interface ReplicaFingerprint<TLocator = unknown> {
  readonly instance: PhysicalSessionInstance<TLocator>;
  readonly fingerprint: string;
}

export interface DiagnosticOccurrence<TLocator = unknown> extends ReplicaFingerprint<TLocator> {
  readonly occurrenceRef: string;
}

export type ReconciledReplicaGroup<TLocator = unknown> =
  | {
      readonly state: 'single' | 'equivalent';
      readonly group: ReplicaGroup<TLocator>;
      readonly selected: PhysicalSessionInstance<TLocator>;
      readonly selectedPayload?: ReplicaConsumedPayload;
      readonly fingerprints: readonly ReplicaFingerprint<TLocator>[];
      readonly sourceInstances: readonly SessionSourceInstance[];
      readonly diagnosticOccurrences: readonly never[];
    }
  | {
      readonly state: 'divergent';
      readonly group: ReplicaGroup<TLocator>;
      readonly fingerprints: readonly ReplicaFingerprint<TLocator>[];
      readonly sourceInstances: readonly never[];
      readonly diagnosticOccurrences: readonly DiagnosticOccurrence<TLocator>[];
    };

export interface ReconcileReplicaOptions {
  /** Required for divergent output; makes diagnostic references context-bound. */
  readonly diagnosticContextId?: string;
}

function sourceInstanceProjection<TLocator>(
  instance: PhysicalSessionInstance<TLocator>,
  state: SessionSourceInstance['state']
): SessionSourceInstance {
  const workspacePaths = [...instance.workspacePaths];
  Object.freeze(workspacePaths);
  return Object.freeze({
    sourceRole: instance.sourceRole,
    representation: instance.representation,
    workspacePaths,
    state,
  });
}

function compareSourceInstances(left: SessionSourceInstance, right: SessionSourceInstance): number {
  const byRole = compareByDeclaration(SOURCE_ROLE_ORDER, left.sourceRole, right.sourceRole);
  if (byRole !== 0) return byRole;
  const byRepresentation = compareByDeclaration(
    REPRESENTATION_ORDER,
    left.representation,
    right.representation
  );
  if (byRepresentation !== 0) return byRepresentation;
  const byPaths = compareStringArrays(left.workspacePaths, right.workspacePaths);
  if (byPaths !== 0) return byPaths;
  return compareByDeclaration(INSTANCE_STATE_ORDER, left.state, right.state);
}

function canonicalSourceInstances(
  sourceInstances: readonly SessionSourceInstance[]
): readonly SessionSourceInstance[] {
  return Object.freeze([...sourceInstances].sort(compareSourceInstances));
}

/** Create an opaque, operation-scoped reference without serializing a locator. */
export function createOpaqueOccurrenceRef<TLocator>(
  instance: PhysicalSessionInstance<TLocator>,
  payloadFingerprint: string,
  diagnosticContextId: string
): string {
  requireNonempty('Diagnostic context ID', diagnosticContextId);
  requireNonempty('Payload fingerprint', payloadFingerprint);
  return `occurrence:v1:${sha256CanonicalJsonV1({
    diagnosticContextId,
    instanceKey: instance.instanceKey,
    logicalSessionId: instance.logicalSessionId,
    sourceRole: instance.sourceRole,
    representation: instance.representation,
    fidelityTier: instance.fidelityTier,
    payloadFingerprint,
  })}`;
}

/**
 * Reconcile candidates already grouped into one role/representation/fidelity
 * tier. A single candidate remains lazy; competitors are hydrated only to
 * establish exact consumed-payload equivalence.
 */
export async function reconcileReplicaGroup<TLocator>(
  group: ReplicaGroup<TLocator>,
  options: ReconcileReplicaOptions = {}
): Promise<ReconciledReplicaGroup<TLocator>> {
  if (group.candidates.length === 0) {
    throw new TypeError('A replica group must contain at least one candidate.');
  }
  if (group.candidates.length === 1) {
    const selected = group.candidates[0]!;
    return Object.freeze({
      state: 'single',
      group,
      selected,
      fingerprints: Object.freeze([]),
      sourceInstances: canonicalSourceInstances([
        sourceInstanceProjection(selected, 'contributed'),
      ]),
      diagnosticOccurrences: Object.freeze([]),
    });
  }

  const hydrated: Array<ReplicaFingerprint<TLocator> & { payload: ReplicaConsumedPayload }> = [];
  for (const candidate of group.candidates) {
    if (!candidate.loadConsumedPayload) {
      throw new TypeError(
        `Replica candidate ${candidate.instanceKey} has no consumed-payload loader.`
      );
    }
    const payload = await candidate.loadConsumedPayload();
    hydrated.push(
      Object.freeze({
        instance: candidate,
        payload,
        fingerprint: fingerprintConsumedPayloadV1(payload),
      })
    );
  }

  const fingerprints = Object.freeze(
    hydrated.map(({ instance, fingerprint }) => Object.freeze({ instance, fingerprint }))
  );
  if (new Set(hydrated.map(({ fingerprint }) => fingerprint)).size === 1) {
    const selected = group.candidates[0]!;
    const selectedPayload = hydrated.find(({ instance }) => instance === selected)!.payload;
    return Object.freeze({
      state: 'equivalent',
      group,
      selected,
      selectedPayload,
      fingerprints,
      sourceInstances: canonicalSourceInstances(
        group.candidates.map((candidate) =>
          sourceInstanceProjection(
            candidate,
            candidate === selected ? 'contributed' : 'equivalent-replica'
          )
        )
      ),
      diagnosticOccurrences: Object.freeze([]),
    });
  }

  if (!options.diagnosticContextId) {
    throw new TypeError('A diagnosticContextId is required for divergent replica output.');
  }
  const diagnosticOccurrences = Object.freeze(
    hydrated
      .map(({ instance, fingerprint }) =>
        Object.freeze({
          instance,
          fingerprint,
          occurrenceRef: createOpaqueOccurrenceRef(
            instance,
            fingerprint,
            options.diagnosticContextId!
          ),
        })
      )
      .sort(
        (left, right) =>
          compareCodePoints(left.fingerprint, right.fingerprint) ||
          compareCodePoints(left.occurrenceRef, right.occurrenceRef)
      )
  );
  return Object.freeze({
    state: 'divergent',
    group,
    fingerprints,
    sourceInstances: Object.freeze([]),
    diagnosticOccurrences,
  });
}

/** Hydrate the deterministic representative selected by reconciliation. */
export async function hydrateSelectedReplica<TLocator>(
  reconciliation: ReconciledReplicaGroup<TLocator>
): Promise<ReplicaConsumedPayload> {
  if (reconciliation.state === 'divergent') {
    throw new SessionAmbiguityError(
      reconciliation.group.logicalSessionId,
      reconciliation.diagnosticOccurrences.map(({ occurrenceRef }) => occurrenceRef)
    );
  }
  if (reconciliation.selectedPayload) return reconciliation.selectedPayload;
  if (!reconciliation.selected.loadConsumedPayload) {
    throw new TypeError(
      `Selected replica ${reconciliation.selected.instanceKey} has no consumed-payload loader.`
    );
  }
  return reconciliation.selected.loadConsumedPayload();
}

function supersededInstances<TLocator>(
  groups: readonly ReplicaGroup<TLocator>[]
): SessionSourceInstance[] {
  return groups.flatMap((group) =>
    group.candidates.map((candidate) => sourceInstanceProjection(candidate, 'superseded'))
  );
}

export type ComposerArbitration<TLocator = unknown> =
  | { readonly state: 'absent'; readonly sourceInstances: readonly never[] }
  | {
      readonly state: 'ambiguous';
      readonly selectedTier: 'global-primary' | 'workspace-fallback';
      readonly reconciliation: Extract<ReconciledReplicaGroup<TLocator>, { state: 'divergent' }>;
      readonly sourceInstances: readonly never[];
    }
  | {
      readonly state: 'selected';
      readonly selectedTier: 'global-primary' | 'workspace-fallback';
      readonly resolutionState: ResolutionState;
      readonly reconciliation: Exclude<ReconciledReplicaGroup<TLocator>, { state: 'divergent' }>;
      readonly sourceInstances: readonly SessionSourceInstance[];
    };

/** Composer global-primary/workspace-fallback arbitration. */
export async function arbitrateComposerContribution<TLocator>(
  record: LogicalSessionCatalogRecord<TLocator>,
  options: ReconcileReplicaOptions = {}
): Promise<ComposerArbitration<TLocator>> {
  const globalGroups = record.replicaGroups.filter(
    (group) => group.representation === 'composer-global'
  );
  const workspaceGroups = record.replicaGroups.filter(
    (group) => group.representation === 'composer-workspace'
  );
  const selectedGroup = globalGroups[0] ?? workspaceGroups[0];
  if (!selectedGroup) {
    return Object.freeze({ state: 'absent', sourceInstances: Object.freeze([]) });
  }

  const selectedTier =
    selectedGroup.representation === 'composer-global'
      ? ('global-primary' as const)
      : ('workspace-fallback' as const);
  const reconciliation = await reconcileReplicaGroup(selectedGroup, options);
  if (reconciliation.state === 'divergent') {
    return Object.freeze({
      state: 'ambiguous',
      selectedTier,
      reconciliation,
      sourceInstances: Object.freeze([]),
    });
  }

  const unselectedGroups = [...globalGroups, ...workspaceGroups].filter(
    (group) => group !== selectedGroup
  );
  return Object.freeze({
    state: 'selected',
    selectedTier,
    resolutionState: selectedTier === 'workspace-fallback' ? 'partial' : selectedGroup.fidelityTier,
    reconciliation,
    sourceInstances: canonicalSourceInstances([
      ...reconciliation.sourceInstances,
      ...supersededInstances(unselectedGroups),
    ]),
  });
}

export interface StoreReplicaTierDecision {
  readonly representation: 'store-db' | 'store-transcript';
  readonly fidelityTier: ReplicaFidelityTier;
  /** Completeness already decided by the Store expectation state machine. */
  readonly resolutionState: ResolutionState;
}

export type StoreTierArbitration<TLocator = unknown> =
  | { readonly state: 'absent'; readonly sourceInstances: readonly never[] }
  | {
      readonly state: 'ambiguous';
      readonly decision: StoreReplicaTierDecision;
      readonly reconciliation: Extract<ReconciledReplicaGroup<TLocator>, { state: 'divergent' }>;
      readonly sourceInstances: readonly never[];
    }
  | {
      readonly state: 'selected';
      readonly decision: StoreReplicaTierDecision;
      readonly resolutionState: ResolutionState;
      readonly reconciliation: Exclude<ReconciledReplicaGroup<TLocator>, { state: 'divergent' }>;
      readonly sourceInstances: readonly SessionSourceInstance[];
    };

/**
 * Reconcile only the Store representation/fidelity tier selected by the
 * upstream Store expectation state machine. DB and transcript payloads are
 * never compared, merged, or used as fallback by this primitive.
 */
export async function arbitrateStoreReplicaTier<TLocator>(
  record: LogicalSessionCatalogRecord<TLocator>,
  decision: StoreReplicaTierDecision,
  options: ReconcileReplicaOptions = {}
): Promise<StoreTierArbitration<TLocator>> {
  const selectedGroup = record.replicaGroups.find(
    (group) =>
      group.representation === decision.representation &&
      group.fidelityTier === decision.fidelityTier
  );
  if (!selectedGroup) {
    return Object.freeze({ state: 'absent', sourceInstances: Object.freeze([]) });
  }

  const reconciliation = await reconcileReplicaGroup(selectedGroup, options);
  if (reconciliation.state === 'divergent') {
    return Object.freeze({
      state: 'ambiguous',
      decision: Object.freeze({ ...decision }),
      reconciliation,
      sourceInstances: Object.freeze([]),
    });
  }

  const unselectedGroups = record.replicaGroups.filter(
    (group) => group.sourceRole === 'store' && group !== selectedGroup
  );
  return Object.freeze({
    state: 'selected',
    decision: Object.freeze({ ...decision }),
    resolutionState: decision.resolutionState,
    reconciliation,
    sourceInstances: canonicalSourceInstances([
      ...reconciliation.sourceInstances,
      ...supersededInstances(unselectedGroups),
    ]),
  });
}

export interface AmbiguousSummaryProjectionOptions {
  readonly index: number;
  readonly indexScope: IndexScope;
  readonly indexWorkspacePath?: string;
}

/** Project one message-free, locator-free logical row for divergent replicas. */
export function projectAmbiguousSessionSummary<TLocator>(
  record: LogicalSessionCatalogRecord<TLocator>,
  divergences: readonly Extract<ReconciledReplicaGroup<TLocator>, { state: 'divergent' }>[],
  options: AmbiguousSummaryProjectionOptions
): AmbiguousSessionSummary {
  if (!Number.isSafeInteger(options.index) || options.index < 0) {
    throw new TypeError('Ambiguous summary index must be a non-negative safe integer.');
  }
  if (divergences.length === 0) {
    throw new TypeError('At least one divergent replica group is required.');
  }
  if (divergences.some(({ group }) => group.logicalSessionId !== record.id)) {
    throw new TypeError('Divergent groups must belong to the projected logical session.');
  }
  if (options.indexScope === 'workspace' && !options.indexWorkspacePath) {
    throw new TypeError('Workspace-scoped summaries require indexWorkspacePath.');
  }

  const diagnosticOccurrences = divergences
    .flatMap(({ diagnosticOccurrences: occurrences }) => occurrences)
    .sort(
      (left, right) =>
        compareCodePoints(left.fingerprint, right.fingerprint) ||
        compareCodePoints(left.occurrenceRef, right.occurrenceRef)
    );
  const sourceRoles = [...new Set(divergences.map(({ group }) => group.sourceRole))].sort(
    (left, right) => compareByDeclaration(SOURCE_ROLE_ORDER, left, right)
  );
  // Public set-like arrays use one canonical code-point order across summary,
  // diagnostic, and typed-error surfaces. Payload-fingerprint ordering remains
  // an internal reconciliation detail and must not leak into one adapter only.
  const diagnosticOccurrenceRefs = [
    ...new Set(diagnosticOccurrences.map(({ occurrenceRef }) => occurrenceRef)),
  ].sort(compareCodePoints);
  Object.freeze(sourceRoles);
  Object.freeze(diagnosticOccurrenceRefs);
  return Object.freeze({
    id: record.id,
    index: options.index,
    indexScope: options.indexScope,
    ...(options.indexWorkspacePath
      ? { indexWorkspacePath: normalizeWorkspacePath(options.indexWorkspacePath) }
      : {}),
    resolutionState: 'ambiguous',
    sourceRoles,
    occurrenceCount: diagnosticOccurrences.length,
    diagnosticOccurrenceRefs,
    ...(record.canonicalWorkspacePath
      ? { canonicalWorkspacePath: record.canonicalWorkspacePath }
      : {}),
    ...(record.matchedWorkspacePath ? { matchedWorkspacePath: record.matchedWorkspacePath } : {}),
  });
}

/** Convert a divergent result to the typed read failure used by adapters. */
export function sessionAmbiguityErrorFromReplicaGroup<TLocator>(
  divergence: Extract<ReconciledReplicaGroup<TLocator>, { state: 'divergent' }>
): SessionAmbiguityError {
  return new SessionAmbiguityError(
    divergence.group.logicalSessionId,
    divergence.diagnosticOccurrences.map(({ occurrenceRef }) => occurrenceRef)
  );
}
