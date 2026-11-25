# Audiveris OMR server (backup reader)

Small Flask service wrapping the Audiveris CLI (`-batch -export`). Vercel can't run Java, so deploy this separately.

API: `POST /omr` body `{"images":["data:image/jpeg;base64,..."]}` -> `{"musicxml":"..."}` (multi-page: measures appended into the first score's parts; `warnings[]` if something was skipped). `GET /health`.
Limits: 10 MB per request/image, 6 pages, 240 s per image (`OMR_TIMEOUT`). Temp files deleted after each request.

## Deploy
Needs ~1.5 GB RAM (Audiveris is JVM + image processing).

- **Fly.io**: `fly launch --no-deploy` in this folder, set `[http_service] internal_port = 8080`, VM `shared-cpu-2x` with 2048 MB, then `fly secrets set OMR_TOKEN=<random>` and `fly deploy`.
- **Render**: New Web Service -> Docker, root dir `brass-reader/audiveris-server`, instance with >= 2 GB RAM, env `OMR_TOKEN`.
- **Railway**: New service from repo, root dir as above (Dockerfile auto-detected), variable `OMR_TOKEN`.

The Dockerfile downloads the latest Audiveris `.deb` from GitHub releases at build time (build needs github.com access).

## Connect the app
In Vercel project settings -> Environment Variables:
- `AUDIVERIS_URL` = `https://your-service.example.com` (the app calls `<url>/omr`)
- `OMR_TOKEN` = same secret (sent as `X-OMR-Token`)

Redeploy. Quick check: `curl https://your-service/health`.

## Local test
`pip install flask pillow`, then `python test/test_server.py` (uses a real Audiveris if `AUDIVERIS_CMD` resolves, else only checks plumbing with a stub and says so).
