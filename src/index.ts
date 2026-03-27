#!/usr/bin/env node

/**
 * Neurodivergent Memory MCP Server
 *
 * A city-based memory system inspired by neurodivergent thinking patterns.
 * Uses FractalStat city simulation as metaphor where:
 * - Districts = Memory categories/knowledge domains
 * - NPCs = Individual memories/thoughts/concepts
 * - Relationships = Connections between thoughts
 * - Activities = Current mental processes
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Memory types representing different thought patterns
 */
type MemoryArchetype = "scholar" | "merchant" | "mystic" | "guard";

/**
 * Memory entity representing a stored thought/memory
 */
interface MemoryNPC {
  id: string;
  name: string;
  archetype: MemoryArchetype;
  district: string;
  content: string;
  traits: string[];
  concerns: string[];
  connections: string[]; // IDs of connected memories
  tags: string[];
  created: Date;
  last_accessed: Date;
  access_count: number;
  emotional_valence?: number; // -1 to 1, representing emotional charge
  intensity?: number; // 0-1, representing mental energy/importance
}

/**
 * Memory district representing a knowledge domain
 */
interface MemoryDistrict {
  name: string;
  description: string;
  archetype: MemoryArchetype;
  activities: string[];
  memories: string[]; // Memory NPC IDs
}

/**
 * Neurodivergent memory system
 */
class NeurodivergentMemory {
  private districts: { [key: string]: MemoryDistrict } = {};
  private memories: { [id: string]: MemoryNPC } = {};
  private nextMemoryId = 1;

  constructor() {
    this.initializeDistricts();
  }

  private initializeDistricts() {
    this.districts = {
      "logical_analysis": {
        name: "Logical Analysis District",
        description: "Structured thinking, problem solving, and analytical processes",
        archetype: "scholar",
        activities: ["analyzing", "categorizing", "hypothesizing", "researching"],
        memories: []
      },
      "emotional_processing": {
        name: "Emotional Processing District",
        description: "Feelings, emotional responses, and affective states",
        archetype: "mystic",
        activities: ["feeling", "processing", "reflecting", "expressing"],
        memories: []
      },
      "practical_execution": {
        name: "Practical Execution District",
        description: "Action-oriented thoughts, tasks, and implementation",
        archetype: "merchant",
        activities: ["planning", "executing", "organizing", "managing"],
        memories: []
      },
      "vigilant_monitoring": {
        name: "Vigilant Monitoring District",
        description: "Awareness, safety concerns, and protective thinking",
        archetype: "guard",
        activities: ["monitoring", "alerting", "protecting", "assessing"],
        memories: []
      },
      "creative_synthesis": {
        name: "Creative Synthesis District",
        description: "Novel connections, creative insights, and innovative thinking",
        archetype: "mystic",
        activities: ["connecting", "creating", "innovating", "synthesizing"],
        memories: []
      }
    };
  }

  storeMemory(content: string, district: string, tags: string[] = [], emotional_valence?: number, intensity = 0.5): MemoryNPC {
    if (!this.districts[district]) {
      throw new Error(`Unknown district: ${district}`);
    }

    const archetype = this.districts[district].archetype;
    const id = `memory_${this.nextMemoryId++}`;
    const name = this.generateMemoryName(archetype, content);

    const memory: MemoryNPC = {
      id,
      name,
      archetype,
      district,
      content,
      traits: this.generateTraits(archetype),
      concerns: this.generateConcerns(archetype),
      connections: [],
      tags,
      created: new Date(),
      last_accessed: new Date(),
      access_count: 1,
      emotional_valence,
      intensity
    };

    this.memories[id] = memory;
    this.districts[district].memories.push(id);

    return memory;
  }

  retrieveMemory(id: string): MemoryNPC | null {
    const memory = this.memories[id];
    if (memory) {
      memory.last_accessed = new Date();
      memory.access_count++;
    }
    return memory || null;
  }

