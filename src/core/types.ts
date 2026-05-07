export type MemoryArchetype = "scholar" | "merchant" | "mystic" | "guard";

export type EpistemicStatus = "draft" | "validated" | "outdated";

export type KanbanStatus = "backlog" | "ready" | "in_progress" | "blocked" | "done";

/**
 * Lifecycle state for task publication workflow.
 * Tracks the publish → resume → close boundary for agent-driven tasks.
 */
export type TaskPublicationState =
  | "draft"
  | "published_partial"
  | "published_complete"
  | "resumable"
  | "closable"
  | "closed";

export type EpistemicStatusFilter = EpistemicStatus | "unset";

export type VisibilityLevel = "private" | "shared" | "global";

export interface MemoryNPC {
  id: string;
  name: string;
  archetype: MemoryArchetype;
  agent_id?: string;
  project_id?: string;
  session_id?: string;
  district: string;
  content: string;
  traits: string[];
  concerns: string[];
  connections: string[];
  tags: string[];
  created: Date;
  last_accessed: Date;
  access_count: number;
  emotional_valence?: number;
  intensity?: number;
  abstracted_from?: string;
  epistemic_status?: EpistemicStatus;
  repeat_write_count?: number;
  repeat_count?: number;
  last_similarity_score?: number;
  ping_pong_counter?: number;
  status?: KanbanStatus;
  current_slice?: string;
  why_now?: string;
  visibility?: VisibilityLevel;
  /** Task publication lifecycle state: draft → published_partial | published_complete; published_complete → resumable | closable; resumable → published_partial | published_complete; closable → closed. */
  publication_state?: TaskPublicationState;
  /** Last successfully completed publication step (e.g. "pr_created", "reviewer_requested"). */
  last_publication_step?: string;
}

export interface DistilledArtifact {
  signals: string[];
  triggers: string[];
  constraints: string[];
  next_actions: string[];
  risk_flags: string[];
  abstracted_from: string;
}
