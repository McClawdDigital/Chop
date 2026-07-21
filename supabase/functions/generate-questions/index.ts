// Chop: Generate Questions Edge Function
// CONFIGURATION — edit these values to change model, prompt, or OpenRouter settings
const OPENROUTER_MODEL = 'z-ai/glm-4.7-flash';
const OPENROUTER_TEMPERATURE = 0.7;
const OPENROUTER_MAX_TOKENS = 2000;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_REFERER = 'https://chop-mvp.cloudflare-rake998.workers.dev';
const OPENROUTER_TITLE = 'Chop MVP';
// === END CONFIGURATION ===

const SYSTEM_PROMPT = `You are a knowledge-capture question designer. Your job is to decompose a seed topic into its concrete, named components and generate anchor-specific questions.

## AI-FIRST QUESTION DESIGN PRINCIPLES

### Decomposition Phase (internal, do not output)
Extract from the seed:
1. **NAMED ENTITIES** — Specific systems, tools, platforms, frameworks, products, datasets
2. **NAMED PEOPLE/ROLES** — Specific job titles, teams, or personas
3. **NAMED PROCESSES** — Specific workflows, pipelines, step sequences, approval gates
4. **SPECIFIC CONSTRAINTS** — Security boundaries, compliance requirements, SLAs, quotas
5. **SPECIFIC GAPS** — What is NOT in the seed, what a new person would be confused about

### Question Generation Rules
1. **Every question MUST reference at least 2 specific named things from the decomposition.**
2. **Pull from UNEXPECTED ANGLES** — Don't just ask the obvious questions.
3. **Be deeply specific** — Questions should sound like they were written by someone who already knows the domain.
4. **Cover 4-6 categories** from: scope, persona, process, people, gap, failure, source.
5. **Generate 10-12 questions total.**
6. **Output ONLY a valid JSON array.** No markdown fences, no commentary.`;

const USER_PROMPT_PREFIX = `## Decomposition\nExtract the named entities, tools, roles, processes, constraints, and gaps from this seed. List them explicitly.\n\n## Questions\nNow generate 10-12 deeply specific, anchor-heavy questions. Every question MUST name at least 2 specific things from the decomposition.\n\nOutput ONLY a valid JSON array. No markdown fences, no commentary, no explanation.\n\nEach question object MUST use these fields: "qid" (e.g. Q-1), "category" (one of: scope, persona, process, people, gap, failure, source), "text" (the question text).`;
// === END CONFIGURATION ===

interface Question { qid: string; category: string; text: string; }
const DEFAULT_QUESTIONS: Question[] = [
  {qid:'Q-SCOPE-01',category:'scope',text:'What specific systems, tools, or processes does this topic cover?'},
  {qid:'Q-SCOPE-02',category:'scope',text:'What is explicitly OUT of scope for this knowledge base?'},
  {qid:'Q-PERSONA-01',category:'persona',text:'Who needs this knowledge most? What do new people need to know?'},
  {qid:'Q-PROCESS-01',category:'process',text:'How does the core process work today? Walk through it step by step.'},
  {qid:'Q-PROCESS-02',category:'process',text:'What tools or permissions are needed to do this work?'},
  {qid:'Q-PEOPLE-01',category:'people',text:'Who are the key people involved? Who owns each part?'},
  {qid:'Q-GAP-01',category:'gap',text:'What is currently undocumented or poorly understood about this topic?'},
  {qid:'Q-FAILURE-01',category:'failure',text:'What are the most common mistakes or failure points?'},
  {qid:'Q-SOURCE-01',category:'source',text:'Where does the authoritative truth live? (docs, dashboards, people)'},
  {qid:'Q-PERSONA-02',category:'persona',text:'If someone new joined tomorrow, what would they be confused about?'},
];

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
function json(body: any, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } }); }

