import { projects } from "@stage-ready/db";
import { seedDemoProject } from "@stage-ready/db/seed";
import { DEMO_VOICE_CURRENT, DEMO_VOICE_KEY, type DemoVoice } from "@stage-ready/shared";
import { and, desc, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { logger } from "@/lib/server/ai";
import { ApiError, isNavigation, navigationErrorResponse } from "@/lib/server/api";
import { getCurrentUser } from "@/lib/server/auth";
import { db } from "@/lib/server/db";
import { env } from "@/lib/server/env";
import { createGuest, guestCookie, guestToken } from "@/lib/server/guest";
import { redis } from "@/lib/server/queue";
import { getJson } from "@/lib/server/storage";
import { guestLimitPerHour, rateLimit } from "@/lib/server/rate-limit";

const usable = (voice: DemoVoice | null) => (voice && Array.isArray(voice.turns) && voice.turns.length > 0 && Array.isArray(voice.lines) ? voice : null);

/**
 * The worker's Muse transcript of the bundled Demo Mode recording: from Redis, or, right after a restart (Redis
 * is in memory), from storage, which it then puts back in Redis. Null keeps the scripted transcript.
 */
async function cachedDemoVoice(): Promise<DemoVoice | null> {
  try {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 500).unref());
    const raw = await Promise.race([redis().get(DEMO_VOICE_KEY), timeout]);
    const cached = usable(raw ? (JSON.parse(raw) as DemoVoice) : null);
    if (cached) return cached;
  } catch {
    // fall through to storage
  }
  const stored = usable(await getJson<DemoVoice>(DEMO_VOICE_CURRENT));
  if (stored)
    void redis()
      .set(DEMO_VOICE_KEY, JSON.stringify(stored))
      .catch(() => undefined);
  return stored;
}

const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";

// Relative Location: the dev server binds 0.0.0.0, which req.url would leak into the redirect. The
// /demo/starting page asks for JSON (fetch cannot read a redirect's Location) and navigates itself.
const openProject = (req: Request, projectId: string) =>
  (req.headers.get("accept") ?? "").includes("application/json")
    ? Response.json({ projectId, location: `/projects/${projectId}` })
    : new Response(null, { status: 303, headers: { location: `/projects/${projectId}` } });

/**
 * "Try Demo Mode": (re)creates the fictional fixture project and opens it. Signed-out visitors get a guest
 * user (signed httpOnly cookie, 24 h) first, so judges can try it in one click. A returning guest goes
 * straight back to their existing Demo Mode project, so retries and double clicks cost nothing.
 */
export async function POST(req: Request) {
  try {
    let user = await getCurrentUser();
    if (user?.guest) {
      const [existing] = await db()
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.ownerId, user.id), eq(projects.demoMode, true)))
        .orderBy(desc(projects.createdAt))
        .limit(1);
      if (existing) return openProject(req, existing.id);
    }
    if (!user) {
      if (!(await rateLimit(`guest:${clientIp(req)}`, guestLimitPerHour(), 60 * 60_000)))
        throw new ApiError(429, "rate_limited", "Too many guest demos from this network. Try again in an hour, or sign in with GitHub.");
      const guest = await createGuest(db());
      (await cookies()).set(guestCookie(guestToken(guest.id, env().AUTH_SECRET), process.env.NODE_ENV === "production"));
      user = { id: guest.id, email: "", name: "Guest", githubLogin: null, bypass: false, guest: true };
    } else if (!(await rateLimit(`${user.id}:/api/demo`, 5, 60_000))) {
      throw new ApiError(429, "rate_limited", "Too many requests. Wait a minute and try again.");
    }
    const projectId = await seedDemoProject(db(), user.id, { voice: await cachedDemoVoice() });
    if (!projectId) throw new ApiError(500, "seed_failed", "The Demo Mode project could not be created.");
    return openProject(req, projectId);
  } catch (error) {
    if (!(error instanceof ApiError)) logger.error({ err: error }, "demo project could not be created");
    if (isNavigation(req)) return navigationErrorResponse(error, req);
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json(
      { error: { code: error instanceof ApiError ? error.code : "internal", message: error instanceof ApiError ? error.message : "Something went wrong on the server.", detail: null } },
      { status },
    );
  }
}
