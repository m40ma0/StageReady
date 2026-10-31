import { projects, sessions } from "@stage-ready/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError, body, notFound, route, uuidParam } from "@/lib/server/api";
import { db } from "@/lib/server/db";
import { requireProject } from "@/lib/server/projects";
import { presignGet, s3Uri } from "@/lib/server/storage";

/** Records where an uploaded session recording lives. */
export const POST = route<{ id: string }>(async (req, { user, params }) => {
  uuidParam(params.id, "Session");
  const { key } = await body(req, z.object({ key: z.string().min(1).max(400) }));
  const [session] = await db().select().from(sessions).where(eq(sessions.id, params.id));
  if (!session) throw notFound("Session");
  const project = await requireProject(user.id, session.projectId);
  if (!key.startsWith(`projects/${project.id}/recordings/${session.id}.`)) throw new ApiError(400, "invalid_request", "That key does not belong to this session.");
  const [row] = await db().select({ cloud: projects.cloudUploadEnabled }).from(projects).where(eq(projects.id, project.id));
  if (!row?.cloud) throw new ApiError(409, "cloud_upload_off", "Cloud upload is off for this project.");
  await db()
    .update(sessions)
    .set({ recordingUrl: s3Uri(key) })
    .where(eq(sessions.id, session.id));
  return Response.json({ recordingUrl: s3Uri(key) });
});

/** A short-lived URL for an uploaded recording; local-only recordings return null. */
export const GET = route<{ id: string }>(async (_req, { user, params }) => {
  uuidParam(params.id, "Session");
  const [session] = await db().select().from(sessions).where(eq(sessions.id, params.id));
  if (!session) throw notFound("Session");
  await requireProject(user.id, session.projectId);
  // Demo Mode's bundled recording ships with the app; uploaded recordings are presigned.
  if (session.recordingUrl?.startsWith("/demo/")) return Response.json({ url: session.recordingUrl });
  return Response.json({ url: session.recordingUrl ? await presignGet(session.recordingUrl) : null });
});
