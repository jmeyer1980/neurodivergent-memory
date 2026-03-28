#!/usr/bin/env pwsh
<#
.SYNOPSIS
Comprehensive MCP server smoke test: "Executive Function Support Network"

Tests all memory districts, tagging schema, connections, search, and graph traversal.
#>

$ErrorActionPreference = "Continue"

# Test scenario: Building an executive function support system
# This exercises all 5 memory districts in a cohesive narrative

$mcp_commands = @()

# ============================================================================
# PHASE 1: Memory Creation (All 5 Districts)
# ============================================================================

Write-Host "=== PHASE 1: Creating Memory Graph ===" -ForegroundColor Cyan

# District 1: logical_analysis - Root Cause Analysis
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 1
    method = "tools/call"
    params = @{
        name = "store_memory"
        arguments = @{
            content = "Executive dysfunction manifests as task initiation paralysis due to amygdala hyperactivity in response to task ambiguity. Works via time blindness (no dopamine gradient) + perfectionism (fear-based goal setting) + working memory load."
            district = "logical_analysis"
            tags = @("topic:adhd-executive-function", "scope:concept", "kind:insight", "layer:research")
            emotional_valence = 0
            intensity = 0.8
        }
    }
}

# District 2: emotional_processing - Emotional Impact
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 2
    method = "tools/call"
    params = @{
        name = "store_memory"
        arguments = @{
            content = "Cycle of shame: task avoidance → guilt accumulation → identity damage ('I'm lazy') → more amygdala activation → deeper avoidance. Breaks trust in self-efficacy. Recovery requires self-compassion checkpoint."
            district = "emotional_processing"
            tags = @("topic:adhd-shame-cycles", "scope:concept", "kind:pattern", "layer:implementation")
            emotional_valence = -1
            intensity = 0.9
        }
    }
}

# District 3: practical_execution - Action Strategy
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 3
    method = "tools/call"
    params = @{
        name = "store_memory"
        arguments = @{
            content = "Proven intervention: time-box planning (10 min chunks max) → break into micro-tasks → external deadline (accountability partner/calendar block) → dopamine reward (celebration) → build momentum habit."
            district = "practical_execution"
            tags = @("topic:adhd-strategies", "scope:project", "kind:pattern", "layer:implementation")
            emotional_valence = 1
            intensity = 0.7
        }
    }
}

# District 4: vigilant_monitoring - Risk Assessment
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 4
    method = "tools/call"
    params = @{
        name = "store_memory"
        arguments = @{
            content = "RISKS: (1) Perfectionism trap - setting unrealistic standards = paralysis renewal; (2) Dependency on external deadlines leads to crisis mode; (3) Shame spiral if setback occurs; (4) Over-commitment from hyperfocus enthusiasm."
            district = "vigilant_monitoring"
            tags = @("topic:adhd-risks", "scope:project", "kind:pattern", "layer:architecture")
            emotional_valence = -1
            intensity = 0.8
        }
    }
}

# District 5: creative_synthesis - Cross-Domain Insight
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 5
    method = "tools/call"
    params = @{
        name = "store_memory"
        arguments = @{
            content = "INSIGHT: ADHD executive dysfunction mirrors complex systems failure modes - insufficient feedback loops (time blindness = no state feedback), emergent unpredictability (task ambiguity = system chaos), and control cascade failure (perfectionism = over-regulation). Solutions: add external feedback, decompose chaos, enable iteration."
            district = "creative_synthesis"
            tags = @("topic:adhd-systems-thinking", "scope:concept", "kind:insight", "layer:architecture")
            emotional_valence = 1
            intensity = 0.9
        }
    }
}

# ============================================================================
# PHASE 2: Practical Memories (Implementation Details)
# ============================================================================

# Project-scoped working memory
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 6
    method = "tools/call"
    params = @{
        name = "store_memory"
        arguments = @{
            content = "CURRENT TASK: Ship neurodivergent-memory v0.1.1. Status: Release tests in progress. Dependencies: TypeScript build ✓, Docker image ✓, npm attestation ✓. Blocker: None. Deadline: EOD today. Next: PR merge + tag push."
            district = "practical_execution"
            tags = @("topic:project-neurodivergent-memory", "scope:session", "kind:task", "layer:implementation")
            emotional_valence = 1
            intensity = 0.6
        }
    }
}

# Dependency tracking
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 7
    method = "tools/call"
    params = @{
        name = "store_memory"
        arguments = @{
            content = "DEPENDENCY CHAIN: MCP protocol (stdio newline-delimited JSON) → Node.js runtime (v20 LTS) → TypeScript compilation → Docker containerization. Each layer has critical path implications."
            district = "vigilant_monitoring"
            tags = @("topic:project-neurodivergent-memory", "scope:project", "kind:decision", "layer:architecture")
            emotional_valence = 0
            intensity = 0.7
        }
    }
}

