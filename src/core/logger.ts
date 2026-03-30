import pino from "pino";

const destination = pino.destination({ fd: 2, sync: false });

export const logger = pino(
  {
    name: "neurodivergent-memory",
    level: process.env.NEURODIVERGENT_MEMORY_LOG_LEVEL ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  destination
);
