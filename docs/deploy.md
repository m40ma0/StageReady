# Deploying Stage Ready

For a free deployment with no card, follow steps 1 and 2 below (database, storage, the vision service on Modal), then **Free option: everything else on Modal** at the end. It runs the three Node services and Redis in one Modal container.

Stage Ready runs as three Node processes, a Python service on Modal, and four managed backing services. Any host that runs Node 22 with long-lived processes and WebSockets works (a VM, Fly.io, Railway, Render). The web app can also go on Vercel; the realtime server and the worker cannot, since they hold WebSockets and a job queue open.

| Piece                     | What it is                                               | Suggested home                                      |
| ------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| `apps/web`                | Next.js 15 (UI and REST API), port 3000                  | Vercel, or any Node host                            |
| `apps/realtime`           | Fastify WebSocket server, port 4000                      | Any Node host with WebSockets                       |
| `apps/worker`             | BullMQ job worker, health on 4100                        | Any Node host (no public port needed)               |
| `services/vision`         | FastAPI: faster-whisper, FFmpeg renders, take thumbnails | Modal (`services/vision/modal_app.py`, CPU or GPU)  |
| Postgres 16 with pgvector | Everything stored                                        | Neon, Supabase, RDS (enable the `vector` extension) |
| Redis 7                   | Job queue and realtime state                             | Upstash (TCP, not REST), Redis Cloud, ElastiCache   |
| S3-compatible storage     | Recordings, takes, slides, renders                       | Cloudflare R2 or S3                                 |
| Meta Model API            | Muse Spark, Muse Wonder, Muse Image, SAM 3.1             | Already hosted; you only need the key               |

## 1. Backing services

1. **Postgres.** Create a database, enable `vector` (`CREATE EXTENSION IF NOT EXISTS vector;`; `pnpm db:migrate` does this too when the role is allowed to) and copy the connection string into `DATABASE_URL`.
2. **Redis.** Copy the `redis://` or `rediss://` URL into `REDIS_URL`. BullMQ needs a real Redis connection; HTTP-only Redis APIs do not work.
3. **Storage.** Create a bucket and an access key with read and write on it. Fill `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` and `S3_REGION` (`auto` for R2). The endpoint must be reachable from the internet: browsers upload recordings with presigned PUTs, and the Modal service downloads takes and uploads renders with presigned URLs. Add a CORS rule to the bucket so the browser can upload:

   ```json
   [{ "AllowedOrigins": ["https://app.example.com"], "AllowedMethods": ["GET", "PUT"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
   ```

## 2. The vision service on Modal

```bash
pip install modal
```

```bash
modal token new
```

```bash
modal secret create stage-ready-vision VISION_SERVICE_TOKEN=$(openssl rand -hex 24)
```

Run it from the service's folder, so Modal finds `requirements.txt` and the `app` package:

```bash
cd services/vision && modal deploy modal_app.py
```

