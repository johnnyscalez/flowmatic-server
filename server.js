require('dotenv').config();

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const app = express();

// CORS — allow requests from any origin (Lovable frontend, ngrok, localhost)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAKE_ORGANIZATION_ID = 1735429;
const GOOGLE_CONNECTION_ID = 3198221;
const CACHE_PATH = path.join(__dirname, 'cache', 'make-modules.json');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 600000,
  maxRetries: 2,
});

// ---------------------------------------------------------------------------
// Pipeline stage tracker
// ---------------------------------------------------------------------------

let pipelineStatus = { status: 'idle', stage: null };

function setStage(stage) {
  pipelineStatus = { status: 'running', stage };
}

function resetStage() {
  pipelineStatus = { status: 'idle', stage: null };
}

// ---------------------------------------------------------------------------
// Module cache — persists to disk so each app is only looked up once ever
// ---------------------------------------------------------------------------

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ---------------------------------------------------------------------------
// Make MCP caller — creds = { url, token } passed per-request from Supabase
// ---------------------------------------------------------------------------

async function callMCP(method, params = {}, creds) {
  const body = { jsonrpc: '2.0', id: Date.now(), method, params };

  const response = await fetch(creds.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MCP HTTP ${response.status}: ${text}`);
  }

  const contentType = response.headers.get('content-type') || '';
  let data;
  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    const lines = text.split('\n').filter((l) => l.startsWith('data: '));
    const last = lines[lines.length - 1]?.replace('data: ', '').trim();
    if (!last) throw new Error('MCP SSE response contained no data lines');
    data = JSON.parse(last);
  } else {
    data = await response.json();
  }

  if (data.error) {
    throw new Error(`MCP error: ${JSON.stringify(data.error)}`);
  }

  return data.result;
}

async function callMCPTool(toolName, args, creds) {
  console.log(`  → MCP tool: ${toolName}`);
  const result = await callMCP('tools/call', { name: toolName, arguments: args }, creds);

  if (result.isError) {
    const msg = result.content?.[0]?.text || 'Unknown MCP tool error';
    throw new Error(`MCP tool "${toolName}" error: ${msg}`);
  }

  const text = result.content?.[0]?.text;
  if (!text) throw new Error(`MCP tool "${toolName}" returned no content`);
  return text;
}

// ---------------------------------------------------------------------------
// App detection via Claude (Haiku) — returns Make.com app slugs from brief
// ---------------------------------------------------------------------------

async function detectAppsWithClaude(brief) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: `You identify Make.com app slugs needed for an automation brief.
Output ONLY a JSON array of app slugs — no explanation, no markdown.
Use exact Make.com slug format: lowercase, hyphenated (e.g. "google-sheets", "hubspotcrm", "facebook-lead-ads").
Common slugs: gmail→"google-email", google sheets→"google-sheets", hubspot→"hubspotcrm",
facebook lead ads→"facebook-lead-ads", typeform→"typeform", slack→"slack",
mailchimp→"mailchimp", airtable→"airtable", notion→"notion", stripe→"stripe",
pipedrive→"pipedrive", salesforce→"salesforce", jira→"jira", trello→"trello",
shopify→"shopify", woocommerce→"woocommerce", calendly→"calendly",
google calendar→"google-calendar", google drive→"google-drive",
instagram→"instagram", twitter→"twitter", linkedin→"linkedin",
openai→"openai", webhook→"gateway", http request→"http".`,
    messages: [{ role: 'user', content: brief }],
  });

  const text = response.content[0]?.text?.trim() || '[]';
  try {
    const slugs = JSON.parse(text.replace(/^```json\s*/m, '').replace(/```\s*$/m, '').trim());
    return Array.isArray(slugs) ? slugs : [];
  } catch {
    console.warn('  ⚠ Claude slug detection returned invalid JSON:', text);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Resolve a user-facing app name to a real Make.com slug via MCP apps_recommend
// ---------------------------------------------------------------------------

// Persistent slug mapping cache (name → slug)
const SLUG_MAP_PATH = path.join(__dirname, 'cache', 'slug-map.json');

function loadSlugMap() {
  try { return JSON.parse(fs.readFileSync(SLUG_MAP_PATH, 'utf8')); } catch { return {}; }
}

function saveSlugMap(map) {
  try { fs.writeFileSync(SLUG_MAP_PATH, JSON.stringify(map, null, 2)); } catch {}
}

async function resolveSlugFromName(appName, creds) {
  // Check slug map cache first
  const slugMap = loadSlugMap();
  const key = appName.toLowerCase().trim();
  if (slugMap[key]) {
    console.log(`       slug-map hit: "${appName}" → "${slugMap[key]}"`);
    return slugMap[key];
  }

  console.log(`       Asking MCP apps_recommend for: "${appName}"...`);
  try {
    const raw = await callMCPTool('apps_recommend', {
      intention: `I need to use ${appName} in my automation`,
      organizationId: MAKE_ORGANIZATION_ID,
    }, creds);

    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const apps = Array.isArray(parsed) ? parsed : parsed?.apps || parsed?.result || [];

    if (apps.length > 0) {
      const slug = apps[0].name || apps[0].slug || apps[0].id;
      console.log(`       apps_recommend: "${appName}" → "${slug}"`);
      // Cache it for future requests
      slugMap[key] = slug;
      saveSlugMap(slugMap);
      return slug;
    }
  } catch (e) {
    console.warn(`       apps_recommend failed for "${appName}": ${e.message}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Module resolution — cache-first, MCP probe on miss
// ---------------------------------------------------------------------------

async function resolveAppModules(appSlug, creds) {
  const cache = loadCache();

  if (cache[appSlug]) {
    console.log(`       ${appSlug} — cache hit (v${cache[appSlug].version})`);
    return cache[appSlug];
  }

  console.log(`       ${appSlug} — not in cache, probing MCP...`);
  for (let version = 1; version <= 6; version++) {
    try {
      const raw = await callMCPTool('app-modules_list', {
        organizationId: MAKE_ORGANIZATION_ID,
        appName: appSlug,
        appVersion: version,
      }, creds);
      const parsed = JSON.parse(raw);
      const modules = parsed.map((m) => ({
        name: m.name,
        label: m.label,
        type: m.listener ? 'trigger' : 'action',
      }));

      const entry = { version, modules };
      cache[appSlug] = entry;
      saveCache(cache);
      console.log(`       ${appSlug} — found at v${version}, cached (${modules.length} modules)`);
      return entry;
    } catch {
      // try next version
    }
  }

  throw new Error(`App "${appSlug}" not found in Make MCP at any version (1–6)`);
}

// ---------------------------------------------------------------------------
// Module schema validation
// ---------------------------------------------------------------------------

async function getModuleSchema(appName, moduleName, appVersion, creds) {
  const raw = await callMCPTool('app-module_get', {
    organizationId: MAKE_ORGANIZATION_ID,
    appName,
    appVersion,
    moduleName,
  }, creds);

  let schema;
  try {
    schema = JSON.parse(raw);
  } catch {
    return { appName, moduleName, note: 'schema not parseable' };
  }

  return {
    appName,
    moduleName,
    requiredFields: (schema.interface || [])
      .filter((f) => f.required)
      .map((f) => ({ name: f.name, type: f.type })),
    allFields: (schema.interface || []).map((f) => f.name),
  };
}

// ---------------------------------------------------------------------------
// Build Make.com blueprint from Claude plan
// ---------------------------------------------------------------------------

const GOOGLE_APPS = new Set([
  'google-email', 'google-sheets', 'google-calendar',
  'google-drive', 'gmail', 'google-docs',
]);

function buildFlowEntry(mod, xPos, yPos = 0) {
  const parameters = {};
  if (GOOGLE_APPS.has(mod.app)) {
    parameters.__IMTCONN__ = GOOGLE_CONNECTION_ID;
  }
  return {
    id: mod.id,
    module: `${mod.app}:${mod.module}`,
    version: mod.version,
    parameters,
    mapper: mod.mappings || {},
    metadata: { designer: { x: xPos, y: yPos } },
  };
}

function buildBlueprint(plan) {
  const modById = {};
  for (const mod of plan.modules) modById[mod.id] = mod;

  const nestedIds = new Set();
  for (const mod of plan.modules) {
    if (mod.type === 'router' && Array.isArray(mod.routes)) {
      for (const route of mod.routes) {
        for (const id of route.modules || []) nestedIds.add(id);
      }
    }
  }

  const flow = [];
  let xPos = 0;

  for (const mod of plan.modules) {
    if (nestedIds.has(mod.id)) continue;

    // Skip unsupported builtins (only BasicRouter is valid)
    if (mod.app === 'builtin' && mod.module !== 'BasicRouter') {
      console.warn(`⚠️  Skipping unsupported builtin module: ${mod.module}`);
      continue;
    }

    if (mod.type === 'router' && Array.isArray(mod.routes)) {
      const routes = mod.routes.map((route, routeIndex) => {
        const yPos = routeIndex * 300;
        const routeFlow = (route.modules || []).map((id, i) => {
          const child = modById[id];
          if (!child) return null;
          const entry = buildFlowEntry(child, xPos + (i + 1) * 300, yPos);

          if (i === 0) {
            if (!route.fallback && route.condition) {
              const c = route.condition;
              entry.filter = {
                name: route.label || 'Route',
                conditions: [[{ a: c.field, b: c.value, o: c.operator }]],
              };
            } else {
              entry.filter = { name: route.label || 'Fallback', conditions: [] };
            }
          }

          return entry;
        }).filter(Boolean);

        return { flow: routeFlow };
      });

      flow.push({
        id: mod.id,
        module: 'builtin:BasicRouter',
        version: mod.version,
        parameters: {},
        mapper: {},
        metadata: { designer: { x: xPos, y: 0 } },
        routes,
      });
    } else {
      flow.push(buildFlowEntry(mod, xPos));
    }

    xPos += 300;
  }

  return {
    name: plan.scenario_name,
    flow,
    metadata: { version: 1, designer: { orphans: [] } },
  };
}

// ---------------------------------------------------------------------------
// POST /build-workflow
// ---------------------------------------------------------------------------

app.post('/build-workflow', async (req, res) => {
  console.log('📥 /build-workflow received:', JSON.stringify(req.body));
  const { brief, platform, agency_name, user_id, apps } = req.body;

  if (!brief || !platform || !agency_name) {
    console.log('❌ Missing fields — brief:', !!brief, 'platform:', !!platform, 'agency_name:', !!agency_name);
    return res.status(400).json({ error: 'Missing required fields: brief, platform, agency_name' });
  }

  // -------------------------------------------------------------------------
  // Fetch user's MCP credentials from Supabase (fall back to .env for testing)
  // -------------------------------------------------------------------------
  let creds;

  if (user_id) {
    const { data: userMcp, error: mcpError } = await supabase
      .from('user_mcp')
      .select('mcp_url, mcp_token')
      .eq('user_id', user_id)
      .single();

    if (mcpError || !userMcp) {
      return res.status(400).json({
        error: 'MCP credentials not found for this user. Please complete onboarding.',
      });
    }

    creds = { url: userMcp.mcp_url, token: userMcp.mcp_token };
  } else {
    // No user_id — use server-level credentials from .env (dev/test fallback)
    if (!process.env.MAKE_MCP_URL || !process.env.MAKE_MCP_TOKEN) {
      return res.status(400).json({ error: 'Missing user_id and no fallback MCP credentials configured' });
    }
    creds = { url: process.env.MAKE_MCP_URL, token: process.env.MAKE_MCP_TOKEN };
    console.log('⚠️  No user_id provided — using server-level MCP credentials');
  }

  // Discover team_id from the user's MCP account
  let teamId;
  {
    console.log('[auth] No team_id stored — discovering from MCP teams_list...');
    try {
      const teamsRaw = await callMCPTool('teams_list', { organizationId: MAKE_ORGANIZATION_ID }, creds);
      const teams = JSON.parse(teamsRaw);
      teamId = teams?.[0]?.id;
      console.log(`[auth] Discovered team_id: ${teamId}`);
    } catch (e) {
      console.warn('[auth] Could not discover team_id:', e.message);
    }
  }

  console.log(`\n[auth] User: ${user_id} | Team: ${teamId} | MCP: ${creds.url.slice(0, 50)}...`);

  try {
    // -------------------------------------------------------------------------
    // Step 0a: Get app slugs — from user selection or Claude detection fallback
    // -------------------------------------------------------------------------
    let detectedSlugs;
    if (Array.isArray(apps) && apps.length > 0) {
      detectedSlugs = apps;
      console.log(`\n[0/4] Apps provided by user: ${detectedSlugs.join(', ')}`);
    } else {
      setStage('detecting apps');
      console.log('\n[0/4] No apps provided — detecting from brief via Claude...');
      detectedSlugs = await detectAppsWithClaude(brief);
      console.log(`[0/4] Detected slugs: ${detectedSlugs.join(', ') || 'none'}`);
    }

    // -------------------------------------------------------------------------
    // Step 0b: Resolve each app's module list — cache-first, MCP on miss
    // -------------------------------------------------------------------------
    setStage('resolving module lists');
    const verifiedModuleMap = {};

    for (const slug of detectedSlugs) {
      try {
        const entry = await resolveAppModules(slug, creds);
        verifiedModuleMap[slug] = entry;
      } catch (e) {
        // Slug didn't work — ask Make MCP for the real slug via apps_recommend
        console.warn(`       ⚠ "${slug}" failed (${e.message}) — trying apps_recommend...`);
        const realSlug = await resolveSlugFromName(slug, creds);
        if (realSlug && realSlug !== slug) {
          try {
            const entry = await resolveAppModules(realSlug, creds);
            verifiedModuleMap[realSlug] = entry;
            console.log(`       ✓ resolved "${slug}" → "${realSlug}"`);
          } catch (e2) {
            console.warn(`       ⚠ "${realSlug}" also failed — skipping`);
          }
        } else {
          console.warn(`       ⚠ "${slug}" — not found in Make.com, skipping`);
        }
      }
    }

    // Build the verified module block injected into Claude's planning prompt
    let verifiedModulesPrompt = '';
    if (Object.keys(verifiedModuleMap).length > 0) {
      verifiedModulesPrompt = '\n\nVERIFIED MAKE.COM MODULES (use ONLY these — no others):\n';
      for (const [appName, { version, modules }] of Object.entries(verifiedModuleMap)) {
        const triggers = modules.filter((m) => m.type === 'trigger');
        const actions = modules.filter((m) => m.type === 'action');
        verifiedModulesPrompt += `\nApp: "${appName}" (version: ${version})\n`;
        if (triggers.length) verifiedModulesPrompt += `  Triggers: ${triggers.map((m) => `${m.name} ("${m.label}")`).join(', ')}\n`;
        if (actions.length) verifiedModulesPrompt += `  Actions: ${actions.map((m) => `${m.name} ("${m.label}")`).join(', ')}\n`;
      }
    }

    // -------------------------------------------------------------------------
    // Step 1: Claude plans the workflow — retries once if validation fails
    // -------------------------------------------------------------------------
    setStage('planning workflow');

    const SYSTEM_PROMPT = `You are a Make.com workflow architect. Output ONLY a valid JSON plan — no explanation, no markdown, no code fences.

Required format:
{
  "scenario_name": "descriptive name",
  "modules": [
    {
      "id": 1,
      "app": "exact-app-slug",
      "module": "ExactModuleName",
      "version": 1,
      "type": "trigger",
      "mappings": {}
    },
    {
      "id": 2,
      "app": "builtin",
      "module": "BasicRouter",
      "version": 1,
      "type": "router",
      "routes": [
        {
          "label": "Branch label",
          "condition": {
            "field": "{{1.fieldName}}",
            "operator": "number:greater",
            "value": "50"
          },
          "modules": [3, 4]
        },
        {
          "label": "Fallback label",
          "fallback": true,
          "modules": [5]
        }
      ]
    },
    {
      "id": 3,
      "app": "exact-app-slug",
      "module": "ExactModuleName",
      "version": 1,
      "type": "action",
      "mappings": { "fieldName": "{{1.fieldName}}" }
    }
  ],
  "connections": {
    "google-email": "google-restricted"
  }
}

Router rules:
- Use "builtin" / "BasicRouter" for all routers
- Each route: "label", optional "condition", "modules" array of ids
- Fallback route: "fallback": true, NO condition
- All modules in route.modules must also be full entries in top-level "modules" array

Filter operators: "text:equal", "text:notequal", "number:greater", "number:less", "text:contain", "boolean:true", "existence:exist"

General rules:
- CRITICAL: use ONLY module names from VERIFIED MAKE.COM MODULES below
- CRITICAL: the ONLY valid builtin module is "BasicRouter". Never use Sleep, Delay, Iterator, Aggregator, or any other builtin — they are not supported
- CRITICAL: never use "openai" — it is not available in Make.com. If the brief mentions AI/GPT/OpenAI, ignore that requirement and build the workflow without it
- "version" must match the app version listed
- First module is always the trigger (id: 1)
- Use {{moduleId.fieldName}} for data mappings
- Only list apps needing OAuth in "connections"${verifiedModulesPrompt}`;

    const ALLOWED_BUILTINS = new Set(['BasicRouter']);
    const verifiedAppNames = new Set(Object.keys(verifiedModuleMap));

    async function callPlanningClaude(messages) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages,
      });
      const text = response.content[0]?.text;
      if (!text) throw new Error('Claude returned no plan');
      const cleaned = text.replace(/^```json\s*/m, '').replace(/^```\s*/m, '').replace(/```\s*$/m, '').trim();
      try {
        return JSON.parse(cleaned);
      } catch (e) {
        throw new Error(`Claude plan is not valid JSON: ${e.message}\n\nRaw:\n${text}`);
      }
    }

    function validatePlan(plan) {
      for (const mod of plan.modules) {
        if (mod.app === 'builtin') {
          if (!ALLOWED_BUILTINS.has(mod.module)) {
            throw new Error(`Unsupported builtin module "${mod.module}" — only BasicRouter is allowed`);
          }
        } else if (!verifiedAppNames.has(mod.app)) {
          throw new Error(`App "${mod.app}" is not in the verified modules list — do not use it`);
        }
      }
    }

    console.log('\n[1/4] Claude planning workflow...');
    const userMessage = `Agency: ${agency_name}\nPlatform: ${platform}\n\nBrief:\n${brief}`;
    let plan;

    try {
      plan = await callPlanningClaude([{ role: 'user', content: userMessage }]);
      validatePlan(plan);
    } catch (firstErr) {
      console.warn(`[1/4] First plan failed: ${firstErr.message} — retrying with correction...`);
      setStage('planning workflow (retry)');
      // Send Claude the error so it can fix it
      const retryMessages = [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: JSON.stringify(plan || {}) },
        { role: 'user', content: `Your plan is invalid: ${firstErr.message}. Output a corrected JSON plan using ONLY the verified modules listed. Do not use any other apps or builtins.` },
      ];
      plan = await callPlanningClaude(retryMessages);
      validatePlan(plan); // if this fails again, propagate the error
    }

    console.log(`[1/4] Plan: "${plan.scenario_name}" — ${plan.modules.length} modules`);
    plan.modules.forEach((m) => console.log(`       ${m.id}. ${m.app}/${m.module} v${m.version} (${m.type})`));

    // -------------------------------------------------------------------------
    // Step 2: Validate every module — fail hard on any error
    // -------------------------------------------------------------------------
    setStage('validating modules');
    console.log('\n[2/4] Validating modules via Make MCP...');

    const schemas = {};
    for (const mod of plan.modules) {
      if (mod.app === 'builtin') {
        console.log(`       ✓ builtin/${mod.module} — allowed builtin`);
        continue;
      }

      try {
        schemas[mod.id] = await getModuleSchema(mod.app, mod.module, mod.version, creds);
        console.log(`       ✓ ${mod.app}/${mod.module}`);
      } catch (e) {
        throw new Error(`Module validation failed for "${mod.app}:${mod.module}" v${mod.version}: ${e.message}`);
      }
    }

    console.log('[2/4] All modules validated.');

    // -------------------------------------------------------------------------
    // Step 3: Build the complete Make.com blueprint JSON
    // -------------------------------------------------------------------------
    setStage('building blueprint');
    console.log('\n[3/4] Building blueprint...');

    const blueprint = buildBlueprint(plan);
    console.log(`[3/4] Blueprint ready — ${blueprint.flow.length} top-level flow entries.`);

    // -------------------------------------------------------------------------
    // Step 4: Deploy via user's MCP
    // -------------------------------------------------------------------------
    setStage('deploying scenario');
    console.log('\n[4/4] Deploying to Make via MCP...');

    const deployRaw = await callMCPTool('scenarios_create', {
      teamId,
      scheduling: { type: 'indefinitely', interval: 900 },
      blueprint,
      confirmed: true,
    }, creds);

    let scenario;
    try {
      scenario = JSON.parse(deployRaw);
    } catch {
      scenario = { raw: deployRaw };
    }

    const scenarioId = scenario.id || scenario.scenario?.id;
    const scenarioName = scenario.name || scenario.scenario?.name || plan.scenario_name;
    console.log('[4/4] Scenario created:', scenarioId);

    // -------------------------------------------------------------------------
    // Step 5: Save to Supabase (non-blocking)
    // -------------------------------------------------------------------------
    const appsUsed = plan.modules
      .filter((m) => m.app !== 'builtin')
      .map((m) => m.app)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(', ');

    const { error: sbError } = await supabase.from('created_scenarios').insert({
      scenario_name: scenarioName,
      scenario_id: String(scenarioId),
      brief,
      apps_used: appsUsed,
      make_url: `https://us1.make.com/${teamId}/scenarios/${scenarioId}/edit`,
      agency_name,
      user_id,
    });

    if (sbError) {
      console.error('⚠ Supabase insert failed (scenario was still created):', sbError.message);
    } else {
      console.log('[5/5] Saved to Supabase.');
    }

    resetStage();

    const makeUrl = `https://us1.make.com/${teamId}/scenarios/${scenarioId}/edit`;

    return res.json({
      success: true,
      scenario_id: scenarioId,
      scenario_name: scenarioName,
      make_url: makeUrl,
      apps_used: plan.modules.filter(m => m.app !== 'builtin').map(m => m.app).filter((v,i,a) => a.indexOf(v) === i),
    });
  } catch (err) {
    resetStage();
    console.error('\n❌ Error in /build-workflow:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Status endpoint
// ---------------------------------------------------------------------------

app.get('/status', (_req, res) => res.json(pipelineStatus));

// ---------------------------------------------------------------------------
// List available apps (for Lovable app picker UI)
// ---------------------------------------------------------------------------

// Make.com slug → display name
// Only include apps that actually exist in Make.com
const SUPPORTED_APPS = [
  { slug: 'google-sheets',     name: 'Google Sheets' },
  { slug: 'google-email',      name: 'Gmail' },
  { slug: 'google-docs',       name: 'Google Docs' },
  { slug: 'google-drive',      name: 'Google Drive' },
  { slug: 'google-calendar',   name: 'Google Calendar' },
  { slug: 'google-ads',        name: 'Google Ads' },
  { slug: 'slack',             name: 'Slack' },
  { slug: 'telegram-bot',      name: 'Telegram' },
  { slug: 'discord',           name: 'Discord' },
  { slug: 'intercom',          name: 'Intercom' },
  { slug: 'twilio',            name: 'Twilio' },
  { slug: 'mailchimp',         name: 'Mailchimp' },
  { slug: 'sendinblue',        name: 'Brevo' },
  { slug: 'activecampaign',    name: 'ActiveCampaign' },
  { slug: 'klaviyo',           name: 'Klaviyo' },
  { slug: 'hubspotcrm',        name: 'HubSpot' },
  { slug: 'salesforce',        name: 'Salesforce' },
  { slug: 'pipedrive',         name: 'Pipedrive' },
  { slug: 'zohocrm',           name: 'Zoho CRM' },
  { slug: 'typeform',          name: 'Typeform' },
  { slug: 'jotform',           name: 'JotForm' },
  { slug: 'notion',            name: 'Notion' },
  { slug: 'asana',             name: 'Asana' },
  { slug: 'trello',            name: 'Trello' },
  { slug: 'monday',            name: 'Monday.com' },
  { slug: 'clickup',           name: 'ClickUp' },
  { slug: 'jira',              name: 'Jira' },
  { slug: 'shopify',           name: 'Shopify' },
  { slug: 'woocommerce',       name: 'WooCommerce' },
  { slug: 'stripe',            name: 'Stripe' },
  { slug: 'wordpress',         name: 'WordPress' },
  { slug: 'webflow',           name: 'Webflow' },
  { slug: 'facebook-lead-ads', name: 'Facebook Lead Ads' },
  { slug: 'linkedin',          name: 'LinkedIn' },
  { slug: 'dropbox',           name: 'Dropbox' },
  { slug: 'onedrive',          name: 'OneDrive' },
  { slug: 'github',            name: 'GitHub' },
  { slug: 'gitlab',            name: 'GitLab' },
  { slug: 'airtable',          name: 'Airtable' },
  { slug: 'calendly',          name: 'Calendly' },
  // NOTE: OpenAI, Anthropic, Instantly, GoHighLevel, Close CRM, Tally,
  // WhatsApp Business, Linear are NOT available in Make.com — excluded intentionally
];

app.get('/apps', (_req, res) => {
  const cached = loadCache();
  const apps = SUPPORTED_APPS.map(({ slug, name }) => ({
    slug,
    name,
    cached: !!cached[slug],
  }));
  return res.json({ apps });
});

// ---------------------------------------------------------------------------
// Save MCP credentials (called by Lovable onboarding form)
// ---------------------------------------------------------------------------

app.post('/save-mcp-credentials', async (req, res) => {
  const { user_id, mcp_url, mcp_token } = req.body;

  if (!user_id || !mcp_url || !mcp_token) {
    return res.status(400).json({ error: 'user_id, mcp_url, and mcp_token are required' });
  }

  // Delete existing row first, then insert (avoids needing a unique constraint)
  await supabase.from('user_mcp').delete().eq('user_id', user_id);
  const { error } = await supabase.from('user_mcp').insert({ user_id, mcp_url, mcp_token });

  if (error) {
    console.error('Failed to save MCP credentials:', error);
    return res.status(500).json({ error: error.message });
  }

  console.log(`✅ MCP credentials saved for user ${user_id}`);
  return res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Module cache: ${Object.keys(loadCache()).length} apps pre-loaded`);
});
