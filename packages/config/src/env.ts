import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * One env value as a person meant it: trims spaces and a trailing \r (CRLF files), drops an unquoted inline
 * comment (`1500 # calls`), and strips one pair of matching surrounding quotes (`"https://…"`). An empty
 * result is undefined, so blank optional values count as unset. Non-strings pass through.
 */
export function clean(v: unknown): unknown {
  if (typeof v !== "string") return v;
  let s = v.replace(/\r$/, "").trim();
  const quote = s[0];
  if ((quote === '"' || quote === "'") && s.length >= 2) {
    const end = s.indexOf(quote, 1);
    // A quoted value keeps everything inside the quotes, including " #"; anything after the closing quote must be a comment.
    if (end > 0 && (end === s.length - 1 || /^\s+#/.test(s.slice(end + 1)))) return s.slice(1, end) === "" ? undefined : s.slice(1, end);
  }
  s = s.replace(/\s+#.*$/, "").trim();
  return s === "" ? undefined : s;
}

/** Cleans every value in `source`; `changed` lists the keys whose value had to be cleaned (never the values). */
export function cleanEnv(source: Record<string, string | undefined>): { env: Record<string, string | undefined>; changed: string[] } {
  const env: Record<string, string | undefined> = {};
  const changed: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    const cleaned = clean(value) as string | undefined;
    env[key] = cleaned;
    if (value !== undefined && value !== "" && cleaned !== value) changed.push(key);
  }
  return { env, changed };
}

const optionalString = z.preprocess(clean, z.string().optional());
const optionalUrl = z.preprocess(clean, z.string().url().optional());
/** Browser origins, comma-separated (e.g. the app's public host plus a region-specific alias); parsed to a list. */
const originList = z.preprocess(
  clean,
  z
    .string()
    .default("http://localhost:3000")
    .transform((v) =>
      v
        .split(",")
        .map((o) => o.trim().replace(/\/+$/, ""))
        .filter(Boolean),
    )
    .pipe(z.array(z.string().url()).min(1)),
);
const bool = z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() === "true" : v), z.boolean());

/** Loads the repo-root .env once (Node's built-in loader). Existing env vars win. */
export function loadRootEnv(start = process.cwd()): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      if (existsSync(candidate)) {
        process.loadEnvFile(candidate);
        return candidate;
      }
      return null;
    }
    dir = dirname(dir);
  }
  return null;
}