It runs on CPU by default (works on Modal's free plan; speech to text uses faster-whisper `base.en`). With a payment method on Modal, `MODAL_GPU=L4 modal deploy modal_app.py` runs it on a GPU with the more accurate `small.en`.

Put the printed URL in `VISION_SERVICE_URL` and the same token in `VISION_SERVICE_TOKEN`. Modal may run several containers: renders mirror their status to storage, so a status poll that reaches another container still gets an answer (see `docs/decisions/0006-m6-decisions.md`).

## 3. Environment

Start from `.env.example` and change these for production. Every service validates its environment at boot and refuses to start with a clear message when something is missing or unsafe.

| Variable                                     | Production value                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                   | `production`                                                                                                     |
| `AUTH_SECRET`, `REALTIME_JWT_SECRET`         | Two different values from `openssl rand -base64 32` (the `.env.example` placeholders are refused)                |
| `DEV_AUTH_BYPASS`                            | `false` (refused in production)                                                                                  |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`       | A GitHub OAuth app with callback `https://app.example.com/api/auth/callback/github`                              |
| `AUTH_URL`                                   | `https://app.example.com` (or `AUTH_TRUST_HOST=true` behind a proxy that sets the host)                          |
| `REALTIME_URL`                               | `wss://rt.example.com` (`ws://` is refused: browsers block it from an https page)                                |
| `WEB_ORIGIN`                                 | `https://app.example.com`; comma-separate several (the realtime server rejects WebSockets from any other origin) |
| `META_API_KEY`, `MODEL_*`, `META_*`          | As in your local `.env`; run `pnpm ai:check` against them first                                                  |
| `VISION_SERVICE_URL`, `VISION_SERVICE_TOKEN` | From step 2                                                                                                      |

Leave `MODEL_MOCK=false`. Demo Mode projects still use the mocked adapters, so the seeded project works without spending model calls.

## 4. Build, migrate and start

On each Node host (or in its build step):

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm build
```

Once per release, before the new version takes traffic:

```bash
pnpm db:migrate
```

Optionally load the fictional Demo Mode project (safe to re-run):

```bash
pnpm db:seed
```

Then start each process (one per service on platforms that run one command per service):

```bash
pnpm --filter @stage-ready/web start
```

```bash
pnpm --filter @stage-ready/realtime start
```

```bash
pnpm --filter @stage-ready/worker start
```

`pnpm start` at the root runs all three on one machine. Next.js listens on `PORT` (default 3000), realtime on `REALTIME_PORT` (4000), and the worker serves its health check on `WORKER_HEALTH_PORT` (4100). Every service answers `GET /api/health`; point the platform's health check at it.

Put TLS in front of web and realtime (the platform's proxy usually does this). The realtime proxy must allow WebSocket upgrades and idle connections of at least 10 minutes.

## 5. Check the deploy

1. `GET /api/health` on web, realtime and worker returns `"status":"ok"`, and realtime and worker report `"models":"meta"`.
2. Sign in with GitHub, open the Demo Mode project, and run a 1-minute rehearsal: judges speak, claims appear.
3. Record one Director take: it uploads, gets a thumbnail and a score. Render the Demo Mode cut; the MP4, SRT, thumbnail and chapters download.
4. Open DemoGuard, build a step map and run pre-flight.

## Free option: everything else on Modal

`deploy/modal/stage_ready.py` runs web, realtime, the worker and Redis in one CPU container on Modal, behind one address. A small router (`deploy/container/router.mjs`) sends WebSockets on `/ws` to realtime and everything else to web; `deploy/container/start.sh` starts Redis, applies migrations, then the services. Redis is not needed from step 1.

What to know:

- One container at most, since Redis and live sessions are in its memory. It scales to zero after 20 idle minutes and starts again on the next visit (about a minute: migrations, then the services). It only uses Modal credits while it is up.
- Jobs still queued when it scales down or restarts are lost; everything in the database and storage is kept.
- It deploys the code you have checked out, so `git pull` first.

1. **Address.** The app is served at `https://<workspace>--stage-ready.modal.run`, where `<workspace>` is your Modal workspace name (shown when you ran `modal setup`). Call it `APP_URL`.
2. **GitHub sign-in.** Create a GitHub OAuth app (GitHub → Settings → Developer settings → OAuth Apps) with homepage `APP_URL` and callback `APP_URL/api/auth/callback/github`.
3. **Storage CORS.** Allow `APP_URL` on the bucket (see step 1).
4. **Settings.** Create `.env.production` at the repo root. Git ignores it and the deploy never uploads it. Fill it in:

   ```
   PUBLIC_HOST=<workspace>--stage-ready.modal.run
   DATABASE_URL=
   S3_ENDPOINT=
   S3_BUCKET=
   S3_ACCESS_KEY=
   S3_SECRET_KEY=
   S3_REGION=
   AUTH_SECRET=
   REALTIME_JWT_SECRET=
   AUTH_GITHUB_ID=
   AUTH_GITHUB_SECRET=
   VISION_SERVICE_URL=
   VISION_SERVICE_TOKEN=
   META_API_KEY=
   META_API_BASE_URL=https://api.meta.ai/v1
   META_API_STYLE=responses
   MODEL_SPARK=muse-spark-1.3
   MODEL_WONDER=muse-wonder-1.0
   MODEL_IMAGE=muse-image-1.0
   MODEL_SAM=sam-3.1
   META_REASONING_EFFORT_SPARK=low
   META_REASONING_EFFORT_WONDER=high
   META_RESPONSE_FORMAT=json_schema
   DEMO_DAILY_BUDGET_USD=5
   DEMO_DAILY_CALL_LIMIT=1500
   ```

   `PUBLIC_HOST` sets `AUTH_URL`, `REALTIME_URL` and `WEB_ORIGIN`, and is the one address to share: Modal also serves the app on a region-specific host (`<workspace>--stage-ready.<region>.modal.run`), and the router redirects that host to `PUBLIC_HOST`, so sign-in and live sessions work whichever link people use. Use `PUBLIC_HOST` in the GitHub OAuth app's callback URL; `NODE_ENV` and `REDIS_URL` are set in the image. `MODEL_API_KEY` is still accepted in place of `META_API_KEY`. `VISION_SERVICE_TOKEN` is required in production and must match the one in the `stage-ready-vision` Modal secret; the deployed vision service refuses every request without it. Add `MODEL_PRICES` (JSON from Meta's pricing page) to show real costs and enforce the dollar budget. Then store it in Modal:

   ```bash
   modal secret create stage-ready-app --from-dotenv .env.production
   ```

   After changing the file, run it again with `--force`, then redeploy.

