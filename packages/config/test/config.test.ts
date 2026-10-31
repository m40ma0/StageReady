import { describe, expect, it } from "vitest";
import { ConfigError, RealtimeEnv, WebEnv, WorkerEnv, clean, cleanEnv, openSecret, parseEnv, sealSecret } from "../src";

const base = {
  DATABASE_URL: "postgres://stage:stage@localhost:5432/stageready",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "stage-ready",
  S3_ACCESS_KEY: "a",
  S3_SECRET_KEY: "b",
  AUTH_SECRET: "0123456789abcdef0123",
  REALTIME_URL: "ws://localhost:4000",
  REALTIME_JWT_SECRET: "0123456789abcdef0123",
};

describe("env validation", () => {
  it("treats empty model values as unset and defaults to mocked JSON mode", () => {
    const env = parseEnv("worker", WorkerEnv, { ...base, META_API_KEY: "", MODEL_SPARK: "", EMBED_DIM: "" });
    expect(env.META_API_KEY).toBeUndefined();
    expect(env.EMBED_DIM).toBeUndefined();
    // Meta's structured-output docs describe json_schema, so it is the default.
    expect(env.META_RESPONSE_FORMAT).toBe("json_schema");
  });
  it("names every missing value", () => {
    expect(() => parseEnv("worker", WorkerEnv, {})).toThrow(ConfigError);
    expect(() => parseEnv("worker", WorkerEnv, {})).toThrow(/DATABASE_URL/);
  });
  it("requires GitHub OAuth unless the dev bypass is on, and forbids the bypass in production", () => {
    expect(() => parseEnv("web", WebEnv, base)).toThrow(/AUTH_GITHUB_ID/);
    expect(parseEnv("web", WebEnv, { ...base, DEV_AUTH_BYPASS: "true" }).DEV_AUTH_BYPASS).toBe(true);
    expect(() => parseEnv("web", WebEnv, { ...base, DEV_AUTH_BYPASS: "true", NODE_ENV: "production" })).toThrow(/production/);
  });
  it("refuses placeholder secrets, ws:// and a localhost origin in production only", () => {
    const prod = { ...base, NODE_ENV: "production", AUTH_GITHUB_ID: "id", AUTH_GITHUB_SECRET: "secret", REALTIME_URL: "wss://rt.example.com" };
    expect(parseEnv("web", WebEnv, prod).REALTIME_URL).toBe("wss://rt.example.com");
    expect(() => parseEnv("web", WebEnv, { ...prod, AUTH_SECRET: "replace-with-a-long-random-value" })).toThrow(/placeholder/);
    expect(() => parseEnv("web", WebEnv, { ...prod, REALTIME_URL: "ws://rt.example.com" })).toThrow(/wss:/);
    expect(parseEnv("web", WebEnv, { ...base, DEV_AUTH_BYPASS: "true", AUTH_SECRET: "replace-with-a-long-random-value" }).NODE_ENV).toBe("development");
    expect(() => parseEnv("realtime", RealtimeEnv, { ...prod, REALTIME_JWT_SECRET: "replace-with-a-long-random-value", WEB_ORIGIN: "https://app.example.com" })).toThrow(/REALTIME_JWT_SECRET/);
    expect(() => parseEnv("realtime", RealtimeEnv, prod)).toThrow(/WEB_ORIGIN/);
    expect(parseEnv("realtime", RealtimeEnv, { ...prod, WEB_ORIGIN: "https://app.example.com" }).WEB_ORIGIN).toEqual(["https://app.example.com"]);
  });
  it("requires the vision-service token in production when a vision service is set", () => {
    const prod = { ...base, NODE_ENV: "production", AUTH_GITHUB_ID: "id", AUTH_GITHUB_SECRET: "secret", REALTIME_URL: "wss://rt.example.com", VISION_SERVICE_URL: "https://vision.example.com" };
    expect(() => parseEnv("web", WebEnv, prod)).toThrow(/VISION_SERVICE_TOKEN/);
    expect(() => parseEnv("worker", WorkerEnv, prod)).toThrow(/VISION_SERVICE_TOKEN/);
    expect(parseEnv("worker", WorkerEnv, { ...prod, VISION_SERVICE_TOKEN: "t" }).VISION_SERVICE_TOKEN).toBe("t");
    expect(parseEnv("worker", WorkerEnv, { ...base, VISION_SERVICE_URL: "http://localhost:8000" }).VISION_SERVICE_TOKEN).toBeUndefined();
  });
});