  connectMemories(memoryId1: string, memoryId2: string, bidirectional = true) {
    if (!this.memories[memoryId1] || !this.memories[memoryId2]) {
      throw new Error("Memory not found");
    }

    if (!this.memories[memoryId1].connections.includes(memoryId2)) {
      this.memories[memoryId1].connections.push(memoryId2);
    }

    if (bidirectional && !this.memories[memoryId2].connections.includes(memoryId1)) {
      this.memories[memoryId2].connections.push(memoryId1);
    }
  }

  searchMemories(query: string, district?: string, tags?: string[]): MemoryNPC[] {
    let candidates = Object.values(this.memories);

    if (district) {
      candidates = candidates.filter(m => m.district === district);
    }

    if (tags && tags.length > 0) {
      candidates = candidates.filter(m =>
        tags.some(tag => m.tags.includes(tag))
      );
    }

    return candidates.filter(m =>
      m.content.toLowerCase().includes(query.toLowerCase()) ||
      m.name.toLowerCase().includes(query.toLowerCase()) ||
      m.tags.some(tag => tag.toLowerCase().includes(query.toLowerCase()))
    );
  }

  getDistrictMemories(district: string): MemoryNPC[] {
    if (!this.districts[district]) {
      return [];
    }
    return this.districts[district].memories.map(id => this.memories[id]).filter(Boolean);
  }

  getConnectedMemories(memoryId: string): MemoryNPC[] {
    const memory = this.memories[memoryId];
    if (!memory) return [];

    return memory.connections
      .map(id => this.memories[id])
      .filter(Boolean);
  }

  private generateMemoryName(archetype: MemoryArchetype, content: string): string {
    const prefixes = {
      scholar: ["Analytical", "Logical", "Research", "Study"],
      merchant: ["Practical", "Action", "Task", "Execution"],
      mystic: ["Emotional", "Intuitive", "Creative", "Reflective"],
      guard: ["Vigilant", "Protective", "Alert", "Monitoring"]
    };

    const prefix = prefixes[archetype][Math.floor(Math.random() * prefixes[archetype].length)];
    const words = content.split(' ').slice(0, 2).join(' ');
    return `${prefix} ${words || 'Memory'}`;
  }

  private generateTraits(archetype: MemoryArchetype): string[] {
    const traitSets = {
      scholar: ["analytical", "methodical", "curious", "precise"],
      merchant: ["practical", "efficient", "organized", "goal-oriented"],
      mystic: ["intuitive", "emotional", "creative", "reflective"],
      guard: ["vigilant", "protective", "alert", "responsible"]
    };
    return traitSets[archetype].slice(0, 2);
  }

  private generateConcerns(archetype: MemoryArchetype): string[] {
    const concernSets = {
      scholar: ["accuracy", "understanding", "knowledge", "logic"],
      merchant: ["efficiency", "results", "resources", "timelines"],
      mystic: ["emotions", "connections", "meaning", "expression"],
      guard: ["safety", "risks", "boundaries", "protection"]
    };
    return concernSets[archetype].slice(0, 2);
  }

  getAllDistricts(): MemoryDistrict[] {
    return Object.values(this.districts);
  }

  getAllMemories(): MemoryNPC[] {
    return Object.values(this.memories);
  }
}

// Global memory system instance
const memorySystem = new NeurodivergentMemory();

/**
 * Create an MCP server with capabilities for resources (to list/read notes),
 * tools (to create new notes), and prompts (to summarize notes).
 */
const server = new Server(
  {
    name: "FractalStatMemory",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
      prompts: {},
    },
  }
);

