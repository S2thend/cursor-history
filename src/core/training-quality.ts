/** Aggregate quality signals; descriptive counters, never automatic filtering. */
export interface TrainingQuality {
  /** Read sessions explicitly marked partial by source resolution. */
  partialSourceSessions: number;
  /** Read sessions with no explicit complete/partial resolution state. */
  unknownSourceSessions: number;
  emittedRecords: number;
  droppedSegments: number;
  /** All following counters cover emitted records only. */
  toolCalls: number;
  failedToolCalls: number;
  cancelledToolCalls: number;
  missingToolResults: number;
  truncatedUserMessages: number;
  truncatedToolResults: number;
  truncatedSystemPrompts: number;
}

/** Create an independent empty quality tally. */
export function createTrainingQuality(): TrainingQuality {
  return {
    partialSourceSessions: 0,
    unknownSourceSessions: 0,
    emittedRecords: 0,
    droppedSegments: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    cancelledToolCalls: 0,
    missingToolResults: 0,
    truncatedUserMessages: 0,
    truncatedToolResults: 0,
    truncatedSystemPrompts: 0,
  };
}

/** Add one session/segment tally into the export tally in place. */
export function addTrainingQuality(target: TrainingQuality, source: TrainingQuality): void {
  for (const key of Object.keys(target) as (keyof TrainingQuality)[]) target[key] += source[key];
}
