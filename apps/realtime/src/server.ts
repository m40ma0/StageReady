import websocket from "@fastify/websocket";
import { BudgetedLLM, MetaModelAdapter, MuseVoiceTranscriber, createAi, createDemoAi, metaApiKey } from "@stage-ready/ai";
import { RealtimeEnv, loadRootEnv, parseEnv, verifySessionToken } from "@stage-ready/config";
import { startTelemetry } from "@stage-ready/config/telemetry";
import { createDb, projects, sessions as sessionsTable } from "@stage-ready/db";
import { ClientMessage, QUEUE_NAME, type ServerMessage } from "@stage-ready/shared";
import { BinaryKind, decodeBinary, splitFramePayload } from "@stage-ready/shared/ws-binary";
import pino from "pino";
import { Queue } from "bullmq";
import Fastify, { LogController } from "fastify";
import IORedis from "ioredis";
import { eq } from "drizzle-orm";
import { DemoGuardSession, loadDemoGuardContext, type Sender } from "./demoguard/session";
import { loadContext } from "./session/context";
import { LiveSession } from "./session/live-session";
import { BudgetedTracker, HostedSamTracker, VisionTracker } from "./vision/tracker";

loadRootEnv();
const env = parseEnv("realtime", RealtimeEnv);
await startTelemetry("stage-ready-realtime");
const logger = pino({ name: "realtime", level: env.LOG_LEVEL });
// Session tokens travel in the WebSocket URL, so request logs carry the path only.
const app = Fastify({ loggerInstance: logger, logController: new LogController({ disableRequestLogging: true }) });
app.addHook("onResponse", async (req, reply) => {
  req.log.info({ method: req.method, path: req.url.split("?")[0], status: reply.statusCode }, "request");
});
await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
const db = createDb(env.DATABASE_URL);
const live = createAi(env, logger);
const mock = createAi(env, logger, { forceMock: true });
const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const demo = createDemoAi(env, live, mock, redis, logger);
app.log.info({ models: live.mode, reason: live.reason }, "model adapters ready");
// After each session the worker writes Coach Notes (Rehearsal Memory).
const jobs = new Queue(QUEUE_NAME, { connection: redis, defaultJobOptions: { attempts: 2, removeOnComplete: { age: 86_400 } } });
// Muse Voice Transcribe for final transcripts: needs a Meta key and base URL, and MODEL_TRANSCRIBE not "none".
const transcribeKey = metaApiKey(env);
const transcriber =
  !env.MODEL_MOCK && transcribeKey && env.META_API_BASE_URL && env.MODEL_TRANSCRIBE !== "none"
    ? new MuseVoiceTranscriber({ baseUrl: env.META_API_BASE_URL, apiKey: transcribeKey, model: env.MODEL_TRANSCRIBE })
    : null;

const onEnded = (projectId: string, sessionId: string) =>
  void jobs.add("session-review", { projectId, sessionId }).catch((error: unknown) => logger.error({ err: error }, "could not queue the session review"));

/** Live sessions survive a dropped connection for two minutes so the browser can reconnect and re-sync. */
const RECONNECT_GRACE_MS = 120_000;
type Entry = { kind: "rehearsal"; session: LiveSession; expiry: NodeJS.Timeout | null } | { kind: "demoguard"; session: DemoGuardSession; expiry: NodeJS.Timeout | null };
const sessions = new Map<string, Entry>();

app.get("/api/health", async () => ({ service: "realtime", status: "ok", sessions: sessions.size, models: live.mode }));

async function open(sid: string, pid: string): Promise<Entry | null> {
  const [row] = await db
    .select({ mode: sessionsTable.mode, demoMode: projects.demoMode })
    .from(sessionsTable)
    .innerJoin(projects, eq(projects.id, sessionsTable.projectId))
    .where(eq(sessionsTable.id, sid));
  if (!row) return null;
  // Hosted SAM 3.1 when configured. Demo Mode rehearsals and DemoGuard runs use it too when Demo Mode runs on the
  // real models, within the daily allowance; frame hashes and pixel checks still run alongside it.
  const key = metaApiKey(env);
  const hosted = env.MODEL_SAM && key && env.META_API_BASE_URL ? new HostedSamTracker({ baseUrl: env.META_API_BASE_URL, apiKey: key, model: env.MODEL_SAM }) : null;
  const tracker =
    hosted && !row.demoMode ? hosted : hosted && demo.llm instanceof BudgetedLLM ? new BudgetedTracker(hosted, demo.llm) : new VisionTracker(env.VISION_SERVICE_URL, env.VISION_SERVICE_TOKEN);
  if (row.mode === "demoguard") {
    const ctx = await loadDemoGuardContext(db, sid, pid, row.demoMode);
    if (!ctx || ctx.ended) return null;
    return {
      kind: "demoguard",
      session: new DemoGuardSession(ctx, {
        db,
        logger: logger.child({ sessionId: sid, demoguard: true }),
        tracker,
        // Muse Spark confirms expected-state mismatches on real projects; Demo Mode stays deterministic.
        vision: !ctx.demoMode && live.llm instanceof MetaModelAdapter ? live.llm : null,
        onEnded,
      }),
      expiry: null,
    };
  }
  const ctx = await loadContext(db, sid, pid);
  if (!ctx || ctx.ended) return null;
  const session = new LiveSession(ctx, {
    db,
    ai: ctx.demoMode ? demo : live,
    logger: logger.child({ sessionId: sid }),
    tracker,
    visionUrl: env.VISION_SERVICE_URL,
    visionToken: env.VISION_SERVICE_TOKEN,
    speechModelConfigured: Boolean(env.MODEL_STT),
    transcriber,
    onEnded,
  });
  return { kind: "rehearsal", session, expiry: null };
}

