import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL,
  researchApiUrl: process.env.RESEARCH_API_URL ?? "http://localhost:8000",
  researchTimeoutMs: Number(process.env.RESEARCH_TIMEOUT_MS ?? 300_000),
  hypothesisLoopSafetyMaxTurns: Number(process.env.HYPOTHESIS_LOOP_SAFETY_MAX_TURNS ?? 12),
  jquantsBaseUrl: process.env.JQUANTS_BASE_URL,
  jquantsApiKey: process.env.JQUANTS_API_KEY || process.env.JQUANTS_API_TOKEN,
  jquantsIdToken: process.env.JQUANTS_ID_TOKEN,
  jquantsRefreshToken: process.env.JQUANTS_REFRESH_TOKEN,
  jquantsEmail: process.env.JQUANTS_EMAIL,
  jquantsPassword: process.env.JQUANTS_PASSWORD,
  purgeSampleDataOnStart: process.env.PURGE_SAMPLE_DATA_ON_START !== "false"
};
