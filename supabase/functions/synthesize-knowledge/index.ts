// Chop: Synthesize Knowledge Edge Function
// Called asynchronously after experts have answered.
// Fetches all answers for a project, calls OpenRouter, saves result.
// Produces a proper OKF v0.2 bundle with:
//   index.md, log.md, okf.yaml, synthesis.md, concepts/*.md, raw/answers.md, raw/seed.md
// All files use OKF frontmatter, [[wikilinks]] cross-references, and preserve raw answers.
// Deno runtime — no 30s Worker CPU limit, no 20s timeout.

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_AI_MODEL = 'openai/gpt-4o';
const OKF_VERSION = '0.2';

const SYSTEM_PROMPT = `You are an expert knowledge synthesizer. Given raw expert interview answers about a topic, produce a coherent, structured knowledge document.
Identify consensus statements, flag divergences or disagreements, highlight uncertainty, and extract actionable takeaways.
Output valid markdown. Be thorough but concise.
CRITICAL: Do NOT simply repeat the raw answers. Synthesize them. Group related ideas, identify patterns, and flag contradictions.
Use headers, bullet points, and **bold** for emphasis. Do NOT wrap in code fences.`;

// ─── Types ───────────────────────────────────────────────────────────────────

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

interface Expert {
  id: string;
  name: string;
  email?: string;
  status: string;
  answered: number;
}

interface Answer {
  id: string;
  expert_id: string;
  question_id: string;
  question_text: string;
  category: string;
  answer: string | null;
  skipped: boolean;
}

interface Question {
  qid: string;
  category: string;
  text: string;
}