/**
 * Handler for listing available memory districts and memories as resources.
 * Exposes districts and individual memories as explorable resources.
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const resources = [];

  // Add district resources
  for (const district of memorySystem.getAllDistricts()) {
    resources.push({
      uri: `memory://district/${district.name.toLowerCase().replace(/\s+/g, '_')}`,
      mimeType: "application/json",
      name: district.name,
      description: district.description
    });
  }

  // Add individual memory resources
  for (const memory of memorySystem.getAllMemories()) {
    resources.push({
      uri: `memory://memory/${memory.id}`,
      mimeType: "application/json",
      name: memory.name,
      description: `${memory.archetype} memory: ${memory.content.substring(0, 50)}...`
    });
  }

  return { resources };
});

/**
 * Handler for reading district and memory contents.
 * Returns detailed information about districts and memories.
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const url = new URL(request.params.uri);

  if (url.protocol === 'memory:' && url.pathname.startsWith('/district/')) {
    const districtKey = url.pathname.replace('/district/', '').replace(/_/g, ' ');
    const districts = memorySystem.getAllDistricts();
    const district = districts.find(d => d.name.toLowerCase() === districtKey.toLowerCase());

    if (!district) {
      throw new Error(`District not found: ${districtKey}`);
    }

    // Map district display names back to internal keys
    const districtKeyMap: { [key: string]: string } = {
      "logical analysis district": "logical_analysis",
      "emotional processing district": "emotional_processing",
      "practical execution district": "practical_execution",
      "vigilant monitoring district": "vigilant_monitoring",
      "creative synthesis district": "creative_synthesis"
    };

    const internalKey = districtKeyMap[districtKey.toLowerCase()] || districtKey;
    const memories = memorySystem.getDistrictMemories(internalKey);

    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify({
          district,
          memory_count: memories.length,
          memories: memories.map(m => ({
            id: m.id,
            name: m.name,
            archetype: m.archetype,
            tags: m.tags,
            created: m.created,
            access_count: m.access_count
          }))
        }, null, 2)
      }]
    };
  }

  if (url.protocol === 'memory:' && url.pathname.startsWith('/memory/')) {
    const memoryId = url.pathname.replace('/memory/', '');
    const memory = memorySystem.retrieveMemory(memoryId);

    if (!memory) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    const connectedMemories = memorySystem.getConnectedMemories(memoryId);

    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify({
          ...memory,
          connected_memories: connectedMemories.map(m => ({
            id: m.id,
            name: m.name,
            archetype: m.archetype,
            district: m.district
          }))
        }, null, 2)
      }]
    };
  }

  throw new Error(`Invalid URI: ${request.params.uri}`);
});

/**
 * Handler that lists available memory tools.
 * Exposes tools for storing, retrieving, connecting, and searching memories.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "store_memory",
        description: "Store a new memory in a specific district of the neurodivergent mind",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The memory content/thought to store"
            },
            district: {
              type: "string",
              enum: ["logical_analysis", "emotional_processing", "practical_execution", "vigilant_monitoring", "creative_synthesis"],
              description: "Memory district to store in"
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tags for categorization"
            },
            emotional_valence: {
              type: "number",
              minimum: -1,
              maximum: 1,
              description: "Emotional charge (-1 to 1)"
            },
            intensity: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Mental energy/importance (0-1)"
            }
          },
          required: ["content", "district"]
        }
      },
      {
        name: "retrieve_memory",
        description: "Retrieve a specific memory by ID",
        inputSchema: {
          type: "object",
          properties: {
            memory_id: {
              type: "string",
              description: "ID of the memory to retrieve"
            }
          },
          required: ["memory_id"]
        }
      },
      {
        name: "connect_memories",
        description: "Create connections between memories (like neural pathways)",
        inputSchema: {
          type: "object",
          properties: {
            memory_id_1: {
              type: "string",
              description: "First memory ID"
            },
            memory_id_2: {
              type: "string",
              description: "Second memory ID"
            },
            bidirectional: {
              type: "boolean",
              description: "Whether connection goes both ways",
              default: true
            }
          },
          required: ["memory_id_1", "memory_id_2"]
        }
      },
      {
        name: "search_memories",
        description: "Search for memories by content, district, or tags",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query"
            },
            district: {
              type: "string",
              enum: ["logical_analysis", "emotional_processing", "practical_execution", "vigilant_monitoring", "creative_synthesis"],
              description: "Optional district filter"
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tag filters"
            }
          },
          required: ["query"]
        }
      }
    ]
  };
});

/**
 * Handler for memory tools.
 * Implements storing, retrieving, connecting, and searching memories.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "store_memory": {
      const { content, district, tags = [], emotional_valence, intensity = 0.5 } = request.params.arguments as any;

      try {
        const memory = memorySystem.storeMemory(content, district, tags, emotional_valence, intensity);
        return {
          content: [{
            type: "text",
            text: `🧠 Stored memory "${memory.name}" in ${memorySystem.getAllDistricts().find(d => d.name.toLowerCase().replace(/\s+/g, '_') === district)?.name || district}\nID: ${memory.id}\nArchetype: ${memory.archetype}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to store memory: ${error}`
          }],
          isError: true
        };
      }
    }

    case "retrieve_memory": {
      const { memory_id } = request.params.arguments as any;
      const memory = memorySystem.retrieveMemory(memory_id);

      if (!memory) {
        return {
          content: [{
            type: "text",
            text: `❌ Memory not found: ${memory_id}`
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: `🧠 Retrieved memory "${memory.name}"\nDistrict: ${memory.district}\nContent: ${memory.content}\nTags: ${memory.tags.join(', ')}\nAccess count: ${memory.access_count}`
        }]
      };
    }

    case "connect_memories": {
      const { memory_id_1, memory_id_2, bidirectional = true } = request.params.arguments as any;

      try {
        memorySystem.connectMemories(memory_id_1, memory_id_2, bidirectional);
        return {
          content: [{
            type: "text",
            text: `🔗 Connected memories ${memory_id_1} and ${memory_id_2}${bidirectional ? ' (bidirectional)' : ' (unidirectional)'}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to connect memories: ${error}`
          }],
          isError: true
        };
      }
    }

    case "search_memories": {
      const { query, district, tags } = request.params.arguments as any;
      const results = memorySystem.searchMemories(query, district, tags);

      if (results.length === 0) {
        return {
          content: [{
            type: "text",
            text: `🔍 No memories found matching query: "${query}"`
          }]
        };
      }

      const resultText = results.map(memory =>
        `• ${memory.name} (${memory.archetype}) - ${memory.content.substring(0, 50)}...`
      ).join('\n');

      return {
        content: [{
          type: "text",
          text: `🔍 Found ${results.length} memories:\n${resultText}`
        }]
      };
    }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

/**
 * Handler that lists available prompts.
 * Exposes prompts for memory exploration and synthesis.
 */
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "explore_memory_city",
        description: "Explore the neurodivergent memory city and its districts",
      },
      {
        name: "synthesize_memories",
        description: "Create new insights by connecting existing memories",
      }
    ]
  };
});