# Session-scoped debugging note
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 8
    method = "tools/call"
    params = @{
        name = "store_memory"
        arguments = @{
            content = "DEBUGGING: Previous session - GitHub PAT auth issue resolved by moving token to Windows User env scope (not terminal session var). Lesson: persistent env vars must be machine/user scoped, not process-local."
            district = "logical_analysis"
            tags = @("topic:devops-github-mcp", "scope:session", "kind:decision", "layer:debugging")
            emotional_valence = 0
            intensity = 0.5
        }
    }
}

# ============================================================================
# PHASE 3: Memory Connections (Build Graph)
# ============================================================================

Write-Host "=== PHASE 2: Building Memory Connections ===" -ForegroundColor Cyan

# Connect root cause to emotional impact
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 9
    method = "tools/call"
    params = @{
        name = "connect_memories"
        arguments = @{
            memory_id_1 = "mem_1"
            memory_id_2 = "mem_2"
            bidirectional = $true
        }
    }
}

# Connect risk monitoring to intervention strategy
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 10
    method = "tools/call"
    params = @{
        name = "connect_memories"
        arguments = @{
            memory_id_1 = "mem_4"
            memory_id_2 = "mem_3"
            bidirectional = $true
        }
    }
}

# Connect systems thinking to practical execution
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 11
    method = "tools/call"
    params = @{
        name = "connect_memories"
        arguments = @{
            memory_id_1 = "mem_5"
            memory_id_2 = "mem_3"
            bidirectional = $true
        }
    }
}

# ============================================================================
# PHASE 4: Search and Retrieval Tests
# ============================================================================

Write-Host "=== PHASE 3: Testing Search & Retrieval ===" -ForegroundColor Cyan

# BM25 search - should find memories about ADHD strategies
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 12
    method = "tools/call"
    params = @{
        name = "search_memories"
        arguments = @{
            query = "time blindness dopamine task initiation"
            min_score = 0.1
        }
    }
}

# Filtered search - only practical execution district
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 13
    method = "tools/call"
    params = @{
        name = "search_memories"
        arguments = @{
            query = "intervention strategy"
            district = "practical_execution"
            min_score = 0.1
        }
    }
}

# Tag-based search
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 14
    method = "tools/call"
    params = @{
        name = "search_memories"
        arguments = @{
            query = "perfectionism risk"
            tag = "topic:adhd-risks"
            min_score = 0.05
        }
    }
}

# ============================================================================
# PHASE 5: Memory Updates & Mutations
# ============================================================================

Write-Host "=== PHASE 4: Testing Updates & Mutations ===" -ForegroundColor Cyan

# Update memory with new information (add new risk discovered)
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 15
    method = "tools/call"
    params = @{
        name = "update_memory"
        arguments = @{
            memory_id = "mem_4"
            new_content = "RISKS: (1) Perfectionism trap - setting unrealistic standards = paralysis renewal; (2) Dependency on external deadlines leads to crisis mode; (3) Shame spiral if setback occurs; (4) Over-commitment from hyperfocus enthusiasm; (5) NEW: Burnout from unsustainable deadline-driven cycles."
            new_intensity = 9
        }
    }
}

# List all memories to verify population
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 16
    method = "tools/call"
    params = @{
        name = "list_memories"
        arguments = @{
            page_size = 50
            page = 1
        }
    }
}

# Memory statistics
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 17
    method = "tools/call"
    params = @{
        name = "memory_stats"
        arguments = @{}
    }
}

# ============================================================================
# PHASE 6: Graph Traversal & Associative Retrieval
# ============================================================================

Write-Host "=== PHASE 5: Testing Graph Traversal ===" -ForegroundColor Cyan

# Traverse from root cause analysis (2-hop radius)
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 18
    method = "tools/call"
    params = @{
        name = "traverse_from"
        arguments = @{
            memory_id = "mem_1"
            depth = 2
        }
    }
}

# Related memories to practical execution strategy
$mcp_commands += @{
    jsonrpc = "2.0"
    id = 19
    method = "tools/call"
    params = @{
        name = "related_to"
        arguments = @{
            memory_id = "mem_3"
        }
    }
}

# ============================================================================
# Send all commands as newline-delimited JSON to MCP server
# ============================================================================

Write-Host "`n=== Sending Smoke Test Commands to MCP Server ===" -ForegroundColor Green

foreach ($cmd in $mcp_commands) {
    $json = $cmd | ConvertTo-Json -Depth 10 -Compress
    Write-Host "→ [$(Get-Date -Format 'HH:mm:ss.fff')] Sending: $($cmd.method) (id=$($cmd.id))"
    Write-Output $json
}

Write-Host "`n$($mcp_commands.Count) commands sent successfully" -ForegroundColor Green
Write-Host "MCP server consuming input stream..." -ForegroundColor Cyan