// Category display names
const CATEGORY_META: Record<string, { title: string; description: string; plural: string }> = {
  scope:   { title: 'Scope',     description: 'Boundaries, systems, tools, and coverage areas.',        plural: 'scope' },
  persona: { title: 'Persona',   description: 'Who needs this knowledge and what they need.',           plural: 'personas' },
  process: { title: 'Process',   description: 'Core workflow steps, tools, and permissions.',          plural: 'processes' },
  people:  { title: 'People',    description: 'Key people, roles, and ownership.',                      plural: 'people' },
  gap:     { title: 'Gap',       description: 'What is undocumented or poorly understood.',             plural: 'gaps' },
  failure: { title: 'Failure',   description: 'Common mistakes and failure points.',                    plural: 'failures' },
  source:  { title: 'Source',    description: 'Authoritative sources of truth.',                        plural: 'sources' },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escYaml(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function confidenceLevel(answers: { answered: number }[]): string {
  const withAnswers = answers.filter(a => a.answered > 0).length;
  if (withAnswers >= 3) return 'high';
  if (withAnswers >= 2) return 'medium';
  if (withAnswers > 0) return 'low';
  return 'none';
}

async function getOpenRouterKey(supabaseUrl: string, serviceKey: string): Promise<string | null> {
  // Try env first (set as Supabase Edge Function secret) — fastest path
  const envKey = Deno.env.get('OPENROUTER_API_KEY');
  if (envKey) return envKey;

  try {
    // Refresh schema cache first
    await fetch(`${supabaseUrl}/rest/v1/rpc/refresh_schema_cache`, {
      method: 'POST',
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/chop_config?key=eq.openrouter_api_key&select=value`,
      { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.[0]?.value || null;
  } catch { return null; }
}

// ─── AI Synthesis ────────────────────────────────────────────────────────────

interface GroupedAnswer {
  qid: string;
  q: string;
  category: string;
  answers: { name: string; a: string }[];
}

function groupAnswers(allAnswers: Answer[], experts: Expert[], questions: Question[]): {
  groups: GroupedAnswer[];
  byCategory: Record<string, GroupedAnswer[]>;
  qidToCategory: Map<string, string>;
  expertMap: Map<string, string>;
  respondents: Expert[];
} {
  const expertMap = new Map<string, string>();
  experts.forEach(e => expertMap.set(e.id, e.name));

  const qidToCategory = new Map<string, string>();
  questions.forEach(q => qidToCategory.set(q.qid, q.category));

  const byQid = new Map<string, GroupedAnswer>();
  for (const a of allAnswers) {
    if (!a.answer || a.skipped) continue;
    const name = expertMap.get(a.expert_id) || 'Unknown';
    let g = byQid.get(a.question_id);
    if (!g) {
      g = { qid: a.question_id, q: a.question_text, category: qidToCategory.get(a.question_id) || 'uncategorized', answers: [] };
      byQid.set(a.question_id, g);
    }
    g.answers.push({ name, a: a.answer });
  }

  const groups = Array.from(byQid.values());

  const byCategory: Record<string, GroupedAnswer[]> = {};
  for (const g of groups) {
    const cat = g.category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(g);
  }

  const respondents = experts.filter(e => e.answered > 0);

  return { groups, byCategory, qidToCategory, expertMap, respondents };
}

function buildAnswerBlocks(groups: GroupedAnswer[]): string {
  let blocks = '';
  for (const g of groups) {
    blocks += `## Question: ${g.q}\n`;
    blocks += `QID: ${g.qid} | Category: ${g.category}\n`;
    for (const a of g.answers) {
      blocks += `- **${a.name}**: ${a.a}\n`;
    }
    blocks += '\n';
  }
  return blocks;
}

async function callAI(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  model: string = DEFAULT_AI_MODEL,
): Promise<string | null> {
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
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`OpenRouter returned ${response.status}: ${text}`);
      return null;
    }

    const data: OpenRouterResponse = await response.json();
    let content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    content = content.trim();
    // Strip code fences if present
    if (content.startsWith('```markdown')) content = content.slice(12);
    else if (content.startsWith('```json')) content = content.slice(7);
    else if (content.startsWith('```yaml')) content = content.slice(7);
    else if (content.startsWith('```')) content = content.slice(3);
    if (content.endsWith('```')) content = content.slice(0, -3);
    return content.trim();
  } catch (e: any) {
    console.error(`OpenRouter exception: ${e.message}`);
    return null;
  }
}

// ─── Synthesis Markdown Generation ──────────────────────────────────────────

async function synthesizeMarkdown(
  projectName: string,
  seed: string,
  groups: GroupedAnswer[],
  byCategory: Record<string, GroupedAnswer[]>,
  respondents: Expert[],
  apiKey: string,
): Promise<string> {
  const answerBlocks = buildAnswerBlocks(groups);

  const userPrompt = `Synthesize the following expert answers into a structured knowledge document.

Project: ${projectName}
Seed topic: ${seed}

## Expert Answers

${answerBlocks}

Produce a markdown document with the following sections:
1. **Executive Summary** — 2-3 paragraph synthesis of the key takeaways from all answers. What would someone need to know after reading this?
2. **Key Insights by Category** — For each category that has answers, provide: (a) consensus statements (what experts agreed on), (b) divergence notes (where they disagreed or offered different perspectives), and (c) uncertainty flags (areas lacking data). Group related answers, don't just list them.
3. **Actionable Takeaways** — Concrete next steps, decisions, or actions implied by the knowledge. Who should do what?
4. **Gaps & Recommended Follow-ups** — What is missing or needs further investigation, and who might know the answers.

Format: clean markdown with headers. Be analytical — don't just summarize, actually synthesize. Flag specific expert names when they hold unique knowledge. Do NOT wrap the entire output in a code fence.`;

  const content = await callAI(SYSTEM_PROMPT, userPrompt, apiKey);
  if (content) return content;
  return buildFallbackMarkdown(projectName, seed, respondents, groups, byCategory);
}

function buildFallbackMarkdown(
  projectName: string,
  seed: string,
  respondents: Expert[],
  groups: GroupedAnswer[],
  byCategory: Record<string, GroupedAnswer[]>,
): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  let md = `# ${projectName} - Context Summary\n\n`;
  md += '> **Note:** AI synthesis was unavailable. This is a structured fallback document.\n\n';
  md += '## Metadata\n';
  md += `- **Seed:** ${seed}\n`;
  md += `- **Respondents:** ${respondents.map(e => e.name).join(', ')}\n`;
  md += `- **Questions Answered:** ${groups.reduce((s, g) => s + g.answers.length, 0)}\n`;
  md += `- **Generated:** ${dateStr}\n\n`;
  md += '## Answers by Category\n\n';

  const catKeys = Object.keys(CATEGORY_META);
  for (const cat of catKeys) {
    const catAnswers = byCategory[cat];
    const meta = CATEGORY_META[cat];
    if (!catAnswers || catAnswers.length === 0) continue;
    md += `### ${meta.title}\n\n`;
    md += `*Confidence: ${confidenceLevel(respondents)}*\n\n`;
    for (const q of catAnswers) {
      md += `**${q.q}** (QID: ${q.qid})\n\n`;
      for (const a of q.answers) {
        md += `- **${a.name}:** ${a.a}\n`;
      }
      md += '\n';
    }
  }
  md += '---\n';
  md += '*Fallback document — no AI synthesis was performed.*\n';
  return md;
}

