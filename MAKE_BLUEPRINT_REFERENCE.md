# Make.com Blueprint Reference — Expert Guide

## Core Blueprint Structure
{
  "name": "Scenario Name",
  "flow": [...modules],
  "metadata": { "version": 1, "designer": { "orphans": [] } }
}

## Module Object
{
  "id": 1,
  "module": "app-slug:ModuleName",
  "version": 1,
  "parameters": { "__IMTCONN__": CONNECTION_ID },
  "mapper": { "field": "value" },
  "metadata": { "designer": { "x": 0, "y": 0 } }
}

Rules:
- module = "app-slug:ModuleName" always colon-separated
- parameters = connection IDs and static config
- mapper = dynamic field mappings using {{moduleId.field}}
- x position = moduleIndex * 300, y = 0 for linear flows

## Data Mapping Syntax
{{1.email}} — email from module 1
{{1.full_name}} — full_name from module 1
{{1.answers.company_size}} — nested field
{{2.id}} — id from module 2
{{lastMessage}} — last WhatsApp message (in agent context)
{{chatHistory}} — full conversation history (in agent context)

## Router Module
- Goes in top-level flow array
- Branch modules go inside route.flow array NOT top-level
- Fallback route has conditions: [] (empty array, not null)

```json
{
  "id": 2,
  "module": "builtin:BasicRouter",
  "version": 1,
  "parameters": {},
  "mapper": {},
  "metadata": { "designer": { "x": 300, "y": 0 } },
  "routes": [
    {
      "flow": [ ],
      "filter": {
        "name": "High value lead",
        "conditions": [[{ "a": "{{1.budget}}", "b": "5000", "o": "number:greater" }]]
      }
    },
    {
      "flow": [ ],
      "filter": { "name": "Default", "conditions": [] }
    }
  ]
}
```

## Filter Operators
text:equal, text:notequal, text:contain, text:notcontain
number:greater, number:less, number:greaterequal, number:lessequal, number:equal
boolean:true, boolean:false
existence:exist, existence:notexist

## Make AI Agents Module — CRITICAL

This is how you add AI conversation capability to a Make scenario.

App: "make-ai-agents"
Module: "RunAgent" (for running an agent with a prompt)

The AI agent has TWO critical fields:
1. systemPrompt — defines who the agent is and how it behaves (static)
2. prompt — the instruction for THIS specific run (dynamic, uses variables)

Blueprint entry:
```json
{
  "id": 3,
  "module": "make-ai-agents:RunAgent",
  "version": 1,
  "parameters": {},
  "mapper": {
    "systemPrompt": "You are [NAME], a [ROLE] at [COMPANY]. [COMPANY_DESCRIPTION]. Your goal is to [GOAL]. Always be [TONE]. Never [RESTRICTIONS]. If the lead wants to book a call share this link: [BOOKING_LINK]. Keep responses under 3 sentences.",
    "prompt": "Chat history:\n{{chatHistory}}\n\nLatest message from lead:\n{{lastMessage}}\n\nLead details:\nName: {{1.name}}\nEmail: {{1.email}}\nSource: Facebook Lead Ads\n\nReply to their latest message to move them toward booking a consultation."
  },
  "metadata": { "designer": { "x": 600, "y": 0 } }
}
```

CRITICAL RULES FOR AI AGENT:
- systemPrompt = full persona definition, business context, 
  goal, tone, restrictions, booking link
- prompt = dynamic instruction using {{variables}} from 
  previous modules AND conversation context
- Always include {{chatHistory}} and {{lastMessage}} in prompt
  when building conversation flows
- systemPrompt should be 100-300 words — detailed enough to 
  sound like a real person
- Never leave systemPrompt generic — always tailor to the 
  business context provided by the user

## AI Agent System Prompt Template

Use this template when building agent system prompts:

"You are [AGENT_NAME], [ROLE] at [COMPANY_NAME].

[COMPANY_DESCRIPTION — 2-3 sentences about what the business does]

Your goal in this conversation is to [SPECIFIC_GOAL].

How you communicate:
- Tone: [TONE — friendly/professional/casual/direct]
- Keep responses concise — maximum 3 sentences
- Always personalize using the lead's name
- [ANY_SPECIFIC_STYLE_RULES]

What you can offer:
- [OFFER_1]
- [OFFER_2]
- Booking link: [BOOKING_LINK]

What you must never do:
- [RESTRICTION_1]
- [RESTRICTION_2]
- Never mention competitors
- Never make promises about specific results

If the lead is ready to book: share the booking link directly.
If the lead has objections: address them warmly and redirect to value.
If the lead is unresponsive: ask one simple engaging question."

## Multi-Scenario Pattern

When a brief requires multiple scenarios (detected by keywords like
"wait for reply", "when they respond", "follow up after X hours"),
output this format:

```json
{
  "multi_scenario": true,
  "scenarios": [
    {
      "scenario_name": "Lead Capture and First Contact",
      "description": "Triggers on new lead, sends initial message",
      "modules": []
    },
    {
      "scenario_name": "Reply Handler and AI Conversation", 
      "description": "Triggers when lead replies, runs AI agent",
      "modules": []
    },
    {
      "scenario_name": "24 Hour Follow Up",
      "description": "Scheduled check for non-responders",
      "modules": []
    }
  ],
  "shared_data_store": {
    "needed": true,
    "fields": ["lead_id", "phone", "name", "email", "status", "last_contact"]
  }
}
```

## Data Store Pattern (Stateful Conversations)

Use when tracking conversation state across multiple scenarios.

Write to data store (end of Scenario 1):
```json
{
  "module": "data-store:AddUpdateRecord",
  "version": 1,
  "mapper": {
    "key": "{{1.phone}}",
    "data": {
      "name": "{{1.name}}",
      "email": "{{1.email}}",
      "status": "awaiting_reply",
      "sent_at": "{{now}}"
    }
  }
}
```

Read from data store (start of Scenario 2):
```json
{
  "module": "data-store:SearchRecords",
  "version": 1, 
  "mapper": {
    "filter": "{{1.phone}}"
  }
}
```

## Scheduling Object
{ "type": "indefinitely", "interval": 900 }
For scheduled scenarios: { "type": "cron", "cron": "0 9 * * 1" }

## Common App Slugs
facebook-lead-ads, google-email, google-sheets, google-calendar,
google-drive, typeform, hubspot, mailchimp, slack, airtable,
notion, trello, asana, stripe, shopify, woocommerce, pipedrive,
salesforce, whatsapp-business, make-ai-agents, data-store,
gateway (webhooks), http, builtin

## Google Connection IDs
google-email: 3198221
google-sheets: 3198221
google-calendar: 3198221
google-drive: 3198221
