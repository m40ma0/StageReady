"""Stage Ready (web, realtime, worker and Redis) as one Modal web app, on CPU.

Deploy from the repo root, with the code you have checked out:
    modal deploy deploy/modal/stage_ready.py

Settings come from the Modal secret "stage-ready-app" (see docs/deploy.md). The app is served at
https://<workspace>--stage-ready.modal.run; set PUBLIC_HOST in the secret to that host name.

One container at most: Redis and live rehearsal sessions are in its memory. During the judging window
one container stays warm (no cold start); after judging, deploy with KEEP_WARM=0 so it scales to zero
after 20 idle minutes and only uses credits while in use.

Every page makes several Postgres round trips, so run the container next to the database: set
MODAL_REGION at deploy time to the Modal region nearest your Postgres host (e.g. "us-east" for Neon
us-east-1/us-east-2, "us-west" for us-west-2, "eu-west" for eu-central-1/eu-west, "ap-southeast" for
ap-southeast-1). Pinning a region can carry a price multiplier on Modal; see docs/deploy.md.
"""

import os
from pathlib import Path

import modal

# Only meaningful where you run `modal deploy`; inside the container the code is already in /app.
REPO = Path(__file__).resolve().parents[2] if modal.is_local() else Path("/app")

image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
    # Fonts for anything rendered in the container; evidence slides also bundle DejaVu Sans (apps/worker/fonts).
    .apt_install("redis-server", "fonts-dejavu-core", "fontconfig")
    .run_commands("npm install -g pnpm@11.14.0")
    .env({"CI": "true", "NEXT_TELEMETRY_DISABLED": "1"})
    .add_local_dir(
        REPO,
        "/app",
        copy=True,
        # Never ship local secrets or build output; dependencies are installed fresh below.
        ignore=["**/node_modules", "**/.next", "**/.turbo", "**/.venv", "**/__pycache__", ".git", ".env", ".env.*", "**/dump.rdb", "**/test-results", "**/playwright-report"],
    )
    .run_commands("cd /app && pnpm install --frozen-lockfile && pnpm build")
    .env({"NODE_ENV": "production", "REDIS_URL": "redis://127.0.0.1:6379"})
)

app = modal.App("stage-ready", image=image)


# Warm by default for the judging window: one 2-CPU / 4 GiB container running around the clock costs
# credits even when idle (roughly a day of CPU-hours per day). Deploy with KEEP_WARM=0 once judging ends.
KEEP_WARM = os.environ.get("KEEP_WARM", "1").lower() not in ("0", "false", "no")

# Modal region to run in, matching the Postgres host (see the docstring). Unset lets Modal choose.
MODAL_REGION = os.environ.get("MODAL_REGION", "").strip() or None


@app.function(
    cpu=2.0,
    memory=4096,
    secrets=[modal.Secret.from_name("stage-ready-app")],
    max_containers=1,
    min_containers=1 if KEEP_WARM else 0,
    region=MODAL_REGION,
    scaledown_window=1200,
    timeout=24 * 3600,
)
@modal.concurrent(max_inputs=200)
@modal.web_server(7860, startup_timeout=180, label="stage-ready")
def web() -> None:
    import os
    import subprocess
    import threading

    process = subprocess.Popen(["bash", "deploy/container/start.sh"], cwd="/app")

    # start.sh exits when any service dies; take the container down with it so Modal starts a fresh one.
    def watch() -> None:
        process.wait()
        os._exit(1)

    threading.Thread(target=watch, daemon=True).start()
