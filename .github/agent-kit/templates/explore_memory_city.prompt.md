---
name: explore_memory_city
description: Use when you want the agent to explore the neurodivergent-memory MCP server as a living memory city, inspect districts, and summarize what is currently stored.
argument-hint: Optional focus such as a topic, district, tag, or exploration goal
agent: agent
tools: [neurodivergent-memory/*]
---
You are exploring the neurodivergent-memory MCP server itself, not merely describing it.

Inputs:
- {{input}}: Optional focus for the exploration, such as a topic, district, tag, memory id, or a freeform goal like "show me what has been stored about release planning".

Goal:
Use the neurodivergent-memory MCP tools to literally explore the current memory graph as a "memory city" and report what you find.

Execution rules:
1. Prefer direct MCP exploration over codebase explanation.
2. Start by establishing current state with `memory_stats` or `list_memories`.
3. If {{input}} names a topic, tag, district, or question, use `search_memories` to find the most relevant entries.
4. If a specific memory looks central, use `related_to` or `traverse_from` to explore its neighborhood.
5. Treat districts as city neighborhoods. Explain what each visited district appears to contain based on actual stored memories.
6. If the memory city is sparse or empty, say so plainly and report the current counts instead of inventing structure.
7. If the current client exposes this prompt but does not provide the neurodivergent-memory MCP tools, stop and say that the prompt requires that MCP server to be connected in the current agent session.

Suggested workflow:
1. Call `memory_stats` to assess the overall city.
2. Call `list_memories` for a broad first pass when needed.
3. Call `search_memories` using {{input}} when a focus is provided.
4. Call `retrieve_memory`, `related_to`, or `traverse_from` to inspect important hubs.
5. Synthesize a readable tour of the city grounded in the actual results.

Output format:
- City status: <memory counts, district coverage, notable density>
- Tour route: <districts or memory hubs visited>
- Key findings: <major themes, patterns, or notable memories>
- Connections: <important relationships or clusters discovered>
- Gaps: <empty districts, thin areas, or unanswered questions>
- Next exploration: <1-3 concrete follow-up queries or paths>

Style:
- Be concrete and observational.
- Distinguish clearly between what was actually retrieved from memory tools and what is an interpretation.
- Keep the "memory city" framing, but ground every claim in MCP results.