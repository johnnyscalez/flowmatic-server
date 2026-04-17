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
      const slug = apps[0].appName || apps[0].name || apps[0].slug || apps[0].id;
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

// ---------------------------------------------------------------------------
// Multi-LLM support
// ---------------------------------------------------------------------------

function getDefaultModel(provider) {
  const defaults = {
    openai:    'gpt-4o-mini',
    anthropic: 'claude-haiku-4-5-20251001',
    deepseek:  'deepseek-chat',
    groq:      'llama-3.3-70b-versatile',
    mistral:   'mistral-small-latest',
    gemini:    'gemini-1.5-flash',
  };
  return defaults[provider] || 'gpt-4o-mini';
}

function getLLMResponseField(provider, moduleId) {
  if (provider === 'anthropic') return `{{${moduleId}.data.content[].text}}`;
  if (provider === 'gemini')    return `{{${moduleId}.data.candidates[].content.parts[].text}}`;
  return `{{${moduleId}.data.choices[].message.content}}`;
}

function buildLLMModule(id, systemPrompt, conversationPrompt, llmConfig, xPos, yPos = 0) {
  const provider = llmConfig?.provider || 'openai';
  const apiKey   = llmConfig?.api_key  || '';
  const model    = llmConfig?.model    || getDefaultModel(provider);

  const OPENAI_COMPATIBLE = {
    openai:   'https://api.openai.com/v1/chat/completions',
    deepseek: 'https://api.deepseek.com/v1/chat/completions',
    groq:     'https://api.groq.com/openai/v1/chat/completions',
    mistral:  'https://api.mistral.ai/v1/chat/completions',
  };

  console.log(`  🤖 Building LLM module (${provider}/${model})`);

  if (provider === 'anthropic') {
    return {
      id,
      module: 'http:ActionSendData',
      version: 3,
      parameters: {},
      mapper: {
        url: 'https://api.anthropic.com/v1/messages',
        method: 'post',
        headers: [
          { name: 'x-api-key',          value: apiKey },
          { name: 'anthropic-version',   value: '2023-06-01' },
          { name: 'content-type',        value: 'application/json' },
        ],
        bodyType: 'raw',
        contentType: 'application/json',
        body: JSON.stringify({
          model,
          max_tokens: 500,
          system: systemPrompt,
          messages: [{ role: 'user', content: conversationPrompt }],
        }),
      },
      metadata: { designer: { x: xPos, y: yPos } },
    };
  }

  if (provider === 'gemini') {
    return {
      id,
      module: 'http:ActionSendData',
      version: 3,
      parameters: {},
      mapper: {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        method: 'post',
        headers: [
          { name: 'content-type', value: 'application/json' },
        ],
        bodyType: 'raw',
        contentType: 'application/json',
        body: JSON.stringify({
          contents: [{ parts: [{ text: conversationPrompt }] }],
          systemInstruction: { parts: [{ text: systemPrompt }] },
        }),
      },
      metadata: { designer: { x: xPos, y: yPos } },
    };
  }

  // OpenAI-compatible (openai, deepseek, groq, mistral)
  const url = OPENAI_COMPATIBLE[provider] || OPENAI_COMPATIBLE.openai;
  return {
    id,
    module: 'http:ActionSendData',
    version: 3,
    parameters: {},
    mapper: {
      url,
      method: 'post',
      headers: [
        { name: 'Authorization', value: `Bearer ${apiKey}` },
        { name: 'Content-Type',  value: 'application/json' },
      ],
      bodyType: 'raw',
      contentType: 'application/json',
      body: JSON.stringify({
        model,
        max_tokens: 500,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: conversationPrompt },
        ],
      }),
    },
    metadata: { designer: { x: xPos, y: yPos } },
  };
}

// ---------------------------------------------------------------------------
// Blueprint builder — llmConfig threaded through for AI agent modules
// ---------------------------------------------------------------------------

