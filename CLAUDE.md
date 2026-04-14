# Make.com Workflow Builder — Claude Code Context

## What This Project Is

A multi-tenant Express.js server that takes a plain-English automation brief and automatically
builds and deploys a real Make.com scenario using a multi-step AI pipeline.

Users sign up via Lovable frontend, complete onboarding (paste their Make MCP credentials),
then submit briefs to build workflows in their own Make.com accounts.

**Stack:** Node.js + Express, Anthropic Claude API, Make.com MCP, Supabase
**Entry point:** `server.js`
**Start:** `node server.js` or `npm run dev` (watch mode)
**Port:** 3000 (from `.env`)
**Public URL (dev):** ngrok tunnel — run `/tmp/ngrok http 3000` to expose locally

---

## Architecture — The Full Pipeline

Every `POST /build-workflow` request runs these steps in sequence:

```
Step 0a: App resolution  → user picks apps in UI (sent as "apps" array) OR Claude Haiku detects from brief
Step 0b: Cache / MCP     → resolves real module lists for each app (cache-first, MCP probe on miss)
                           If slug fails → apps_recommend MCP tool finds correct slug → retries
Step 1:  Claude (Sonnet) → plans workflow using ONLY verified module names → JSON plan
                           If plan fails validatePlan() → retries once with correction message
Step 2:  Node.js + MCP   → validates every module via app-module_get (hard fail on unknown)
Step 3:  Node.js         → builds Make.com blueprint JSON locally
Step 4:  Node.js + MCP   → calls scenarios_create to deploy the scenario
Step 5:  Supabase        → logs created scenario (non-blocking, never fails the request)
```

Claude never sees raw MCP output. All MCP calls are made by Node.js directly.

---

## File Structure

```
server.js                  — entire server (all logic lives here)
cache/make-modules.json    — persistent module cache, grows automatically
cache/slug-map.json        — persistent slug resolution cache (name → real Make slug)
.env                       — secrets (never commit)
CLAUDE.md                  — this file
```

### `.env` variables (all required)
```
ANTHROPIC_API_KEY=...
MAKE_MCP_URL=https://us1.make.com/mcp/api/v1/u/58ff0068-.../stateless
MAKE_MCP_TOKEN=58ff0068-596f-4336-be5b-8e66f1969436
SUPABASE_URL=https://kflzyodssbxuyvxiyosr.supabase.co
SUPABASE_ANON_KEY=eyJhbGci...
PORT=3000
```

### Hardcoded Make.com constants (in server.js)
```
MAKE_ORGANIZATION_ID = 1735429
GOOGLE_CONNECTION_ID = 3198221   ← server owner's Google connection, wired into all Google modules
```
`teamId` is NOT hardcoded — it's auto-discovered per user via `teams_list` MCP call on each request.

---

## Multi-Tenant Architecture

Each user has their own Make MCP credentials stored in Supabase `user_mcp` table:
- `user_id` (UUID) — Supabase auth user ID
- `mcp_url` — user's Make MCP URL
- `mcp_token` — user's Make MCP token

Every MCP call takes a `creds = { url, token }` object threaded through all functions.
If no `user_id` is provided (dev/test), falls back to `.env` credentials.