/**
 * Handler for memory exploration prompts.
 */
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  switch (request.params.name) {
    case "explore_memory_city": {
      const districts = memorySystem.getAllDistricts();
      const districtSummaries = districts.map(d => ({
        type: "resource" as const,
        resource: {
          uri: `memory://district/${d.name.toLowerCase().replace(/\s+/g, '_')}`,
          mimeType: "application/json",
          text: JSON.stringify(d, null, 2)
        }
      }));

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Welcome to your neurodivergent memory city! Here are the districts where your thoughts reside:"
            }
          },
          ...districtSummaries.map(district => ({
            role: "user" as const,
            content: district
          })),
          {
            role: "user",
            content: {
              type: "text",
              text: "Explore these districts and understand how your mind organizes different types of thoughts. What patterns do you notice?"
            }
          }
        ]
      };
    }

    case "synthesize_memories": {
      const memories = memorySystem.getAllMemories().slice(0, 10); // Limit to recent memories
      const memoryResources = memories.map(memory => ({
        type: "resource" as const,
        resource: {
          uri: `memory://memory/${memory.id}`,
          mimeType: "application/json",
          text: JSON.stringify({
            name: memory.name,
            content: memory.content,
            archetype: memory.archetype,
            district: memory.district,
            tags: memory.tags
          }, null, 2)
        }
      }));

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Let's synthesize new insights from your stored memories. Here are some recent thoughts:"
            }
          },
          ...memoryResources.map(memory => ({
            role: "user" as const,
            content: memory
          })),
          {
            role: "user",
            content: {
              type: "text",
              text: "Looking at these memories, what new connections or insights emerge? How do they relate to each other?"
            }
          }
        ]
      };
    }

    default:
      throw new Error(`Unknown prompt: ${request.params.name}`);
  }
});

/**
 * Start the server using stdio transport.
 * This allows the server to communicate via standard input/output streams.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