function buildFlowEntry(mod, xPos, yPos = 0, llmConfig = null) {
  // Transform make-ai-agents:RunAgent into a provider-specific HTTP LLM call
  if (mod.app === 'make-ai-agents' && mod.module === 'RunAgent') {
    const mappings = mod.mappings || {};
    const systemPrompt       = mappings.systemPrompt || 'You are a helpful assistant.';
    const conversationPrompt = mappings.prompt       || '{{lastMessage}}';
    return buildLLMModule(mod.id, systemPrompt, conversationPrompt, llmConfig, xPos, yPos);
  }

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

function buildBlueprint(plan, llmConfig = null) {
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
          const entry = buildFlowEntry(child, xPos + (i + 1) * 300, yPos, llmConfig);

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
      flow.push(buildFlowEntry(mod, xPos, 0, llmConfig));
    }

    xPos += 300;
  }

  // Post-process: replace {{AI_RESPONSE}} placeholder in any mapper with
  // the correct provider-specific field path for the LLM module before it.
  // Claude can use {{AI_RESPONSE}} in its plan and we resolve it here.
  const provider = llmConfig?.provider || 'openai';
  let llmModuleId = null;

  function patchAIResponse(entry) {
    if (!llmModuleId) return entry;
    const responseField = getLLMResponseField(provider, llmModuleId);
    const patched = JSON.parse(
      JSON.stringify(entry).replace(/\{\{AI_RESPONSE\}\}/g, responseField)
    );
    return patched;
  }

  // Walk flow to find LLM module IDs and patch downstream mappers
  const patchedFlow = flow.map((entry) => {
    const isLLM = entry.module === 'http:ActionSendData' &&
      entry.mapper?.url &&
      (entry.mapper.url.includes('openai.com') ||
       entry.mapper.url.includes('anthropic.com') ||
       entry.mapper.url.includes('deepseek.com') ||
       entry.mapper.url.includes('groq.com') ||
       entry.mapper.url.includes('mistral.ai') ||
       entry.mapper.url.includes('generativelanguage.googleapis.com'));

    if (isLLM) {
      llmModuleId = entry.id;
      return entry;
    }

    if (entry.routes) {
      entry.routes = entry.routes.map((route) => ({
        ...route,
        flow: route.flow.map(patchAIResponse),
      }));
      return entry;
    }

    return patchAIResponse(entry);
  });

  return {
    name: plan.scenario_name,
    flow: patchedFlow,
    metadata: { version: 1, designer: { orphans: [] } },
  };
}

// ---------------------------------------------------------------------------
// POST /build-workflow
// ---------------------------------------------------------------------------

