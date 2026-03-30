export type MemoryArchetype = "scholar" | "merchant" | "mystic" | "guard";

export type EpistemicStatus = "draft" | "validated" | "outdated";

export type EpistemicStatusFilter = EpistemicStatus | "unset";

export interface MemoryNPC {
  id: string;
  name: string;
  archetype: MemoryArchetype;
  agent_id?: string;
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
  repeat_count?: number;
  last_similarity_score?: number;
  ping_pong_counter?: number;
}

export interface DistilledArtifact {
  signals: string[];
  triggers: string[];
  constraints: string[];
  next_actions: string[];
  risk_flags: string[];
  abstracted_from: string;
}
