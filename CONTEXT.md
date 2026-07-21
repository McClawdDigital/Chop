# Chop MVP — Context

**Deployed at:** https://chop-mvp.cloudflare-rake998.workers.dev
**GitHub:** https://github.com/McClawdDigital/Chop
**Supabase project:** `ofggjtkweqlkncgablbm` (Chop)

## Architecture

```
Browser → CF Worker (chop-mvp) → Supabase (REST API) 
                                    ↕
                              Edge Functions (AI)
                              - generate-questions
                              - synthesize-knowledge
```

- **CF Worker** (`src/worker.js`): Serves frontend HTML + auth + REST proxy. No AI code.
- **Supabase Edge Functions**: All AI work (no 30s Worker limit).
  - `generate-questions`: Seed → structured questionnaire (gpt-4o)
  - `synthesize-knowledge`: Expert answers → synthesized markdown + OKF bundle (gpt-4o)

## Flow

1. User signs up/logs in via Supabase Auth
2. Creates project with a "seed" topic → Worker creates project (status: `generating`) → fires EF `generate-questions` in background
3. Frontend polls until status = `questions_generated`
4. User adds experts → each gets a unique `/answer/:token` link
5. Experts answer questions → answers saved to `chop_answers`
6. User clicks "Synthesize Now" → Worker sets status=`synthesizing` → fires EF `synthesize-knowledge`
7. Frontend polls until status=`synthesized`, reads `synthesis_result` (JSONB with markdown + bundle)

## Supabase Tables

- `chop_projects` — id, user_id, name, seed, questions (JSONB), status, synthesis_result (JSONB), timestamps
- `chop_experts` — id, project_id, name, email, token, status, answered/total_questions
- `chop_answers` — id, project_id, expert_id, question_id, question_text, category, answer, skipped, answered_at
- `chop_config` — key/value store (openrouter_api_key)

## Worker Secrets

- `SUPABASE_URL` — https://ofggjtkweqlkncgablbm.supabase.co
- `SUPABASE_ANON_KEY` — [anon key redacted]
- `SUPABASE_SERVICE_KEY` — [service key redacted]
- `SITE_NAME` — Chop (env var in wrangler.toml)

## Deployment Preferences (McClawd Standard)

- **Cloudflare Workers** — hosting frontends and basic API interaction (auth, REST proxy). NOT for logic-heavy or AI tasks.
- **Supabase Edge Functions** — all logic-intensive work: AI calls, data processing, background jobs. No 30s Worker CPU limit.
- **Deploy to CF** — via Cloudflare Dashboard Git Integration (link repo → worker in the UI). **NOT** via GitHub Actions or API tokens in repo secrets. CF's own CI/CD is preferred.
- **Worker secrets** (API keys, DB URLs) set via `wrangler secret put` locally, not checked into the repo.