**Supabase tables:**
- `user_mcp` — stores per-user MCP credentials (RLS disabled)
- `created_scenarios` — logs every successfully created scenario (RLS disabled)

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/build-workflow` | Run the full pipeline |
| `GET`  | `/apps` | List all supported Make.com apps for the UI picker |
| `POST` | `/save-mcp-credentials` | Save user's MCP credentials during onboarding |
| `GET`  | `/status` | Current pipeline stage (polled by frontend every 2s) |
| `GET`  | `/health` | Health check |

### Request body for `/build-workflow`
```json
{
  "brief": "...",
  "platform": "Make.com",
  "agency_name": "...",
  "user_id": "<supabase UUID>",
  "apps": ["typeform", "hubspotcrm", "google-email"]
}
```
`apps` is optional — if provided, skips Claude detection entirely (preferred).

### Success response from `/build-workflow`
```json
{
  "success": true,
  "scenario_id": "4672677",
  "scenario_name": "Typeform Lead Router",
  "make_url": "https://us1.make.com/699469/scenarios/4672677/edit",
  "apps_used": ["typeform", "hubspotcrm", "google-email"]
}
```

### Status stages (in order)
```json
{ "status": "running", "stage": "detecting apps" }
{ "status": "running", "stage": "resolving module lists" }
{ "status": "running", "stage": "planning workflow" }
{ "status": "running", "stage": "planning workflow (retry)" }
{ "status": "running", "stage": "validating modules" }
{ "status": "running", "stage": "building blueprint" }
{ "status": "running", "stage": "deploying scenario" }
```

---

## App Resolution — Two Layers

### Layer 1: User picks apps in Lovable UI
Frontend calls `GET /apps` → shows picker → sends `apps: ["typeform", "hubspotcrm"]` in body.
Step 0a is skipped entirely. Most reliable path.

### Layer 2: Claude Haiku fallback (when no apps array sent)
`detectAppsWithClaude(brief)` identifies slugs from the brief text.

### Slug self-healing (when a slug fails module resolution)
If `resolveAppModules(slug)` fails:
1. Calls `apps_recommend` MCP tool with the app name
2. Gets back the real Make.com slug
3. Retries `resolveAppModules` with the corrected slug
4. Saves the mapping to `cache/slug-map.json` for future requests

This means wrong slugs (e.g. "hubspot" instead of "hubspotcrm") auto-correct without any code change.

---

## The Module Cache (`cache/make-modules.json`)

- Cache hit → use immediately, zero MCP calls
- Cache miss → probes MCP versions 1–6 until one succeeds → saves to file
- Never delete unless Make changes their API

**Currently cached (10+ apps):**
`facebook-lead-ads`, `google-email`, `google-sheets`, `typeform`,
`hubspotcrm`, `mailchimp`, `slack`, `stripe`, `asana`, `woocommerce`

Known versions: `google-email=2`, `google-sheets=2`, `hubspotcrm=1`, `typeform=1`, `slack=4`, `stripe=1`

---

## Supported Apps (`GET /apps`)

40 apps with correct Make.com slugs. Key mappings to remember:
- Gmail → `google-email`
- HubSpot → `hubspotcrm`
- Brevo → `sendinblue`
- Telegram → `telegram-bot`
- Zoho CRM → `zohocrm`

**Intentionally excluded (not in Make.com):** OpenAI, Anthropic, Instantly, GoHighLevel,
Close CRM, Tally, WhatsApp Business, Linear

---

## Make MCP — Critical Implementation Details

### SSE Response Format (DO NOT CHANGE)
Make MCP requires `Accept: application/json, text/event-stream` in every request.
Without it you get HTTP 406. Responses come back as SSE — parse the last `data:` line.

### MCP Tools Used
- `app-modules_list` — list modules for an app (requires organizationId, appName, appVersion)
- `app-module_get` — validate a specific module exists
- `apps_recommend` — find correct Make.com app slug from a human-readable name
- `scenarios_create` — deploy blueprint (requires teamId, scheduling, blueprint, confirmed: true)
- `teams_list` — discover teamId for a user's MCP credentials

---

## Blueprint Format — Hard-Won Lessons (DO NOT REGRESS)

### 1. Router module name is `BasicRouter`
```js
module: 'builtin:BasicRouter'  // ✅ correct
module: 'builtin:RouterModule' // ❌ Make returns "Module not found"
```

### 2. Router filter conditions go on the FIRST MODULE inside the route's flow
Make rejects `filter` and `label` as direct properties on the route object.
```json
// ✅ Correct
{ "routes": [{ "flow": [{ "id": 3, "module": "...", "filter": { "name": "Large", "conditions": [[...]] } }] }] }

// ❌ Wrong — Make rejects this
{ "routes": [{ "label": "Large", "filter": {...}, "flow": [...] }] }
```

### 3. Fallback routes MUST have explicit empty conditions
Make silently drops branches with no `filter` on their first module.
```json
// ✅ Required
{ "id": 6, "module": "mailchimp:ActionAddSubscriber", "filter": { "name": "Fallback", "conditions": [] } }
```

### 4. Nested route modules are NOT in the top-level flow
`buildBlueprint()` uses a `nestedIds` Set to exclude them.

### 5. Google apps need connection wiring
```js
parameters: { __IMTCONN__: 3198221 }
```
Applied automatically in `buildFlowEntry()` for: `google-email`, `google-sheets`,
`google-calendar`, `google-drive`, `gmail`, `google-docs`.

### 6. `scheduling` is required for `scenarios_create`
```json
{ "type": "indefinitely", "interval": 900 }
```

### 7. `confirmed: true` is required for `scenarios_create`
Prevents Make from blocking on "app not installed" warnings.

### 8. Router branch positioning
Each route branch gets a different `y` coordinate (routeIndex * 300) so branches
are visually spread out in Make.com — no manual "align" click needed.

---

## Claude Planning — Hallucination Prevention

### What Claude is allowed to use
- Only modules from the `VERIFIED MAKE.COM MODULES` block (dynamically injected per request)
- Only `builtin:BasicRouter` — no Sleep, Delay, Iterator, Aggregator, or any other builtin

### validatePlan() — runs before Step 2
Checks every module in Claude's plan:
1. If `app === 'builtin'` and module is not `BasicRouter` → throws immediately
2. If app is not in the verified list → throws immediately

### Retry loop
If `validatePlan()` throws on the first plan:
- Claude is sent the exact error message and told to replan
- `validatePlan()` runs again on the retry
- If it fails twice → error is returned to the user (very rare)

### Planning prompt critical rules
- ONLY use module names from VERIFIED MAKE.COM MODULES
- ONLY builtin is BasicRouter
- Never use openai, anthropic, or any app not in the verified list
- version must match the app version in the verified block

---

## CORS

All endpoints return:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, ngrok-skip-browser-warning
```
OPTIONS preflight returns 204. Required for Lovable frontend (browser) to call the ngrok URL.

