// Chop: Generate Questions Edge Function
// Called asynchronously after a project is created.
// Fetches the seed, calls OpenRouter, saves questions back.
// Deno runtime — no 30s Worker CPU limit.

interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_KEY: string;
}

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

interface Question {
  qid: string;
  category: string;
  text: string;
}

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

async function getOpenRouterKey(supabaseUrl: string, serviceKey: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/chop_config?key=eq.openrouter_api_key&select=value`,
      {
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
        },
      }
    );
    if (!resp.ok) {
      console.error(`getOpenRouterKey: HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    if (data && data.length > 0 && data[0].value) {
      return data[0].value;
    }
    console.error('getOpenRouterKey: No config row found');
    return null;
  } catch (e) {
    console.error('getOpenRouterKey: Error', e);
    return null;
  }
}

async function generateQuestions(seed: string, apiKey: string): Promise<Question[]> {
  const systemPrompt = `You are a knowledge-capture question designer. Your job is to decompose a seed topic into its concrete, named components and generate anchor-specific questions.

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

  const userPrompt = `Seed topic: "${seed}"

## Decomposition
Extract the named entities, tools, roles, processes, constraints, and gaps from this seed. List them explicitly.

## Questions
Now generate 10-12 deeply specific, anchor-heavy questions. Every question MUST name at least 2 specific things from the decomposition.

Output ONLY a valid JSON array. No markdown fences, no commentary, no explanation.`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://chop-mvp.cloudflare-rake998.workers.dev',
        'X-Title': 'Chop MVP',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`OpenRouter returned ${response.status}: ${text}`);
      return DEFAULT_QUESTIONS;
    }

    const data: OpenRouterResponse = await response.json();
    let content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.error('No content in OpenRouter response');
      return DEFAULT_QUESTIONS;
    }

    // Strip markdown fences
    content = content.trim();
    if (content.startsWith('```json')) content = content.slice(7);
    else if (content.startsWith('```')) content = content.slice(3);
    if (content.endsWith('```')) content = content.slice(0, -3);
    content = content.trim();

    const questions: Question[] = JSON.parse(content);

    // Validate
    if (!Array.isArray(questions) || questions.length < 8 || questions.length > 12) {
      console.error(`Invalid question count: ${questions.length}`);
      return DEFAULT_QUESTIONS;
    }

    const validCategories = ['scope', 'persona', 'process', 'people', 'gap', 'failure', 'source'];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.qid || !q.category || !q.text || !validCategories.includes(q.category)) {
        console.error(`Invalid question at index ${i}: ${JSON.stringify(q)}`);
        return DEFAULT_QUESTIONS;
      }
    }

    return questions;
  } catch (e: any) {
    console.error(`OpenRouter exception: ${e.message}`);
    return DEFAULT_QUESTIONS;
  }
}

Deno.serve(async (req: Request) => {
  // Only accept POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const projectId: string = body.project_id;
    const apiKeyOverride: string | undefined = body.api_key;

    if (!projectId) {
      return new Response(JSON.stringify({ error: 'Missing project_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get env variables from request headers or deno env
    const supabaseUrl = req.headers.get('X-SUPABASE-URL') || Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = req.headers.get('X-SUPABASE-SERVICE-KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_KEY') || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase credentials');
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fetch the project
    const projectResp = await fetch(
      `${supabaseUrl}/rest/v1/chop_projects?id=eq.${projectId}&select=*`,
      {
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
        },
      }
    );

    if (!projectResp.ok) {
      console.error(`Failed to fetch project: ${projectResp.status}`);
      return new Response(JSON.stringify({ error: 'Project not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const projects = await projectResp.json();
    const project = projects?.[0];
    if (!project) {
      return new Response(JSON.stringify({ error: 'Project not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get OpenRouter API key
    const apiKey = apiKeyOverride || await getOpenRouterKey(supabaseUrl, supabaseServiceKey);
    if (!apiKey) {
      console.error('Could not get OpenRouter API key — using defaults');
    }

    // Generate questions
    const questions = apiKey
      ? await generateQuestions(project.seed, apiKey)
      : DEFAULT_QUESTIONS;

    // Save questions to the project
    const updateResp = await fetch(
      `${supabaseUrl}/rest/v1/chop_projects?id=eq.${projectId}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify({
          questions: questions,
          status: 'questions_generated',
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!updateResp.ok) {
      const errText = await updateResp.text();
      console.error(`Failed to update project: ${updateResp.status} ${errText}`);
      return new Response(JSON.stringify({
        error: 'Failed to save questions',
        questions_generated: questions.length,
        using_defaults: questions === DEFAULT_QUESTIONS,
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log(`Generated ${questions.length} questions for project ${projectId}`);
    return new Response(JSON.stringify({
      success: true,
      project_id: projectId,
      questions_count: questions.length,
      using_defaults: questions === DEFAULT_QUESTIONS,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error(`Unhandled error: ${e.message}`);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});