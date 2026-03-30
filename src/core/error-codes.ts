export const NM_ERRORS = {
  STORAGE_PATH_NOT_WRITABLE: "NM_E001",
  WAL_CORRUPT_ENTRY: "NM_E002",
  SNAPSHOT_LOAD_FAILED: "NM_E003",
  MEMORY_NOT_FOUND: "NM_E004",
  UNKNOWN_DISTRICT: "NM_E005",
  PERSISTENCE_WRITE_FAILED: "NM_E006",
  BM25_INDEX_INCONSISTENCY: "NM_E007",
  WRITE_QUEUE_CAPACITY: "NM_E010",
  WIP_LIMIT_EXCEEDED: "NM_E011",
  INPUT_VALIDATION_FAILED: "NM_E020",
} as const;

export type NMErrorCode = (typeof NM_ERRORS)[keyof typeof NM_ERRORS];

export function formatMcpError(code: NMErrorCode, message: string, recovery: string): {
  code: NMErrorCode;
  message: string;
  recovery: string;
} {
  return {
    code,
    message,
    recovery,
  };
}