// ─── OKF Bundle Builder ──────────────────────────────────────────────────────

function buildOkfBundle(
  projectName: string,
  seed: string,
  experts: Expert[],
  questions: Question[],
  allAnswers: Answer[],
  groups: GroupedAnswer[],
  byCategory: Record<string, GroupedAnswer[]>,
  respondents: Expert[],
  markdown: string,
): Record<string, string> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString();

  const catKeys = Object.keys(CATEGORY_META);
  const answeredCategories = catKeys.filter(cat => byCategory[cat]?.length > 0);
  const bundle: Record<string, string> = {};

  // Helper to build wikilinks for a category
  function conceptLinks(excludeCategory: string): string[] {
    const links: string[] = [];
    for (const cat of answeredCategories) {
      if (cat === excludeCategory) continue;
      const meta = CATEGORY_META[cat];
      links.push(`[[concepts/${cat}.md|${meta.title}]]`);
    }
    return links;
  }

  // ── 1. okf.yaml ──────────────────────────────────────────────────────────
  bundle['okf.yaml'] = [
    '---',
    'okf_version: "' + OKF_VERSION + '"',
    'type: KnowledgeBundle',
    'title: "' + escYaml(projectName) + '"',
    'description: "Chop-captured knowledge about: ' + escYaml(seed) + '"',
    'tags: [chop, knowledge-capture, bundle]',
    'timestamp: ' + timestamp,
    'source: "' + escYaml(seed) + '"',
    'manifest:',
    '  files:',
    '    - index.md',
    '    - log.md',
    '    - okf.yaml',
    '    - synthesis.md',
    answeredCategories.map(cat => '    - concepts/' + cat + '.md').join('\n'),
    '    - raw/answers.md',
    '    - raw/seed.md',
    '---',
    '',
  ].join('\n');

  // ── 2. index.md ──────────────────────────────────────────────────────────
  {
    let body = '---\n';
    body += 'type: KnowledgeBundle\n';
    body += 'title: "' + escYaml(projectName) + '"\n';
    body += 'description: "Chop-captured knowledge generated from expert interviews about: ' + escYaml(seed) + '"\n';
    body += 'tags: [chop, knowledge-capture, bundle]\n';
    body += 'timestamp: ' + timestamp + '\n';
    body += 'okf_version: "' + OKF_VERSION + '"\n';
    body += 'source: "' + escYaml(seed) + '"\n';
    body += '---\n\n';
    body += '# ' + projectName + '\n\n';
    body += 'Captured on ' + dateStr + ' via **Chop** — an interview-loop knowledge capture tool.\n\n';
    body += 'See the [[synthesis.md|AI Synthesis]] for an executive summary of findings.\n\n';
    body += '## Metadata\n\n';
    body += '- **Seed:** ' + seed + '\n';
    body += '- **OKF Version:** ' + OKF_VERSION + '\n';
    body += '- **Respondents:** ' + respondents.map(e => e.name).join(', ') + '\n';
    body += '- **Questions Answered:** ' + allAnswers.filter(a => !a.skipped && a.answer).length + '\n';
    body += '- **Categories:** ' + answeredCategories.length + '\n';
    body += '- **Generated:** ' + timestamp + '\n\n';
    body += '## Concepts\n\n';
    body += '| Category | Description | Questions |\n';
    body += '|----------|-------------|-----------|\n';
    for (const cat of answeredCategories) {
      const meta = CATEGORY_META[cat];
      const count = byCategory[cat].length;
      body += '| [[' + meta.title + '|concepts/' + cat + '.md]] | ' + meta.description + ' | ' + count + ' |\n';
    }
    body += '\n## Bundle Contents\n\n';
    body += '- [[synthesis.md|AI Synthesis]] — Executive summary and cross-category insights\n';
    for (const cat of answeredCategories) {
      const meta = CATEGORY_META[cat];
      body += '  - [[concepts/' + cat + '.md|' + meta.title + ']] — ' + meta.description + '\n';
    }
    body += '- [[raw/answers.md|Raw Answers]] — All expert question/answer pairs verbatim\n';
    body += '- [[raw/seed.md|Original Seed]] — The seed topic used to generate questions\n';
    body += '- [[log.md|Capture Log]] — Session metadata and contributor records\n';
    body += '- [[okf.yaml|OKF Manifest]] — Bundle manifest\n\n';
    body += '## Contributors\n\n';
    for (const r of respondents) body += '- ' + r.name + '\n';
    bundle['index.md'] = body;
  }

  // ── 3. log.md ────────────────────────────────────────────────────────────
  {
    let body = '---\n';
    body += 'type: Log\n';
    body += 'title: "Capture Log — ' + escYaml(projectName) + '"\n';
    body += 'tags: [chop, log]\n';
    body += 'timestamp: ' + timestamp + '\n';
    body += 'okf_version: "' + OKF_VERSION + '"\n';
    body += '---\n\n';
    body += '# Capture Log\n\n';
    body += 'Part of the [[index.md|Knowledge Bundle]] for **' + projectName + '**.\n\n';
    body += '## Session Summary\n\n';
    body += '- **Date:** ' + dateStr + '\n';
    body += '- **Creation:** Bundle created from Chop interview-loop capture session.\n';
    body += '- **Seed:** "' + seed + '"\n';
    body += '- **Respondents:** ' + respondents.length + ' expert' + (respondents.length !== 1 ? 's' : '') + ' contributed.\n';
    body += '- **Total answers:** ' + allAnswers.filter(a => !a.skipped && a.answer).length + '\n';
    body += '- **Categories captured:** ' + answeredCategories.map(c => CATEGORY_META[c].title).join(', ') + '\n\n';
    body += '## Respondent Details\n\n';
    body += '| Name | Questions Answered |\n';
    body += '|------|-------------------|\n';
    for (const r of respondents) {
      body += '| ' + r.name + ' | ' + r.answered + ' |\n';
    }
    bundle['log.md'] = body;
  }

  // ── 4. synthesis.md ──────────────────────────────────────────────────────
  {
    let body = '---\n';
    body += 'type: Synthesis\n';
    body += 'title: "AI Synthesis — ' + escYaml(projectName) + '"\n';
    body += 'description: "AI-generated synthesis of expert interview answers for: ' + escYaml(seed) + '"\n';
    body += 'tags: [chop, synthesis, ai-generated]\n';
    body += 'timestamp: ' + timestamp + '\n';
    body += 'okf_version: "' + OKF_VERSION + '"\n';
    body += 'source: "' + escYaml(seed) + '"\n';
    body += '---\n\n';
    body += '# AI Synthesis\n\n';
    body += '> **Bundle:** [[index.md|' + projectName + ']] | **Raw Data:** [[raw/answers.md|Raw Answers]] | **Log:** [[log.md|Capture Log]]\n\n';
    // Strip the outer heading if markdown starts with one
    let synthBody = markdown;
    // Link concept files within the synthesis text
    for (const cat of answeredCategories) {
      const meta = CATEGORY_META[cat];
      // Add wikilinks after first mention of each category title
      const regex = new RegExp('\\b' + meta.title + '\\b', 'g');
      synthBody = synthBody.replace(regex, '[[' + meta.title + '|concepts/' + cat + '.md]]');
    }
    body += synthBody + '\n\n';
    body += '---\n';
    body += '*Synthesis generated via OpenRouter (' + DEFAULT_AI_MODEL + ') at ' + timestamp + '.*\n';
    bundle['synthesis.md'] = body;
  }

  // ── 5. concepts/*.md ─────────────────────────────────────────────────────
  for (const cat of answeredCategories) {
    const meta = CATEGORY_META[cat];
    const catAnswers = byCategory[cat];
    const otherLinks = conceptLinks(cat);

    let body = '---\n';
    body += 'type: Concept\n';
    body += 'title: "' + meta.title + ' — ' + escYaml(projectName) + '"\n';
    body += 'description: "' + escYaml(meta.description) + '"\n';
    body += 'tags: [chop, knowledge-capture, ' + cat + ']\n';
    body += 'timestamp: ' + timestamp + '\n';
    body += 'okf_version: "' + OKF_VERSION + '"\n';
    body += 'source: "' + escYaml(seed) + '"\n';
    body += 'bundle: "[[index.md|' + escYaml(projectName) + ']]"\n';
    body += '---\n\n';
    body += '# ' + meta.title + '\n\n';
    body += meta.description + '\n\n';
    body += 'Part of the [[index.md|Knowledge Bundle]] for **' + projectName + '**.\n\n';
    body += '**Confidence:** ' + confidenceLevel(respondents) + '\n\n';

    // Write each question and its answers
    body += '## Answers\n\n';
    for (const q of catAnswers) {
      body += '### ' + q.q + '\n\n';
      body += '> **Question ID:** ' + q.qid + '\n\n';
      for (const a of q.answers) {
        body += '<details>\n';
        body += '<summary><strong>' + escHtml(a.name) + '</strong> answered:</summary>\n\n';
        body += a.a + '\n\n';
        body += '</details>\n\n';
      }
      body += '---\n\n';
    }

    // Cross-references
    body += '## Related Concepts\n\n';
    body += '- [[index.md|Back to Bundle Index]]\n';
    for (const link of otherLinks) {
      body += '- ' + link + '\n';
    }
    body += '- [[raw/answers.md|Raw Answers]]\n';
    body += '- [[synthesis.md|AI Synthesis]]\n\n';

    body += '## Contributors\n\n';
    for (const r of respondents) body += '- ' + r.name + '\n';

    bundle['concepts/' + cat + '.md'] = body;
  }

  // ── 6. raw/answers.md ────────────────────────────────────────────────────
  {
    let body = '---\n';
    body += 'type: RawData\n';
    body += 'title: "Raw Expert Answers — ' + escYaml(projectName) + '"\n';
    body += 'description: "Verbatim expert question/answer pairs for: ' + escYaml(seed) + '"\n';
    body += 'tags: [chop, raw-data, answers]\n';
    body += 'timestamp: ' + timestamp + '\n';
    body += 'okf_version: "' + OKF_VERSION + '"\n';
    body += 'source: "' + escYaml(seed) + '"\n';
    body += '---\n\n';
    body += '# Raw Expert Answers\n\n';
    body += '> This file contains the original, unmodified question/answer pairs collected during the Chop interview loop.\n';
    body += '> See [[synthesis.md|AI Synthesis]] for the synthesized analysis, or [[index.md|Bundle Index]] for the full table of contents.\n\n';

    // Group by category for readability
    for (const cat of answeredCategories) {
      const meta = CATEGORY_META[cat];
      const catAnswers = byCategory[cat];
      body += '## ' + meta.title + '\n\n';
      body += 'See also: [[concepts/' + cat + '.md|' + meta.title + ' Concept]]\n\n';
      for (const q of catAnswers) {
        body += '### Question: ' + q.q + '\n';
        body += '- **QID:** ' + q.qid + '\n';
        body += '- **Category:** ' + meta.title + '\n\n';
        for (const a of q.answers) {
          body += '**' + a.name + ':**\n\n';
          body += '> ' + a.a.replace(/\n/g, '\n> ') + '\n\n';
        }
        body += '---\n\n';
      }
    }

    bundle['raw/answers.md'] = body;
  }

  // ── 7. raw/seed.md ───────────────────────────────────────────────────────
  {
    let body = '---\n';
    body += 'type: RawData\n';
    body += 'title: "Original Seed — ' + escYaml(projectName) + '"\n';
    body += 'description: "The seed topic used to generate questions for: ' + escYaml(seed) + '"\n';
    body += 'tags: [chop, raw-data, seed]\n';
    body += 'timestamp: ' + timestamp + '\n';
    body += 'okf_version: "' + OKF_VERSION + '"\n';
    body += 'source: "' + escYaml(seed) + '"\n';
    body += '---\n\n';
    body += '# Original Seed\n\n';
    body += 'This bundle was generated from the following seed topic:\n\n';
    body += '> ' + seed + '\n\n';
    body += 'The seed was used by Chop\'s question generator to create targeted interview questions across ' + answeredCategories.length + ' categories.\n\n';
    body += '## Generated Questions\n\n';
    for (const cat of answeredCategories) {
      const meta = CATEGORY_META[cat];
      const catQs = questions.filter(q => q.category === cat);
      if (catQs.length === 0) continue;
      body += '### ' + meta.title + '\n\n';
      for (const q of catQs) {
        body += '- `' + q.qid + '` ' + q.text + '\n';
      }
      body += '\n';
    }
    body += '---\n';
    body += 'See [[index.md|Bundle Index]] for the full table of contents.\n';

    bundle['raw/seed.md'] = body;
  }

  return bundle;
}

