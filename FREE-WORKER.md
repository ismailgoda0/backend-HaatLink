# Haat Link — Cloudflare Workers Free

This backend deployment is intentionally **Worker-native** and does not use Cloudflare Containers or Durable Objects.

## What runs on the Free Worker

- CORS and session bootstrap
- Signed `haat_session` cookies
- Health/cors diagnostics
- HTML/direct-media extraction
- Direct media proxying when a real media URL is available
- Gemini AI analyze/ask through the Gemini REST API
- Optional external media resolver via `MEDIA_RESOLVER_URL`

## What cannot run inside a Free Worker

`yt-dlp`, FFmpeg subprocesses, persistent local files, and the previous container-based background download engine are not part of this deployment. The Free Worker therefore does not pretend to provide server-side transcoding when no external media engine is configured.

For full format/quality selection and server-side downloading, configure an external media resolver and set:

- `MEDIA_RESOLVER_URL`
- optional `MEDIA_RESOLVER_TOKEN`

The resolver receives `{ url, rawHtml, client }` and should return the same media metadata shape expected by the frontend.

## Cloudflare settings

- Root directory: `/`
- Deploy command: `npx wrangler deploy`
- No Containers binding
- No Durable Objects binding
- `SESSION_SECRET` should be configured as a Cloudflare Secret, not a plain variable.
- `GEMINI_API_KEY` should be configured as a Cloudflare Secret.

## Important

The original Node/Express server files remain useful for local development. They are not used by the Free Worker deployment entry point.