export const ModelEnv = z.object({
  /** Per-model price overrides, JSON: {"<model id>": {"inputPerMTok": 0.5, "outputPerMTok": 1.5}}. Meta's published prices are built in. */
  MODEL_PRICES: z.preprocess(clean, z.string().optional()),
  META_API_BASE_URL: optionalUrl,
  META_API_KEY: optionalString,
  /** Same key under the name the Meta provider config uses; META_API_KEY wins when both are set. */
  MODEL_API_KEY: optionalString,
  /** "responses" (POST /responses, the Meta Model API's interface) or "chat_completions" (POST /chat/completions). */
  META_API_STYLE: z.preprocess(clean, z.enum(["responses", "chat_completions"]).default("responses")),
  /** Reasoning settings for the Responses API. */
  /** Reasoning effort per model: Muse Spark serves live calls (judges, claims), so it defaults low; Muse Wonder does background work, so it defaults high. */
  META_REASONING_EFFORT_SPARK: z.preprocess(clean, z.enum(["none", "minimal", "low", "medium", "high", "max"]).default("low")),
  META_REASONING_EFFORT_WONDER: z.preprocess(clean, z.enum(["none", "minimal", "low", "medium", "high", "max"]).optional()),
  /** Older single setting; used for Muse Wonder when META_REASONING_EFFORT_WONDER is not set. */
  META_REASONING_EFFORT: z.preprocess(clean, z.enum(["none", "minimal", "low", "medium", "high", "max"]).optional()),
  META_REASONING_SUMMARY: z.preprocess(clean, z.enum(["auto", "concise", "detailed", "none"]).default("auto")),
  /** Ask for encrypted reasoning so a retry can continue from it without server-side storage. */
  META_REASONING_ENCRYPTED: z.preprocess(clean, bool.default(true)),
  MODEL_SPARK: optionalString,
  MODEL_WONDER: optionalString,
  MODEL_IMAGE: optionalString,
  /** SAM 3.1 hosted on the Meta Model API, for UI tracking without a local checkpoint. */
  MODEL_SAM: optionalString,
  MODEL_STT: optionalString,
  /** Muse Voice Transcribe writes each real rehearsal's final transcript after it ends (live captions stay on faster-whisper). Set "none" to turn it off. */
  MODEL_TRANSCRIBE: z.preprocess(clean, z.string().default("muse-voice-transcribe-1.0")),
  MODEL_TTS: optionalString,
  EMBED_MODEL: optionalString,
  EMBED_DIM: z.preprocess(clean, z.coerce.number().int().positive().optional()),
  /** How the adapter asks for JSON. Confirm what the API supports in its docs. */
  META_RESPONSE_FORMAT: z.preprocess(clean, z.enum(["json_schema", "json_object", "none"]).default("json_schema")),
  /** Force mocked model adapters (Demo Mode) even when keys are present. */
  MODEL_MOCK: z.preprocess(clean, bool.default(false)),
  /** Demo Mode projects call the real Meta models (scripted speech and fixtures stay). Defaults to true in production. */
  DEMO_LIVE_MODELS: z.preprocess(clean, bool.optional()),
  /** Daily cap on Demo Mode spend across all visitors, tracked from MODEL_PRICES; past it Demo Mode uses the mocks. */
  DEMO_DAILY_BUDGET_USD: z.preprocess(clean, z.coerce.number().nonnegative().default(5)),
  /** Daily cap on Demo Mode real model calls, which applies even when MODEL_PRICES has no price for a model. */
  DEMO_DAILY_CALL_LIMIT: z.preprocess(clean, z.coerce.number().int().nonnegative().default(1500)),
});