---

## Lovable Frontend Integration

The Lovable app at `https://preview--custom-workflow.lovable.app` communicates with this server.

### Onboarding flow (Step 4 of 4)
User pastes MCP URL + token → Lovable POSTs to `/save-mcp-credentials`:
```json
{ "user_id": "<supabase UUID>", "mcp_url": "...", "mcp_token": "..." }
```
`user_id` stored in `localStorage` as `flowmatic_user_id`.

### Build flow
1. User picks apps from picker (fetched from `GET /apps`)
2. User writes brief → clicks submit
3. Lovable reads `user_id` from `localStorage` (no auth call — avoids hangs)
4. POSTs to `/build-workflow` with `brief`, `platform`, `agency_name`, `user_id`, `apps`
5. Polls `GET /status` every 2s to show progress stages
6. On success: shows scenario name + opens `make_url` in new tab

---

## Predicted Future Issues & Fixes

### 1. Make renames or deprecates a module
Delete that app's entry from `cache/make-modules.json` → re-probe happens automatically.

### 2. Make releases a new app version above v6
Increase the probe ceiling in `resolveAppModules()` (currently tries 1–6).

### 3. Claude hallucinates an app or builtin
Now caught by `validatePlan()` before Step 2. Claude gets a correction and retries once.

### 4. apps_recommend returns unexpected format
Check the raw response shape — it may be `[{name: ...}]` or `{apps: [...]}` or `{result: [...]}`.
`resolveSlugFromName()` handles all three but may need updating if Make changes the format.

### 5. Concurrent requests corrupting pipeline status
`pipelineStatus` is a single global variable. If two users submit simultaneously,
stages will interleave. Fix: key status by request ID, have frontend poll `/status/:requestId`.

### 6. Make MCP token expiry (per user)
Symptom: MCP calls return 401/403 for one user but not others.
Fix: User must re-complete onboarding to save new credentials via `/save-mcp-credentials`.

### 7. Scenario created but `isinvalid: true` in Make
Blueprint was valid JSON but had semantic errors (bad connection ID, wrong field names).
Fix: After deploy, check `scenario.isinvalid` and surface as warning to user.

### 8. ngrok URL changes
ngrok free tier may change the URL on restart. Update the URL in Lovable when this happens.
Consider upgrading to a paid ngrok plan with a fixed domain, or deploy to a real server.

### 9. Supabase RLS blocking inserts
Both `user_mcp` and `created_scenarios` tables have RLS disabled.
If re-enabled, inserts will fail silently (Supabase insert is non-blocking, errors are logged not thrown).

### 10. Slug map cache stale
If Make changes an app's slug, `cache/slug-map.json` may have the old mapping.
Delete the entry for that app name and it will re-resolve via `apps_recommend`.

---

## Testing

```bash
# Start server
node server.js

# Health check
curl http://localhost:3000/health

# List available apps
curl http://localhost:3000/apps

# Simple test — with apps array (skips detection, fastest path)
curl -X POST http://localhost:3000/build-workflow \
  -H "Content-Type: application/json" \
  -d '{"brief":"When a new lead submits a Facebook Lead Ad send a welcome email via Gmail and add to Google Sheets","platform":"Make.com","agency_name":"Test","apps":["facebook-lead-ads","google-email","google-sheets"]}'

# Router test — Typeform → HubSpot + Gmail + Sheets / Mailchimp
curl -X POST http://localhost:3000/build-workflow \
  -H "Content-Type: application/json" \
  -d '{"brief":"When a new lead fills out a Typeform, if budget over $5000 create HubSpot deal and send Gmail, else add to Mailchimp","platform":"Make.com","agency_name":"Test","apps":["typeform","hubspotcrm","google-email","mailchimp"]}'

# Poll status during a run
watch -n2 'curl -s http://localhost:3000/status'

# Check most recent created scenario
node -e "require('dotenv').config(); const {createClient}=require('@supabase/supabase-js'); const s=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY); s.from('created_scenarios').select('*').order('created_at',{ascending:false}).limit(1).then(({data})=>console.log(JSON.stringify(data,null,2)));"
```

---

## Dependencies

```json
{
  "@anthropic-ai/sdk": "^0.39.0",
  "@supabase/supabase-js": "^2.103.0",
  "dotenv": "^16.4.5",
  "express": "^4.19.2"
}
```

Node.js >= 18 required (for native `fetch`).
