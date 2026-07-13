// src/core/package-info.ts
import * as fs from "fs";

export interface ServerPackageInfo {
  name: string;
  version: string;
}

export function resolveServerPackageInfo(packageJsonUrl: URL): ServerPackageInfo {
  try {
    const raw = fs.readFileSync(packageJsonUrl, "utf-8");
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    return {
      name: parsed.name ?? "neurodivergent-memory",
      version: parsed.version ?? "unknown",
    };
  } catch {
    return { name: "neurodivergent-memory", version: "unknown" };
  }
}
