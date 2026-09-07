# Haat Link - CORS / Session Fix V2

This patch targets the current Cloudflare Free Worker.

It changes only:
- `src/cloudflare/worker.ts`

Fixes:
- Makes the Firebase production origins explicit/fallback-safe.
- Ensures CORS headers are present on normal JSON responses and unexpected errors.
- Makes missing `SESSION_SECRET` return a CORS-visible `503 SESSION_SECRET_MISSING` instead of crashing on `.length`.
- Keeps credentials enabled for the session cookie.
- Allows `Authorization` in CORS headers.
- Does NOT restore Containers/Durable Objects.
- Does NOT remove or alter the local yt-dlp/FFmpeg media engine.

Apply:
1. Extract this ZIP into the backend repository root.
2. Run `apply-cors-session-fix.bat`.
3. Commit and push the changed worker.ts.
4. Wait for Cloudflare deployment.
5. Open `/api/cors-debug` from the Firebase site and check `originAllowed: true`.

Do not replace or regenerate SESSION_SECRET during this fix.