async function getOpenRouterKey(supabaseUrl: string, serviceKey: string): Promise<string | null> {
  const envKey = Deno.env.get('OPENROUTER_API_KEY');
  if (envKey) return envKey;
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/chop_config?key=eq.openrouter_api_key&select=value`,
      { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.[0]?.value || null;
  } catch { return null; }
}

async function generateQuestions(seed: string, apiKey: string): Promise<Question[]> {
  const userPrompt = `Seed topic: "${seed}"\n\n${USER_PROMPT_PREFIX}`;
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': OPENROUTER_REFERER, 'X-Title': OPENROUTER_TITLE },
      body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }], temperature: OPENROUTER_TEMPERATURE, max_tokens: OPENROUTER_MAX_TOKENS }),
    });
    if (!response.ok) { console.error(`OpenRouter ${response.status}`); return DEFAULT_QUESTIONS; }
    const data = await response.json();
    let content = data.choices?.[0]?.message?.content;
    if (!content) return DEFAULT_QUESTIONS;
    content = content.trim().replace(/^```(?:json)?\n?/,'').replace(/```$/,'').trim();
    const questions: Question[] = JSON.parse(content);
    if (!Array.isArray(questions) || questions.length < 5 || questions.length > 15) return DEFAULT_QUESTIONS;
    const validCat = ['scope','persona','process','people','gap','failure','source'];
    return questions.filter(q => q && (q.text||q.question||q.question_text||q.content||'')).map((q,i) => ({ qid: q.qid || `Q-${i+1}`, category: validCat.includes(q.category) ? q.category : 'gap', text: q.text || q.question || q.question_text || q.content }));
  } catch (e) { console.error(`OpenRouter exception: ${e.message}`); return DEFAULT_QUESTIONS; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await req.json();
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_KEY') || '';
    if (!supabaseUrl || !serviceKey) return json({ error: 'Server config error' }, 500);

    // CREATE MODE: create project + fire AI in background
    if (body.create) {
      const seed = (body.seed || '').trim();
      if (seed.length < 5) return json({ error: 'Seed too short' }, 400);
      const name = seed.substring(0, 40);
      const createResp = await fetch(`${supabaseUrl}/rest/v1/chop_projects`, {
        method: 'POST', headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ name, seed, questions: [], status: 'generating' }),
      });
      if (!createResp.ok) return json({ error: 'Failed to create project' }, 500);
      const p = (await createResp.json())?.[0];
      if (!p?.id) return json({ error: 'No project ID' }, 500);
      (async () => {
        try {
          const apiKey = await getOpenRouterKey(supabaseUrl, serviceKey);
          if (!apiKey) return;
          const questions = await generateQuestions(seed, apiKey);
          await fetch(`${supabaseUrl}/rest/v1/chop_projects?id=eq.${p.id}`, {
            method: 'PATCH', headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation,missing=default' },
            body: JSON.stringify({ questions, status: 'questions_generated', updated_at: new Date().toISOString() }),
          });
        } catch (e) { console.error(`BG gen failed ${p.id}: ${e.message}`); }
      })();
      return json({ success: true, id: p.id, status: 'generating' });
    }

    // LEGACY MODE: generate for existing project
    if (!body.project_id) return json({ error: 'Missing project_id' }, 400);
    const projectResp = await fetch(`${supabaseUrl}/rest/v1/chop_projects?id=eq.${body.project_id}&select=seed`,
      { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } });
    if (!projectResp.ok) return json({ error: 'Project not found' }, 404);
    const proj = (await projectResp.json())?.[0];
    if (!proj) return json({ error: 'Project not found' }, 404);
    const apiKey = await getOpenRouterKey(supabaseUrl, serviceKey);
    const questions = apiKey ? await generateQuestions(proj.seed, apiKey) : DEFAULT_QUESTIONS;
    await fetch(`${supabaseUrl}/rest/v1/chop_projects?id=eq.${body.project_id}`, {
      method: 'PATCH', headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation,missing=default' },
      body: JSON.stringify({ questions, status: 'questions_generated', updated_at: new Date().toISOString() }),
    });
    return json({ success: true, project_id: body.project_id, questions_count: questions.length });
  } catch (e) { return json({ error: e.message }, 500); }
});