const BaseEnv = z
  .object({
    NODE_ENV: z.preprocess(clean, z.enum(["development", "test", "production"]).default("development")),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    S3_ENDPOINT: z.string().url(),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_REGION: z.preprocess(clean, z.string().default("us-east-1")),
    AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters."),
    LOG_LEVEL: z.preprocess(clean, z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info")),
    /** Take score weights as JSON, e.g. {"delivery":0.3,"coverage":0.3,"demoSuccess":0.2,"timeFit":0.2,"contradictedPenalty":0.15}. */
    TAKE_SCORE_WEIGHTS: z.preprocess(clean, z.string().optional()),
  })
  .merge(ModelEnv);

/** Values copied from .env.example that must never reach production. */
const PLACEHOLDER = /^replace-with-/;

function productionChecks(
  env: {
    NODE_ENV: string;
    AUTH_SECRET?: string;
    REALTIME_JWT_SECRET?: string;
    REALTIME_URL?: string;
    WEB_ORIGIN?: string[];
    VISION_SERVICE_URL?: string | undefined;
    VISION_SERVICE_TOKEN?: string | undefined;
  },
  ctx: z.RefinementCtx,
) {
  if (env.NODE_ENV !== "production") return;
  if (env.VISION_SERVICE_URL && !env.VISION_SERVICE_TOKEN)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["VISION_SERVICE_TOKEN"],
      message: "Set VISION_SERVICE_TOKEN in production (the same value as in the vision service's environment), so the vision service only serves Stage Ready.",
    });
  for (const key of ["AUTH_SECRET", "REALTIME_JWT_SECRET"] as const) {
    if (env[key] !== undefined && PLACEHOLDER.test(env[key]))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is still the .env.example placeholder. Generate one with: openssl rand -base64 32` });
  }
  if (env.REALTIME_URL?.startsWith("ws://"))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_URL"], message: "REALTIME_URL must use wss:// in production: browsers block ws:// from an https page." });
  if (env.WEB_ORIGIN?.some((o) => o.startsWith("http://localhost")))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["WEB_ORIGIN"], message: "Set WEB_ORIGIN to the deployed web app's origin, or the realtime server rejects every browser." });
}

export const WebEnv = BaseEnv.extend({
  AUTH_GITHUB_ID: optionalString,
  AUTH_GITHUB_SECRET: optionalString,
  DEV_AUTH_BYPASS: z.preprocess(clean, bool.default(false)),
  REALTIME_URL: z.string().url(),
  REALTIME_JWT_SECRET: z.string().min(16),
  /** Drill answers are transcribed by the vision service. */
  VISION_SERVICE_URL: optionalUrl,
  VISION_SERVICE_TOKEN: optionalString,
}).superRefine((env, ctx) => {
  if (!env.DEV_AUTH_BYPASS && (!env.AUTH_GITHUB_ID || !env.AUTH_GITHUB_SECRET)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["AUTH_GITHUB_ID"], message: "Set AUTH_GITHUB_ID and AUTH_GITHUB_SECRET, or DEV_AUTH_BYPASS=true for local use." });
  }
  if (env.DEV_AUTH_BYPASS && env.NODE_ENV === "production") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DEV_AUTH_BYPASS"], message: "DEV_AUTH_BYPASS must be false in production." });
  }
  productionChecks(env, ctx);
});
export type WebEnv = z.infer<typeof WebEnv>;

export const WorkerEnv = BaseEnv.extend({
  VISION_SERVICE_URL: z.preprocess(clean, z.string().url().optional()),
  VISION_SERVICE_TOKEN: z.preprocess(clean, z.string().optional()),
  WORKER_HEALTH_PORT: z.preprocess(clean, z.coerce.number().int().default(4100)),
  GITHUB_API_URL: z.preprocess(clean, z.string().url().default("https://api.github.com")),
  /** x264 preset for Director renders. */
  FFMPEG_PRESET: z.preprocess(clean, z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium"]).default("veryfast")),
}).superRefine(productionChecks);
export type WorkerEnv = z.infer<typeof WorkerEnv>;

export const RealtimeEnv = z
  .object({
    NODE_ENV: BaseEnv.shape.NODE_ENV,
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    REALTIME_PORT: z.preprocess(clean, z.coerce.number().int().default(4000)),
    REALTIME_JWT_SECRET: z.string().min(16),
    /** Browser origins allowed to open the WebSocket. */
    WEB_ORIGIN: originList,
    VISION_SERVICE_URL: optionalUrl,
    VISION_SERVICE_TOKEN: optionalString,
    LOG_LEVEL: BaseEnv.shape.LOG_LEVEL,
  })
  .merge(ModelEnv)
  .superRefine(productionChecks);
export type RealtimeEnv = z.infer<typeof RealtimeEnv>;

export const DbEnv = z.object({ DATABASE_URL: z.string().url() });

export class ConfigError extends Error {
  constructor(service: string, issues: z.ZodIssue[]) {
    super(`${service} configuration is invalid:\n${issues.map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`).join("\n")}\nCopy .env.example to .env and fill in the missing values.`);
    this.name = "ConfigError";
  }
}

/**
 * Validates `source` against `schema` after cleaning every value (see `clean`). Keys that needed cleaning
 * are named on stderr, without their values, so a stray quote or comment in a secret store is visible.
 */
export function parseEnv<S extends z.ZodTypeAny>(service: string, schema: S, source: NodeJS.ProcessEnv = process.env): z.infer<S> {
  const { env, changed } = cleanEnv(source);
  const relevant = schema instanceof z.ZodObject || schema instanceof z.ZodEffects ? changed.filter((k) => k in shapeOf(schema)) : changed;
  if (relevant.length) console.warn(`${service}: cleaned stray quotes, comments or spaces in ${relevant.join(", ")}`);
  const result = schema.safeParse(env);
  if (!result.success) throw new ConfigError(service, result.error.issues);
  return result.data;
}

/** The object shape behind a schema, through superRefine wrappers. */
function shapeOf(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodEffects) return shapeOf(schema.innerType());
  if (schema instanceof z.ZodObject) return schema.shape as Record<string, unknown>;
  return {};
}

export type ModelConfig = z.infer<typeof ModelEnv>;