// ─── Main Handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const projectId: string = body.project_id;

    if (!projectId) {
      return new Response(JSON.stringify({ error: 'Missing project_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = req.headers.get('X-SUPABASE-URL') || Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = req.headers.get('X-SUPABASE-SERVICE-KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_KEY') || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fetch project
    const projectResp = await fetch(
      `${supabaseUrl}/rest/v1/chop_projects?id=eq.${projectId}&select=*`,
      { headers: { 'apikey': supabaseServiceKey, 'Authorization': `Bearer ${supabaseServiceKey}` } }
    );
    if (!projectResp.ok) {
      return new Response(JSON.stringify({ error: 'Project not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      });
    }
    const projects = await projectResp.json();
    const project = projects?.[0];
    if (!project) {
      return new Response(JSON.stringify({ error: 'Project not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      });
    }

    const questions: Question[] = project.questions || [];
    if (questions.length === 0) {
      return new Response(JSON.stringify({ error: 'No questions for this project' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fetch experts and answers
    const expertsResp = await fetch(
      `${supabaseUrl}/rest/v1/chop_experts?project_id=eq.${projectId}&select=*`,
      { headers: { 'apikey': supabaseServiceKey, 'Authorization': `Bearer ${supabaseServiceKey}` } }
    );
    const experts: Expert[] = expertsResp.ok ? await expertsResp.json() : [];

    const answersResp = await fetch(
      `${supabaseUrl}/rest/v1/chop_answers?project_id=eq.${projectId}&select=*`,
      { headers: { 'apikey': supabaseServiceKey, 'Authorization': `Bearer ${supabaseServiceKey}` } }
    );
    const allAnswers: Answer[] = answersResp.ok ? await answersResp.json() : [];

    const answeredAnswers = allAnswers.filter(a => !a.skipped && a.answer);
    if (answeredAnswers.length === 0) {
      return new Response(JSON.stringify({ error: 'No answered questions yet' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get API key
    const apiKey = await getOpenRouterKey(supabaseUrl, supabaseServiceKey);
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'No OpenRouter API key configured' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Set status to synthesizing
    await fetch(
      `${supabaseUrl}/rest/v1/chop_projects?id=eq.${projectId}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'synthesizing', updated_at: new Date().toISOString() }),
      }
    );

    // Group all answers once, reused everywhere
    const grouped = groupAnswers(allAnswers, experts, questions);

    // Generate the AI synthesis markdown
    const markdown = await synthesizeMarkdown(
      project.name, project.seed,
      grouped.groups, grouped.byCategory, grouped.respondents, apiKey,
    );

    // Build the OKF v0.2 bundle
    const bundle = buildOkfBundle(
      project.name, project.seed,
      experts, questions, allAnswers,
      grouped.groups, grouped.byCategory, grouped.respondents,
      markdown,
    );

    // Save the result (same shape as before so frontend compatibility is preserved)
    const synthesisResult = { markdown, bundle };

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
          synthesis_result: synthesisResult,
          status: 'synthesized',
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!updateResp.ok) {
      const errText = await updateResp.text();
      console.error(`Failed to save synthesis: ${updateResp.status} ${errText}`);
      return new Response(JSON.stringify({ error: 'Failed to save synthesis' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log(`Synthesis complete for project ${projectId}`);
    return new Response(JSON.stringify({
      success: true,
      project_id: projectId,
      markdown: markdown,
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error(`Unhandled error: ${e.message}`);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