app.get("/ws", { websocket: true }, async (socket, req) => {
  const send: Sender = (message: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  // Hold messages that arrive while the token and session load, so none are dropped.
  const early: { data: Buffer; isBinary: boolean }[] = [];
  const hold = (data: Buffer, isBinary: boolean) => void early.push({ data, isBinary });
  socket.on("message", hold);
  const origin = req.headers.origin;
  // The companion is not a browser and sends no Origin; browsers must come from the web app.
  if (origin && !env.WEB_ORIGIN.includes(origin)) {
    send({ type: "error", code: "forbidden_origin", message: "This origin may not open a session." });
    return socket.close(4403);
  }
  const token = new URL(req.url, "http://localhost").searchParams.get("token") ?? "";
  let claims;
  try {
    claims = await verifySessionToken(token, env.REALTIME_JWT_SECRET);
  } catch {
    send({ type: "error", code: "unauthorized", message: "The session token is missing, invalid or expired. Start the session again." });
    return socket.close(4401);
  }

  let entry = sessions.get(claims.sid);
  if (!entry) {
    const opened = await open(claims.sid, claims.pid);
    if (!opened) {
      send({ type: "error", code: "session_not_found", message: "This session does not exist or has already ended." });
      return socket.close(4404);
    }
    entry = opened;
    sessions.set(claims.sid, entry);
  }
  const current = entry;
  if (current.expiry) clearTimeout(current.expiry);
  current.expiry = null;
  current.session.attach(send);

  const onMessage = (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      try {
        const { kind, timestampMs, payload } = decodeBinary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        if (kind === BinaryKind.audio) {
          if (current.kind === "rehearsal") current.session.audio(timestampMs, payload);
        } else {
          const { hash, jpeg } = splitFramePayload(payload);
          current.session.frame(timestampMs, hash, jpeg);
        }
      } catch (error) {
        send({ type: "error", code: "invalid_binary", message: (error as Error).message });
      }
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      return send({ type: "error", code: "invalid_json", message: "Message must be valid JSON." });
    }
    const parsed = ClientMessage.safeParse(raw);
    if (!parsed.success) return send({ type: "error", code: "invalid_message", message: parsed.error.issues[0]?.message ?? "Unknown message type." });
    if ((parsed.data.type === "session.start" || parsed.data.type === "session.end") && parsed.data.sessionId !== claims.sid)
      return send({ type: "error", code: "forbidden", message: "The token is for a different session." });
    const ended = parsed.data.type === "session.end" || (parsed.data.type === "demoguard.control" && parsed.data.action === "end");
    const handled = current.kind === "rehearsal" ? current.session.event(parsed.data) : current.session.event(parsed.data, send);
    handled.then(
      () => {
        if (ended) {
          sessions.delete(claims.sid);
          socket.close(1000);
        }
      },
      (error: unknown) => {
        app.log.error({ err: error }, "session event failed");
        send({ type: "error", code: "internal", message: "The realtime server could not handle that. Check its log." });
      },
    );
  };
  socket.off("message", hold);
  socket.on("message", onMessage);
  for (const m of early.splice(0)) onMessage(m.data, m.isBinary);

  socket.on("close", () => {
    if (!sessions.has(claims.sid)) return;
    if (current.kind === "demoguard") {
      current.session.detach(send);
      if (current.session.clients > 0) return;
    } else current.session.detach();
    current.expiry = setTimeout(() => {
      sessions.delete(claims.sid);
      void current.session.end().catch((error: unknown) => app.log.error({ err: error }, "could not finalise an abandoned session"));
    }, RECONNECT_GRACE_MS);
  });
});

await app.listen({ port: env.REALTIME_PORT, host: "0.0.0.0" });
