import { createServer } from "node:http";
import { AiError, createAi, createDemoAi, MetaModelAdapter, MuseVoiceTranscriber, metaApiKey, type Ai } from "@stage-ready/ai";
import { WorkerEnv, loadRootEnv, parseEnv } from "@stage-ready/config";
import { startTelemetry } from "@stage-ready/config/telemetry";
import { createDb, projects } from "@stage-ready/db";
import { JobPayload, QUEUE_NAME, cancelKey, type JobProgress } from "@stage-ready/shared";
import { Queue, Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import IORedis from "ioredis";
import pino from "pino";
import { eventIngest } from "./jobs/event-ingest";
import { describeModelError, repoDigest } from "./jobs/repo-digest";
import { questionBank, renderSlides } from "./jobs/qa-kit";
import { sessionReview } from "./jobs/session-review";
import { render, takeProcess } from "./jobs/takes";
import { winners } from "./jobs/winners";
import { UserFacingError, type JobContext } from "./lib/context";
import { warmDemoVoice } from "./lib/demo-voice";
import { createStorage } from "./lib/s3";

loadRootEnv();
const env = parseEnv("worker", WorkerEnv);
await startTelemetry("stage-ready-worker");
const logger = pino({ name: "worker", level: env.LOG_LEVEL });
const db = createDb(env.DATABASE_URL);
const storage = createStorage(env, logger);
const live = createAi(env, logger);
const mock = createAi(env, logger, { forceMock: true });
logger.info({ models: live.mode, reason: live.reason }, live.mode === "meta" ? "using the Meta Model API" : "using mocked model adapters");
if (live.llm instanceof MetaModelAdapter) {
  const check = await live.llm.verifyModels();
  logger.info(check.checked ? "configured model IDs confirmed by the model listing" : "the API has no model listing; skipped the model ID check");
}

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
// Demo Mode: real models within the daily demo allowance (counted in Redis across services), else mocks.
const demo = createDemoAi(env, live, mock, connection, logger);

// Muse Voice Transcribe on the bundled Demo Mode recording, once per recording, when Demo Mode runs on real models.
const demoLive = !env.MODEL_MOCK && (env.DEMO_LIVE_MODELS ?? env.NODE_ENV === "production");
const voiceKey = metaApiKey(env);
if (demoLive && voiceKey && env.META_API_BASE_URL && env.MODEL_TRANSCRIBE !== "none") {
  const transcriber = new MuseVoiceTranscriber({ baseUrl: env.META_API_BASE_URL, apiKey: voiceKey, model: env.MODEL_TRANSCRIBE });
  void warmDemoVoice({ redis: connection, transcriber, logger });
}

const aiFor = async (projectId: string): Promise<Ai> => {
  const [project] = await db.select({ demoMode: projects.demoMode }).from(projects).where(eq(projects.id, projectId));
  return project?.demoMode ? demo : live;
};
const followUps = new Queue(QUEUE_NAME, { connection, defaultJobOptions: { attempts: 1, removeOnComplete: { age: 86_400, count: 500 }, removeOnFail: { age: 7 * 86_400 } } });

const worker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    const payload = JobPayload.parse({ ...job.data, name: job.name });
    const ctx: JobContext = {
      env,
      db,
      storage,
      logger: logger.child({ jobId: job.id, job: job.name, projectId: payload.projectId }),
      aiFor,
      // Cancellation is cooperative: each progress update checks the cancel flag.
      progress: async (update: JobProgress) => {
        if (job.id && (await connection.get(cancelKey(job.id)))) throw new UserFacingError("Cancelled.");
        await job.updateProgress(update);
      },
      enqueue: async (next) => {
        const { name, ...data } = JobPayload.parse(next);
        await followUps.add(name, data);
      },
    };
    try {
      switch (payload.name) {
        case "event-ingest":
          return await eventIngest(payload, ctx);
        case "winners":
          return await winners(payload, ctx);
        case "repo-digest":
          return await repoDigest(payload, ctx);
        case "session-review":
          return await sessionReview(payload, ctx);
        case "take-process":
          return await takeProcess(payload, ctx);
        case "render":
          return await render(payload, ctx);
        case "questions":
          return await questionBank(payload, ctx);
        case "slides":
          return await renderSlides(payload, ctx);
      }
    } catch (error) {
      ctx.logger.error({ err: error, detail: error instanceof AiError ? error.detail : undefined }, "job failed");
      if (error instanceof UserFacingError) throw error;
      // Model errors carry the API's own explanation, so the job's failure reason says what went wrong.
      throw new Error(`${payload.name} failed: ${describeModelError(error)}`);
    }
  },
  { connection, concurrency: 4 },
);
worker.on("completed", (job) => logger.info({ jobId: job.id, job: job.name }, "job completed"));

const health = createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(worker.isRunning() ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "worker", status: worker.isRunning() ? "ok" : "stopped", models: live.mode }));
    return;
  }
  res.writeHead(404).end();
});
health.listen(env.WORKER_HEALTH_PORT, () => logger.info(`worker listening on queue ${QUEUE_NAME}; health on :${env.WORKER_HEALTH_PORT}/api/health`));

const shutdown = async () => {
  await worker.close();
  await followUps.close();
  health.close();
  await connection.quit();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