5. **Deploy** from the repo root (the first build installs and builds everything, several minutes):

   ```bash
   modal deploy deploy/modal/stage_ready.py
   ```

6. **Check.** Run `pnpm env:check <your secret as a dotenv file> --strict` before deploying: it names any field that is missing, malformed or still a placeholder (never the values). After deploying, `APP_URL/healthz` reports web, realtime and storage together (503 with `"reason":"credentials"` means the S3 keys are wrong). Open `APP_URL/api/health` (the first visit wakes the container: allow a minute). In the Modal dashboard, the `stage-ready` app's logs show `Migrations applied.`, `router on :7860`, realtime `Server listening` and `worker listening on queue stage-ready-jobs` with `"models":"meta"`. Then sign in at `APP_URL` and run a short rehearsal.

To update: `git pull`, then deploy again.

Visitors can try it without signing in: **Try Demo Mode** creates a guest workspace (24 hours) with the fictional project, running on the real Meta models until today's demo allowance (`DEMO_DAILY_BUDGET_USD`, tracked only for models priced in `MODEL_PRICES`, and `DEMO_DAILY_CALL_LIMIT`) is used up; after that Demo Mode answers with the mocks and each caption says so. Set `DEMO_LIVE_MODELS=false` to keep Demo Mode mocked.

The container stays warm by default (one running at all times, no cold start while judges are looking; it uses credits while idle). Once judging ends, let it scale to zero:

```bash
KEEP_WARM=0 modal deploy deploy/modal/stage_ready.py
```

**Run next to the database.** Each page makes several Postgres round trips, so a container in a different region from Postgres turns every page into seconds. Set `MODAL_REGION` at deploy time to the Modal region nearest your database host (for example `us-east` for Neon `aws-us-east-1`/`us-east-2`, `eu-west` for `aws-eu-central-1`, `ap-southeast` for `aws-ap-southeast-1`), or move the database next to the container:

```bash
MODAL_REGION=us-east modal deploy deploy/modal/stage_ready.py
```

Region pinning can carry a price multiplier on Modal. Check with `curl -w '%{time_total}\n' -o /dev/null -s APP_URL/api/projects` (signed in) that project calls come back in well under half a second.

Guest workspaces expire after 48 hours. Remove expired guests and review-test projects with `DATABASE_URL=… pnpm db:cleanup` (add `--dry-run` to count first).

The same container also runs on any Docker host with `deploy/container/Dockerfile` (settings as environment variables, port 7860).

## Recording the submission video

The Director renders the team's own submission video: record one take per section in **Director**, let the worker transcribe and score them, check the auto-EDL fits the limit, then **Render**. That part needs you at the camera.
