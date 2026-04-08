function boundedLevenshteinDistance(left: string, right: string, maxDistance: number): number | undefined {
  if (Math.abs(left.length - right.length) > maxDistance) {
    return undefined;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMin = current[0];

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const value = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }

    if (rowMin > maxDistance) {
      return undefined;
    }

    previous = current;
  }

  return previous[right.length] <= maxDistance ? previous[right.length] : undefined;
}

function normalizeToolName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function suggestToolName(tools: { name: string }[], query: string): string | undefined {
  const normalizedQuery = normalizeToolName(query);
  let bestMatch: string | undefined;
  let bestDistance = 3;

  for (const tool of tools) {
    const normalizedTool = normalizeToolName(tool.name);
    if (normalizedTool === normalizedQuery) {
      return tool.name;
    }

    const maxDistance = Math.max(normalizedQuery.length, normalizedTool.length) <= 4 ? 1 : 2;
    const distance = boundedLevenshteinDistance(normalizedQuery, normalizedTool, maxDistance);
    if (distance !== undefined && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = tool.name;
    }
  }

  return bestMatch;
}