describe("sealed secrets", () => {
  it("round-trips and rejects the wrong key", () => {
    const sealed = sealSecret("gho_token", "secret-one-long-enough");
    expect(sealed).not.toContain("gho_token");
    expect(openSecret(sealed, "secret-one-long-enough")).toBe("gho_token");
    expect(() => openSecret(sealed, "secret-two-long-enough")).toThrow();
  });
});

describe("session tokens", () => {
  it("verifies scoped claims and rejects expired or foreign tokens", async () => {
    const { signSessionToken, verifySessionToken } = await import("../src");
    const claims = { sid: "01a186d2-229a-7a27-a55c-28567aaf817a", pid: "01a186d2-229a-7a27-a55c-28567aaf817b", uid: "01a186d2-229a-7a27-a55c-28567aaf817c" };
    const secret = "0123456789abcdef0123";
    const token = await signSessionToken(claims, secret);
    await expect(verifySessionToken(token, secret)).resolves.toMatchObject(claims);
    await expect(verifySessionToken(token, "another-secret-of-length")).rejects.toThrow();
    const old = await signSessionToken(claims, secret, Date.now() - 16 * 60_000);
    await expect(verifySessionToken(old, secret)).rejects.toThrow();
  });
});

describe("env cleaning", () => {
  it("strips inline comments, matching quotes, spaces and CRLF before validation", () => {
    const env = parseEnv("worker", WorkerEnv, {
      ...base,
      DEMO_DAILY_CALL_LIMIT: "1500 # calls",
      S3_ENDPOINT: '"https://s3.example.com"',
      S3_BUCKET: " stage-ready\r",
      AUTH_SECRET: "'0123456789abcdef0123'  # rotated in October",
    });
    expect(env.DEMO_DAILY_CALL_LIMIT).toBe(1500);
    expect(env.S3_ENDPOINT).toBe("https://s3.example.com");
    expect(env.S3_BUCKET).toBe("stage-ready");
    expect(env.AUTH_SECRET).toBe("0123456789abcdef0123");
  });

  it("parses a CRLF dotenv file", async () => {
    const { parseEnv: parseDotenv } = await import("node:util");
    const file = Object.entries({ ...base, DEMO_DAILY_CALL_LIMIT: "1500" })
      .map(([k, v]) => `${k}=${v}`)
      .join("\r\n");
    const env = parseEnv("worker", WorkerEnv, parseDotenv(file));
    expect(env.DATABASE_URL).toBe(base.DATABASE_URL);
    expect(env.DEMO_DAILY_CALL_LIMIT).toBe(1500);
  });

  it("keeps a # that is part of the value", () => {
    expect(clean("https://example.com/#anchor")).toBe("https://example.com/#anchor");
    expect(clean('"a # b"')).toBe("a # b");
    expect(clean("abc#def")).toBe("abc#def");
  });

  it("names cleaned keys and never their values", () => {
    const { changed } = cleanEnv({ A: "1 # note", B: "plain", C: "" });
    expect(changed).toEqual(["A"]);
  });
});

describe("WEB_ORIGIN", () => {
  const rt = { DATABASE_URL: base.DATABASE_URL, REDIS_URL: base.REDIS_URL, REALTIME_JWT_SECRET: base.REALTIME_JWT_SECRET };
  it("accepts a comma-separated list and trims trailing slashes", () => {
    const env = parseEnv("realtime", RealtimeEnv, { ...rt, WEB_ORIGIN: "https://a.modal.run, https://a.us-east.modal.run/" });
    expect(env.WEB_ORIGIN).toEqual(["https://a.modal.run", "https://a.us-east.modal.run"]);
  });
  it("defaults to the local web app and rejects a non-URL entry", () => {
    expect(parseEnv("realtime", RealtimeEnv, rt).WEB_ORIGIN).toEqual(["http://localhost:3000"]);
    expect(() => parseEnv("realtime", RealtimeEnv, { ...rt, WEB_ORIGIN: "https://a.modal.run,not a url" })).toThrow(/WEB_ORIGIN/);
  });
});
