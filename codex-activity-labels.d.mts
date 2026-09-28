export type ActivityCategory =
  | "read" | "search" | "listFiles" | "command" | "edit" | "image"
  | "imageGeneration" | "webSearch" | "tool" | "plan" | "unknown";

/** Codex action metadata, including unknown/future action types. Never executed. */
export interface CommandAction {
  readonly type: string;
  readonly cmd?: string;
  readonly name?: string;
  readonly path?: string | null;
  readonly query?: string | null;
}

/** Structurally compatible with the existing wire activity; no UI imports needed. */
export interface ActivityLike {
  readonly type: string;
  readonly status: string;
  readonly title?: string;
  readonly summary?: string;
  readonly input?: string;
  readonly output?: string;
  readonly exitCode?: string | number | null;
  /** Host-bounded JSON array string, or already parsed actions. Malformed JSON stays generic. */
  readonly commandActions?: string | readonly CommandAction[] | null;
}

export interface ActivityDescription {
  readonly title: string;
  readonly category: ActivityCategory;
}

export function describeActivity(activity: ActivityLike): ActivityDescription;
/** Supply latest snapshots, once per activity, in display order. Empty input returns "". */
export function summarizeActivities(activities: readonly ActivityLike[]): string;
