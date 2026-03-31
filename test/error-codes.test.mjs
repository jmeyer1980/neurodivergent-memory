import test from "node:test";
import assert from "node:assert/strict";

import {
  NM_ERRORS,
  asMcpErrorShape,
  createNMError,
  formatMcpError,
  formatMcpErrorText,
  mcpErrorResult,
} from "../build/core/error-codes.js";

test("preserves code and recovery for NMError instances", () => {
  const error = createNMError(
    NM_ERRORS.UNKNOWN_DISTRICT,
    "Unknown district: liminal_space",
    "Use one of the configured districts.",
  );

  const normalized = asMcpErrorShape(
    error,
    formatMcpError(NM_ERRORS.INPUT_VALIDATION_FAILED, "fallback", "fallback"),
  );

  assert.deepEqual(normalized, {
    code: NM_ERRORS.UNKNOWN_DISTRICT,
    message: "Unknown district: liminal_space",
    recovery: "Use one of the configured districts.",
  });
});

test("uses fallback code for generic errors while preserving message", () => {
  const normalized = asMcpErrorShape(
    new Error("boom"),
    formatMcpError(
      NM_ERRORS.PERSISTENCE_WRITE_FAILED,
      "Persistence write failed.",
      "Check disk permissions and retry.",
    ),
  );

  assert.deepEqual(normalized, {
    code: NM_ERRORS.PERSISTENCE_WRITE_FAILED,
    message: "boom",
    recovery: "Check disk permissions and retry.",
  });
});

test("formats MCP error results with code, message, and recovery", () => {
  const error = formatMcpError(
    NM_ERRORS.MEMORY_NOT_FOUND,
    "Memory not found: memory_404",
    "List or search memories first, then retry with a valid memory ID.",
  );

  assert.equal(
    formatMcpErrorText("Failed to retrieve memory", error),
    "❌ Failed to retrieve memory\nCode: NM_E004\nMessage: Memory not found: memory_404\nRecovery: List or search memories first, then retry with a valid memory ID.",
  );

  assert.deepEqual(mcpErrorResult("Failed to retrieve memory", error), {
    content: [{
      type: "text",
      text: "❌ Failed to retrieve memory\nCode: NM_E004\nMessage: Memory not found: memory_404\nRecovery: List or search memories first, then retry with a valid memory ID.",
    }],
    isError: true,
  });
});