app.post('/build-workflow', async (req, res) => {
  console.log('📥 /build-workflow received:', JSON.stringify(req.body));
  const { brief, platform, agency_name, user_id, apps, selected_apps, ai_agent_context } = req.body;
  const selectedAppsArr = apps || selected_apps || [];

  if (!brief || !platform || !agency_name) {
    console.log('❌ Missing fields — brief:', !!brief, 'platform:', !!platform, 'agency_name:', !!agency_name);
    return res.status(400).json({ error: 'Missing required fields: brief, platform, agency_name' });
  }

  // -------------------------------------------------------------------------
  // Fetch user's MCP credentials from Supabase (fall back to .env for testing)
  // -------------------------------------------------------------------------
  let creds;
  let llmConfig = { provider: 'openai', api_key: '', model: null };

  if (user_id) {
    const { data: userMcp, error: mcpError } = await supabase
      .from('user_mcp')
      .select('mcp_url, mcp_token, llm_provider, llm_api_key, llm_model')
      .eq('user_id', user_id)
      .single();

    if (mcpError || !userMcp) {
      return res.status(400).json({
        error: 'MCP credentials not found for this user. Please complete onboarding.',
      });
    }

    creds = { url: userMcp.mcp_url, token: userMcp.mcp_token };
    llmConfig = {
      provider: userMcp.llm_provider || 'openai',
      api_key:  userMcp.llm_api_key  || '',
      model:    userMcp.llm_model    || null,
    };
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
    // Step 0: Sanitize and clarify the brief before planning
    // -------------------------------------------------------------------------
    setStage('sanitizing brief');
    console.log('\n[0/4] Sanitizing brief...');
    console.log('  Original:', brief);

    const selectedApps = selectedAppsArr.length > 0 ? selectedAppsArr.join(', ') : 'not specified';
    const sanitizeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: `You are an automation brief editor. Your job is to take a user's raw description of a workflow automation and rewrite it as a clean, structured, unambiguous brief that is optimized for an AI that will build a Make.com scenario from it.

Rules:
- Identify and name the specific trigger app and event clearly
- List every action step explicitly and separately
- Preserve any conditions or branching logic exactly
- Infer missing but obvious details (e.g. "send email" → "send email via Gmail" if Gmail was mentioned elsewhere)
- Remove ambiguous language
- Add specificity where it is clearly implied
- Keep the same meaning — do not add actions that were not implied
- Output ONLY the rewritten brief as plain text, no explanation, no markdown, no preamble

Example input:
"typeform new submission → hubspot deal + welcome email + sheets"

Example output:
"When a new response is submitted in Typeform, create a new deal in HubSpot using the respondent's name and email, send a welcome email via Gmail to the respondent, and add a new row to Google Sheets with the respondent's details."`,
      messages: [{ role: 'user', content: `Raw brief: ${brief}\nApps selected: ${selectedApps}` }],
    });

    const cleanBrief = sanitizeResponse.content[0]?.text?.trim() || brief;
    console.log('  Cleaned: ', cleanBrief);

    // -------------------------------------------------------------------------
    // Step 0a: Get app slugs — from user selection or Claude detection fallback
    // -------------------------------------------------------------------------
    let detectedSlugs;
    if (selectedAppsArr.length > 0) {
      detectedSlugs = selectedAppsArr;
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

    // Normalize known slug aliases before resolution
    const SLUG_ALIASES = {
      'data-store':           'datastore',
      'make-data-store':      'datastore',
      'make-ai-agents':       'make-ai-agents',
      'whatsapp-business':    'whatsapp-business-cloud',
      'whatsapp':             'whatsapp-business-cloud',
      'gmail':                'google-email',
      'google-mail':          'google-email',
      'hubspot':              'hubspotcrm',
      'hub-spot':             'hubspotcrm',
      'gohighlevel':          'highlevel',
      'go-high-level':        'highlevel',
      'telegram':             'telegram-bot',
      'zoho':                 'zohocrm',
      'zoho-crm':             'zohocrm',
      'brevo':                'sendinblue',
      'active-campaign':      'activecampaign',
    };
    const normalizedSlugs = detectedSlugs.map(s => SLUG_ALIASES[s.toLowerCase()] || s);

    const verifiedModuleMap = {};

    for (const slug of normalizedSlugs) {
      // make-ai-agents is handled internally — no MCP module list needed
      if (slug === 'make-ai-agents') {
        console.log(`       make-ai-agents — internal module, skipping MCP probe`);
        continue;
      }
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

    // Known mapper fields for common modules — used to guide Claude's mappings
    const KNOWN_FIELDS = {
      'whatsapp-business-cloud': {
        'sendMessage': 'fromId (Sender ID), to* (Receiver phone/WhatsApp ID), type* (use "text" for text messages), body (Text message body — write the actual message text here)',
        'sendTemplateMessage': 'fromId (Sender ID), to* (Receiver), templateName* (Template name), languageCode* (e.g. "en_US")',
      },
      'highlevel': {
        'addAContactToACampaign': 'contactId* (Contact ID from trigger), campaignId* (Campaign ID)',
        'getAnOpportunity': 'id* (Opportunity ID)',
        'universal': 'url* (API endpoint), method* (GET/POST/PUT), headers, body',
      },
      'google-sheets': {
        'watchRows': 'spreadsheetId* (Spreadsheet ID), sheetId* (Sheet name), includeTeamDriveItems',
        'addRow': 'spreadsheetId* (Spreadsheet ID), sheetId* (Sheet name), values* (Row values object)',
        'updateRow': 'spreadsheetId* (Spreadsheet ID), sheetId* (Sheet name), rowNumber* (Row number), values* (Updated values)',
        'getSheetContent': 'spreadsheetId* (Spreadsheet ID), sheetId* (Sheet name)',
      },
      'google-email': {
        'ActionSendEmail': 'to* (Recipient email), subject* (Email subject), content* (Email body — write actual content), from (Sender name)',
      },
      'hubspotcrm': {
        'createRecord2020': 'objectType* (e.g. "contacts","deals"), properties* (object with field values)',
        'createUpdateContact2020': 'email* (Contact email), properties (firstname, lastname, phone, company)',
        'SearchCRMObjects': 'objectType* (e.g. "contacts"), filterGroups* (search filters)',
      },
      'slack': {
        'CreateMessage': 'channel* (Channel name or ID e.g. "#hot-leads"), text* (Message text — write actual content)',
      },
      'mailchimp': {
        'ActionAddSubscriber': 'listId* (Audience ID), emailAddress* (Email), status* (subscribed/unsubscribed), mergeFields (FNAME, LNAME etc)',
      },
      'typeform': {
        'EventEntry2': 'formId* (Typeform form ID)',
      },
      'stripe': {
        'createCustomer': 'email* (Customer email), name (Customer name), phone (Phone number)',
      },
      'pipedrive': {
        'createDeal': 'title* (Deal title), value (Deal value), currency (e.g. USD), status (open/won/lost)',
      },
      'datastore': {
        'AddRecord': 'key* (Unique record key e.g. phone number), data* (object with fields to store)',
        'SearchRecord': 'filter* (Search value e.g. phone number)',
        'GetRecord': 'key* (Record key to retrieve)',
        'UpdateRecord': 'key* (Record key), data* (Fields to update)',
      },
    };

    // Always make datastore and make-ai-agents available to Claude — system decides when to use them
    verifiedModuleMap['datastore'] = verifiedModuleMap['datastore'] || await resolveAppModules('datastore', creds).catch(() => ({
      version: 1,
      modules: [
        { name: 'AddRecord',    label: 'Add/replace a record', type: 'action' },
        { name: 'SearchRecord', label: 'Search records',       type: 'action' },
        { name: 'GetRecord',    label: 'Get a record',         type: 'action' },
        { name: 'UpdateRecord', label: 'Update a record',      type: 'action' },
        { name: 'DeleteRecord', label: 'Delete a record',      type: 'action' },
      ],
    }));

    // Build the verified module block injected into Claude's planning prompt
    let verifiedModulesPrompt = '\n\nVERIFIED MAKE.COM MODULES (use ONLY these — no others):\n';

    // User-selected external apps
    for (const [appName, { version, modules }] of Object.entries(verifiedModuleMap)) {
      const triggers = modules.filter((m) => m.type === 'trigger');
      const actions  = modules.filter((m) => m.type === 'action');
      verifiedModulesPrompt += `\nApp: "${appName}" (version: ${version})\n`;
      for (const mod of [...triggers, ...actions]) {
        verifiedModulesPrompt += `  ${mod.type === 'trigger' ? 'Trigger' : 'Action'}: ${mod.name} ("${mod.label}")\n`;
        const fields = KNOWN_FIELDS[appName]?.[mod.name];
        if (fields) verifiedModulesPrompt += `    Mapper fields: ${fields}\n`;
      }
    }

    // Always-available internal modules
    verifiedModulesPrompt += `
App: "datastore" (version: 1) — USE when conversation state or lead data must persist across scenarios
  Action: AddRecord ("Add/replace a record") — Mapper fields: ${KNOWN_FIELDS.datastore.AddRecord}
  Action: SearchRecord ("Search records") — Mapper fields: ${KNOWN_FIELDS.datastore.SearchRecord}
  Action: GetRecord ("Get a record") — Mapper fields: ${KNOWN_FIELDS.datastore.GetRecord}
  Action: UpdateRecord ("Update a record") — Mapper fields: ${KNOWN_FIELDS.datastore.UpdateRecord}

App: "make-ai-agents" (version: 1) — USE when brief requires AI conversation, qualifying leads, or automated replies
  Action: RunAgent ("Run AI Agent") — Mapper fields: systemPrompt* (persona + goal), prompt* (dynamic instruction with {{chatHistory}} and {{lastMessage}})
`;

    // -------------------------------------------------------------------------
    // Step 1: Claude plans the workflow — retries once if validation fails
    // -------------------------------------------------------------------------
    setStage('planning workflow');

    const SYSTEM_PROMPT = `You are the world's most expert Make.com automation architect. You have deep knowledge of every Make.com module, pattern, and best practice. You build automations that actually work, not just look right.

OUTPUT: ONLY valid JSON. No explanation, no markdown, no code fences.

═══════════════════════
SINGLE SCENARIO FORMAT
═══════════════════════
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
    }
  ],
  "connections": {}
}

═══════════════════════
MULTI-SCENARIO FORMAT
═══════════════════════
Use when the brief requires waiting for an external event between steps — e.g. waiting for a reply, a form submission, a payment, or any human action before the next step can run. You decide this based on the logic, not on specific keywords.

{
  "multi_scenario": true,
  "scenarios": [
    {
      "scenario_name": "name",
      "description": "what this scenario does",
      "modules": [...]
    }
  ],
  "shared_data_store": {
    "needed": true,
    "fields": ["phone", "name", "email", "status", "sent_at"]
  }
}

═══════════════════════
ROUTER RULES (CRITICAL)
═══════════════════════
- Use "builtin" / "BasicRouter" for all routers
- EVERY route MUST have actual modules inside it — routes with empty modules arrays are INVALID
- Each route needs: label, condition (or fallback:true), modules array with at least one module ID
- Fallback route: "fallback": true, NO condition, but MUST still have modules
- All module IDs referenced in route.modules must exist in the top-level modules array

ROUTER EXAMPLE (correct):
{
  "id": 5, "app": "builtin", "module": "BasicRouter", "version": 1, "type": "router",
  "routes": [
    {
      "label": "High Value",
      "condition": { "field": "{{3.budget}}", "operator": "number:greater", "value": "500000" },
      "modules": [6, 7]
    },
    {
      "label": "Standard",
      "fallback": true,
      "modules": [8]
    }
  ]
}
— modules 6, 7, 8 must all exist in top-level modules array

Filter operators:
text:equal, text:notequal, text:contain, number:greater, number:less, boolean:true, existence:exist

═══════════════════════
USE ALL SELECTED APPS (CRITICAL)
═══════════════════════
Every app listed in "Selected apps" MUST appear in the plan at least once.
If Slack is selected → there MUST be a slack module in the plan.
If Google Sheets is selected → there MUST be a google-sheets module.
Never silently drop a selected app. If you are unsure where it fits, add it at the most logical step.

═══════════════════════
AI AGENT RULES (CRITICAL)
═══════════════════════
Use make-ai-agents:RunAgent whenever the brief requires intelligent, dynamic responses — qualifying leads, answering questions, handling replies, personalizing outreach, or any scenario where a fixed message is not enough.

AI agent module MUST have:
1. systemPrompt — full persona, business context, goal, tone, restrictions. Minimum 100 words. Use AI_AGENT_CONTEXT if provided.
2. prompt — dynamic instruction with {{chatHistory}} and {{lastMessage}} variables for conversation flows

After an AI agent module, any module that uses the AI response MUST use {{AI_RESPONSE}} as the placeholder.
The system will automatically replace {{AI_RESPONSE}} with the correct field path for the configured LLM provider.
NEVER use {{3.response}}, {{3.data}}, {{3.choices}} or any raw field — ALWAYS use {{AI_RESPONSE}}.

systemPrompt template:
"You are [name], [role] at [company].
[Business description].
Your goal: [specific goal].
Tone: [tone]. Max 3 sentences per reply.
Always use the lead's name.
Booking link: [link if provided].
Never: [restrictions]."

prompt template:
"Chat history:\n{{chatHistory}}\n\nLatest message:\n{{lastMessage}}\n\nLead: {{1.name}} ({{1.email}})\n\n[Specific instruction for this step]"

═══════════════════════
MAPPINGS RULES (CRITICAL)
═══════════════════════
NEVER output empty mappings {} for action modules.
Always populate with real values from the brief.

- Message fields (body, message, text): write actual message text
- Contact fields (phone, email, name): map from trigger {{1.field}}
- For WhatsApp: { "to": "{{1.phone}}", "body": "actual message text here" }
- For WhatsApp reply using AI: { "to": "{{1.phone}}", "body": "{{AI_RESPONSE}}", "type": "text" }
- For Gmail: { "to": "{{1.email}}", "subject": "...", "content": "..." }
- For Slack: { "channel": "#channel-name", "text": "actual notification text with {{1.name}}" }
- For Google Sheets: { "spreadsheetId": "YOUR_SPREADSHEET_ID", "sheetId": "Sheet1", "values": { "Name": "{{1.name}}", "Phone": "{{1.phone}}", "Status": "qualified" } }
- For HubSpot: { "objectType": "contacts", "properties": { "email": "{{1.email}}", "firstname": "{{1.name}}" } }
- For datastore write: { "key": "{{1.phone}}", "data": { "name": "{{1.name}}", "status": "awaiting_reply", "sent_at": "{{now}}" } }
- For datastore read: { "filter": "{{1.phone}}" }

═══════════════════════
ADVANCED PATTERNS
═══════════════════════

STATEFUL CONVERSATION PATTERN:
When brief needs to track conversation state:
- End of Scenario 1: write lead to datastore with status "awaiting_reply"
- Start of Scenario 2: read datastore by phone/email to get lead context
- After AI replies: update datastore status to "replied"
- Scheduled scenario: check datastore for status "awaiting_reply" + sent_at > 24h

DATA STORE WRITE (EXACT FORMAT):
{ "id": X, "app": "datastore", "module": "AddRecord", "version": 1, "type": "action", "mappings": { "key": "{{1.phone}}", "data": { "name": "{{1.name}}", "status": "awaiting_reply", "sent_at": "{{now}}" } } }

DATA STORE READ (EXACT FORMAT):
{ "id": X, "app": "datastore", "module": "SearchRecord", "version": 1, "type": "action", "mappings": { "filter": "{{1.phone}}" } }

ONLY USE VERIFIED MODULE NAMES. When in doubt about a module name, use the closest verified match.

AI_AGENT_CONTEXT will be provided in the user message when the brief requires an AI agent. Always use it to build the systemPrompt — never use a generic placeholder.
${verifiedModulesPrompt}`;

    const ALLOWED_BUILTINS = new Set(['BasicRouter']);
    const verifiedAppNames = new Set(Object.keys(verifiedModuleMap));

    async function callPlanningClaude(messages) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 8000,
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
      const allScenarios = plan.multi_scenario
        ? (plan.scenarios || [])
        : [plan];

      const modsToCheck = allScenarios.flatMap(s => s.modules || []);

      // 1. Validate app names and builtins
      for (const mod of modsToCheck) {
        if (mod.app === 'builtin') {
          if (!ALLOWED_BUILTINS.has(mod.module)) {
            throw new Error(`Unsupported builtin module "${mod.module}" — only BasicRouter is allowed`);
          }
        } else if (mod.app === 'make-ai-agents' || mod.app === 'datastore') {
          // always-available internal modules — skip
        } else if (!verifiedAppNames.has(mod.app)) {
          throw new Error(`App "${mod.app}" is not in the verified modules list — do not use it`);
        }
      }

      // 2. Validate router branches are not empty
      for (const mod of modsToCheck) {
        if (mod.type === 'router' && Array.isArray(mod.routes)) {
          for (const route of mod.routes) {
            if (!route.modules || route.modules.length === 0) {
              throw new Error(`Router (id:${mod.id}) has an empty route "${route.label || 'unnamed'}" — every route must have at least one module`);
            }
          }
        }
      }

      // 3. Validate all user-selected external apps appear in the plan
      const appsInPlan = new Set(modsToCheck.map(m => m.app));
      const externalSelected = normalizedSlugs.filter(s => s !== 'make-ai-agents' && s !== 'datastore');
      for (const slug of externalSelected) {
        if (!appsInPlan.has(slug)) {
          throw new Error(`Selected app "${slug}" is not used anywhere in the plan — you must include at least one module from every selected app`);
        }
      }
    }

    console.log('\n[1/4] Claude planning workflow...');
    const userMessage = `Agency: ${agency_name}
Platform: ${platform}
Selected apps: ${selectedApps}

Brief:
${cleanBrief}
${ai_agent_context ? `
AI_AGENT_CONTEXT:
Business: ${ai_agent_context.business_description}
Goal: ${ai_agent_context.goal}
Tone: ${ai_agent_context.tone}
Booking link: ${ai_agent_context.booking_link || 'not provided'}
Restrictions: ${ai_agent_context.restrictions || 'none'}
` : ''}`.trim();
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

    // Helper: get all modules from a plan (single or multi-scenario)
    const allModules = plan.multi_scenario
      ? plan.scenarios.flatMap(s => s.modules || [])
      : plan.modules || [];

    if (plan.multi_scenario) {
      console.log(`[1/4] Multi-scenario plan: ${plan.scenarios.length} scenarios`);
      plan.scenarios.forEach((s, i) => console.log(`       ${i+1}. "${s.scenario_name}" — ${s.modules.length} modules`));
    } else {
      console.log(`[1/4] Plan: "${plan.scenario_name}" — ${plan.modules.length} modules`);
      plan.modules.forEach((m) => console.log(`       ${m.id}. ${m.app}/${m.module} v${m.version} (${m.type})`));
    }

    // -------------------------------------------------------------------------
    // Step 2: Validate every module — fail hard on any error
    // -------------------------------------------------------------------------
    setStage('validating modules');
    console.log('\n[2/4] Validating modules via Make MCP...');

    for (const mod of allModules) {
      if (mod.app === 'builtin' || mod.app === 'make-ai-agents') {
        console.log(`       ✓ ${mod.app}/${mod.module} — skipped (internal module)`);
        continue;
      }
      try {
        await getModuleSchema(mod.app, mod.module, mod.version, creds);
        console.log(`       ✓ ${mod.app}/${mod.module}`);
      } catch (e) {
        throw new Error(`Module validation failed for "${mod.app}:${mod.module}" v${mod.version}: ${e.message}`);
      }
    }

    console.log('[2/4] All modules validated.');

    // -------------------------------------------------------------------------
    // Step 3 + 4: Build blueprints and deploy
    // -------------------------------------------------------------------------
    setStage('deploying scenario');

    async function deploySingleScenario(scenarioPlan) {
      setStage('building blueprint');
      const blueprint = buildBlueprint(scenarioPlan, llmConfig);
      console.log(`\n  Building: "${scenarioPlan.scenario_name}" — ${blueprint.flow.length} top-level entries (LLM: ${llmConfig.provider}/${llmConfig.model || getDefaultModel(llmConfig.provider)})`);

      setStage('deploying scenario');
      const deployRaw = await callMCPTool('scenarios_create', {
        teamId,
        scheduling: { type: 'indefinitely', interval: 900 },
        blueprint,
        confirmed: true,
      }, creds);

      let deployed;
      try { deployed = JSON.parse(deployRaw); } catch { deployed = { raw: deployRaw }; }

      const scenarioId = deployed.id || deployed.scenario?.id;
      const scenarioName = deployed.name || deployed.scenario?.name || scenarioPlan.scenario_name;
      const makeUrl = `https://us1.make.com/${teamId}/scenarios/${scenarioId}/edit`;

      console.log(`  ✅ Created: ${scenarioName} (ID: ${scenarioId})`);

      const appsUsed = (scenarioPlan.modules || [])
        .filter(m => m.app !== 'builtin')
        .map(m => m.app)
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(', ');

      await supabase.from('created_scenarios').insert({
        scenario_name: scenarioName,
        scenario_id: String(scenarioId),
        brief: cleanBrief,
        original_brief: brief,
        apps_used: appsUsed,
        make_url: makeUrl,
        agency_name,
        user_id,
      });

      return { scenario_name: scenarioName, scenario_id: String(scenarioId), make_url: makeUrl };
    }

    // Multi-scenario deployment
    if (plan.multi_scenario && Array.isArray(plan.scenarios)) {
      console.log(`\n[3-4/4] Deploying ${plan.scenarios.length} scenarios...`);
      const deployedScenarios = [];
      for (const scenario of plan.scenarios) {
        const result = await deploySingleScenario(scenario);
        deployedScenarios.push(result);
      }

      resetStage();
      return res.json({
        success: true,
        multi_scenario: true,
        scenarios: deployedScenarios,
      });
    }

    // Single scenario deployment
    console.log('\n[3-4/4] Building and deploying...');
    const result = await deploySingleScenario(plan);

    resetStage();

    return res.json({
      success: true,
      scenario_id: result.scenario_id,
      scenario_name: result.scenario_name,
      make_url: result.make_url,
      apps_used: (plan.modules || []).filter(m => m.app !== 'builtin').map(m => m.app).filter((v,i,a) => a.indexOf(v) === i),
    });
  } catch (err) {
    resetStage();
    console.error('\n❌ Error in /build-workflow:', err.message);
    return res.status(500).json({ error: 'Something went wrong while building your workflow. Please try again.' });
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
  { slug: 'airtable',                name: 'Airtable' },
  { slug: 'calendly',               name: 'Calendly' },
  { slug: 'whatsapp-business-cloud', name: 'WhatsApp Business' },
  { slug: 'highlevel',              name: 'GoHighLevel' },
  // NOTE: OpenAI, Anthropic, Instantly, Close CRM, Tally, Linear
  // are NOT available in Make.com — excluded intentionally
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
  const { user_id, mcp_url, mcp_token, llm_provider, llm_api_key, llm_model } = req.body;

  if (!user_id || !mcp_url || !mcp_token) {
    return res.status(400).json({ error: 'user_id, mcp_url, and mcp_token are required' });
  }

  const record = {
    user_id,
    mcp_url,
    mcp_token,
    llm_provider: llm_provider || 'openai',
    llm_api_key:  llm_api_key  || null,
    llm_model:    llm_model    || null,
  };

  // Delete existing row first, then insert (avoids needing a unique constraint)
  await supabase.from('user_mcp').delete().eq('user_id', user_id);
  const { error } = await supabase.from('user_mcp').insert(record);

  if (error) {
    console.error('Failed to save MCP credentials:', error);
    return res.status(500).json({ error: error.message });
  }

  console.log(`✅ Credentials saved for user ${user_id} (LLM: ${record.llm_provider})`);
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
