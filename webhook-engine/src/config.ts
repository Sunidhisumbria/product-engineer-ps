import { z } from "zod";

const envSchema = z
  .object({
    DATABASE_URL: z.url().default("postgres://webhooks:webhooks@localhost:5433/webhooks"),
    PORT: z.coerce.number().int().positive().default(3000),
    WEBHOOK_URL: z.url().default("http://localhost:4000/webhook"),
    MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(1000),
    RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).default(30_000),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    LEASE_MS: z.coerce.number().int().positive().default(30_000),
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
    WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  })

  .refine((env) => env.LEASE_MS > env.REQUEST_TIMEOUT_MS * 2, {
    message: "LEASE_MS must be more than twice REQUEST_TIMEOUT_MS",
    path: ["LEASE_MS"],
  });

export type Config = {
  databaseUrl: string;
  port: number;
  webhookUrl: string;
  retry: RetryPolicy;
  worker: WorkerSettings;
};

export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type WorkerSettings = {
  requestTimeoutMs: number;
  leaseMs: number;
  pollIntervalMs: number;
  batchSize: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    webhookUrl: e.WEBHOOK_URL,
    retry: {
      maxAttempts: e.MAX_ATTEMPTS,
      baseDelayMs: e.RETRY_BASE_DELAY_MS,
      maxDelayMs: e.RETRY_MAX_DELAY_MS,
    },
    worker: {
      requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
      leaseMs: e.LEASE_MS,
      pollIntervalMs: e.POLL_INTERVAL_MS,
      batchSize: e.WORKER_BATCH_SIZE,
    },
  };
}
