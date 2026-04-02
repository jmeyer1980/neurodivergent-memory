export const NM_ERRORS = {
  STORAGE_PATH_NOT_WRITABLE: "NM_E001",
  WAL_CORRUPT_ENTRY: "NM_E002",
  SNAPSHOT_LOAD_FAILED: "NM_E003",
  MEMORY_NOT_FOUND: "NM_E004",
  UNKNOWN_DISTRICT: "NM_E005",
  PERSISTENCE_WRITE_FAILED: "NM_E006",
  BM25_INDEX_INCONSISTENCY: "NM_E007",
  // Reserved / unassigned codes kept for long-term stability of the NM_E001–NM_E030 range.
  RESERVED_008: "NM_E008",
  RESERVED_009: "NM_E009",
  WRITE_QUEUE_CAPACITY: "NM_E010",
  WIP_LIMIT_EXCEEDED: "NM_E011",
  CROSS_DISTRICT_COOLDOWN_ACTIVE: "NM_E012",
  RESERVED_013: "NM_E013",
  RESERVED_014: "NM_E014",
  RESERVED_015: "NM_E015",
  RESERVED_016: "NM_E016",
  RESERVED_017: "NM_E017",
  RESERVED_018: "NM_E018",
  RESERVED_019: "NM_E019",
  INPUT_VALIDATION_FAILED: "NM_E020",
  UNKNOWN_TOOL: "NM_E021",
  RESERVED_022: "NM_E022",
  RESERVED_023: "NM_E023",
  RESERVED_024: "NM_E024",
  RESERVED_025: "NM_E025",
  RESERVED_026: "NM_E026",
  RESERVED_027: "NM_E027",
  RESERVED_028: "NM_E028",
  RESERVED_029: "NM_E029",
  RESERVED_030: "NM_E030",
} as const;

export type NMErrorCode = (typeof NM_ERRORS)[keyof typeof NM_ERRORS];

export interface McpErrorShape {
  code: NMErrorCode;
  message: string;
  recovery: string;
}

export class NMError extends Error {
  readonly code: NMErrorCode;
  readonly recovery: string;

  constructor(code: NMErrorCode, message: string, recovery: string) {
    super(message);
    this.name = "NMError";
    this.code = code;
    this.recovery = recovery;
  }
}

export function formatMcpError(code: NMErrorCode, message: string, recovery: string): McpErrorShape {
  return {
    code,
    message,
    recovery,
  };
}

export function createNMError(code: NMErrorCode, message: string, recovery: string): NMError {
  return new NMError(code, message, recovery);
}

export function asMcpErrorShape(error: unknown, fallback: McpErrorShape): McpErrorShape {
  if (error instanceof NMError) {
    return formatMcpError(error.code, error.message, error.recovery);
  }

  if (error instanceof Error && error.message.trim()) {
    return formatMcpError(fallback.code, error.message, fallback.recovery);
  }

  return fallback;
}

export function formatMcpErrorText(summary: string, error: McpErrorShape): string {
  return `❌ ${summary}\nCode: ${error.code}\nMessage: ${error.message}\nRecovery: ${error.recovery}`;
}

export function mcpErrorResult(summary: string, error: McpErrorShape): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{
      type: "text",
      text: formatMcpErrorText(summary, error),
    }],
    isError: true,
  };
}
