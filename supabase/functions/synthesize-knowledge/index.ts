// Chop: Synthesize Knowledge Edge Function
// Called asynchronously after experts have answered.
// Fetches all answers for a project, calls OpenRouter, saves result.
// Deno runtime — no 30s Worker CPU limit, no 20s timeout.

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
const CATEGORY_META: Record<string, { title: string; description: string }> = {
  scope:     { title: 'Scope',     description: 'Boundaries, systems, tools, and coverage areas.' },
  persona:   { title: 'Persona',   description: 'Who needs this knowledge and what they need.' },
  process:   { title: 'Process',   description: 'Core workflow steps, tools, and permissions.' },
  people:    { title: 'People',    description: 'Key people, roles, and ownership.' },
  gap:       { title: 'Gap',       description: 'What is undocumented or poorly understood.' },
  failure:   { title: 'Failure',   description: 'Common mistakes and failure points.' },
  source:    { title: 'Source',    description: 'Authoritative sources of truth.' },
};

function escYaml(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function getOpenRouterKey(supabaseUrl: string, serviceKey: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/chop_config?key=eq.openrouter_api_key&select=value`,
      { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.[0]?.value || null;
  } catch { return null; }
}

function confidenceLevel(answers: { answered: number }[]): string {
  const withAnswers = answers.filter(a => a.answered > 0).length;
  if (withAnswers >= 3) return 'high';
  if (withAnswers >= 2) return 'medium';
  if (withAnswers > 0) return 'low';
  return 'none';
}

// Build the main synthesis markdown document
async function synthesizeMarkdown(
  projectName: string,
  seed: string,
  experts: Expert[],
  questions: Question[],
  allAnswers: Answer[],
  apiKey: string
): Promise<string> {
  const respondents = experts.filter(e => e.answered > 0);
  const expertMap = new Map<string, string>();
  experts.forEach(e => expertMap.set(e.id, e.name));

  // Group answers by question
  const byQid = new Map<string, { qid: string; q: string; answers: { name: string; a: string }[] }>();
  for (const a of allAnswers) {
    if (!a.answer || a.skipped) continue;
    const name = expertMap.get(a.expert_id) || 'Unknown';
    let g = byQid.get(a.question_id);
    if (!g) {
      g = { qid: a.question_id, q: a.question_text, answers: [] };
      byQid.set(a.question_id, g);
    }
    g.answers.push({ name, a: a.answer });
  }

  const groups = Array.from(byQid.values());
  const qidToCategory = new Map<string, string>();
  questions.forEach(q => qidToCategory.set(q.qid, q.category));

  const byCategory: Record<string, typeof groups> = {};
  for (const g of groups) {
    const cat = qidToCategory.get(g.qid) || 'uncategorized';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(g);
  }

  // Build answer blocks for the prompt
  let answerBlocks = '';
  for (const g of groups) {
    const cat = qidToCategory.get(g.qid) || 'uncategorized';
    answerBlocks += `## Question: ${g.q}\n`;
    answerBlocks += `QID: ${g.qid} | Category: ${cat}\n`;
    for (const a of g.answers) {
      answerBlocks += `- **${a.name}**: ${a.a}\n`;
    }
    answerBlocks += '\n';
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  const systemPrompt = `You are an expert knowledge synthesizer. Given raw expert interview answers about a topic, produce a coherent, structured knowledge document.
Identify consensus statements, flag divergences or disagreements, highlight uncertainty, and extract actionable takeaways.
Output valid markdown. Be thorough but concise.
CRITICAL: Do NOT simply repeat the raw answers. Synthesize them. Group related ideas, identify patterns, and flag contradictions.
Use headers, bullet points, and **bold** for emphasis. Do NOT wrap in code fences.`;

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
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Synthesis OpenRouter returned ${response.status}: ${text}`);
      return buildFallbackMarkdown(projectName, seed, respondents, groups, byCategory, qidToCategory, dateStr);
    }

    const data: OpenRouterResponse = await response.json();
    let content = data.choices?.[0]?.message?.content;
    if (!content) return buildFallbackMarkdown(projectName, seed, respondents, groups, byCategory, qidToCategory, dateStr);

    content = content.trim();
    if (content.startsWith('```markdown')) content = content.slice(12);
    else if (content.startsWith('```')) content = content.slice(3);
    if (content.endsWith('```')) content = content.slice(0, -3);
    return content.trim();
  } catch (e: any) {
    console.error(`Synthesis OpenRouter exception: ${e.message}`);
    return buildFallbackMarkdown(projectName, seed, respondents, groups, byCategory, qidToCategory, dateStr);
  }
}

function buildFallbackMarkdown(
  projectName: string,
  seed: string,
  respondents: Expert[],
  groups: { qid: string; q: string; answers: { name: string; a: string }[] }[],
  byCategory: Record<string, typeof groups>,
  qidToCategory: Map<string, string>,
  dateStr: string
): string {
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
    const conf = catAnswers.filter(() => true);
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

// Build the OKF bundle JSON (per-category summaries)
async function buildBundleJson(
  seed: string,
  questions: Question[],
  allAnswers: Answer[],
  experts: Expert[],
  apiKey: string
): Promise<Record<string, any> | null> {
  const expertMap = new Map<string, string>();
  experts.forEach(e => expertMap.set(e.id, e.name));

  const byQid = new Map<string, { qid: string; q: string; answers: { name: string; a: string }[] }>();
  for (const a of allAnswers) {
    if (!a.answer || a.skipped) continue;
    const name = expertMap.get(a.expert_id) || 'Unknown';
    let g = byQid.get(a.question_id);
    if (!g) {
      g = { qid: a.question_id, q: a.question_text, answers: [] };
      byQid.set(a.question_id, g);
    }
    g.answers.push({ name, a: a.answer });
  }

  let answerBlocks = '';
  for (const [_, g] of byQid) {
    answerBlocks += `## Question: ${g.q}\n`;
    answerBlocks += `QID: ${g.qid}\n`;
    for (const a of g.answers) {
      answerBlocks += `- **${a.name}**: ${a.a}\n`;
    }
    answerBlocks += '\n';
  }

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
          { role: 'system', content: 'You produce structured JSON summaries from expert answers. Output ONLY valid JSON.' },
          { role: 'user', content: `Based on the expert answers below, produce a structured JSON output with per-category summaries.
The JSON must have this exact structure:
{
  "category_summaries": {
    "scope": {"summary": "...", "consensus": ["..."], "divergence": ["..."], "takeaways": ["..."]},
    "persona": {...},
    ... only categories that have answers ...
  },
  "index_summary": "2-3 sentence bundle overview",
  "log_notes": "1-2 sentences on what was captured"
}

Expert answers:
${answerBlocks}

Output ONLY the JSON object. No markdown fences, no commentary.` },
        ],
        temperature: 0.5,
        max_tokens: 3000,
      }),
    });

    if (!response.ok) return null;
    const data: OpenRouterResponse = await response.json();
    let content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    content = content.trim();
    if (content.startsWith('```json')) content = content.slice(7);
    else if (content.startsWith('```')) content = content.slice(3);
    if (content.endsWith('```')) content = content.slice(0, -3);
    return JSON.parse(content.trim());
  } catch {
    return null;
  }
}

function buildBundle(
  projectName: string,
  seed: string,
  experts: Expert[],
  questions: Question[],
  allAnswers: Answer[],
  markdown: string,
  bundleJson: Record<string, any> | null
): Record<string, string> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString();

  const qidToCategory = new Map<string, string>();
  questions.forEach(q => qidToCategory.set(q.qid, q.category));

  const byCategory: Record<string, { qid: string; q: string; answers: { name: string; a: string }[] }[]> = {};
  for (const a of allAnswers) {
    if (!a.answer || a.skipped) continue;
    const cat = qidToCategory.get(a.question_id) || 'uncategorized';
    if (!byCategory[cat]) byCategory[cat] = [];
    // Group by question within category
  }

  // Re-group properly
  const byQid = new Map<string, { qid: string; q: string; answers: { name: string; a: string }[] }>();
  const expertMap = new Map<string, string>();
  experts.forEach(e => expertMap.set(e.id, e.name));
  for (const a of allAnswers) {
    if (!a.answer || a.skipped) continue;
    const name = expertMap.get(a.expert_id) || 'Unknown';
    let g = byQid.get(a.question_id);
    if (!g) {
      g = { qid: a.question_id, q: a.question_text, answers: [] };
      byQid.set(a.question_id, g);
    }
    g.answers.push({ name, a: a.answer });
  }

  const catQids: Record<string, { qid: string; q: string; answers: { name: string; a: string }[] }[]> = {};
  for (const [qid, g] of byQid) {
    const cat = qidToCategory.get(qid) || 'uncategorized';
    if (!catQids[cat]) catQids[cat] = [];
    catQids[cat].push(g);
  }

  const respondents = experts.filter(e => e.answered > 0);
  const bundle: Record<string, string> = {};
  const catKeys = Object.keys(CATEGORY_META);

  // Build concept files
  for (const cat of catKeys) {
    const meta = CATEGORY_META[cat];
    const catAnswers = catQids[cat];
    if (!catAnswers) continue;
    const fileName = `${cat}.md`;

    let body = '---\n';
    body += `type: Concept\n`;
    body += `title: ${meta.title} — ${projectName}\n`;
    body += `description: ${escYaml(meta.description)}\n`;
    body += `tags: [chop, knowledge-capture, ${cat}]\n`;
    body += `timestamp: ${timestamp}\n`;
    body += `source: "${escYaml(seed)}"\n`;
    body += `---\n\n`;
    body += `# ${meta.title}\n\n`;
    body += `${meta.description}\n\n`;
    body += `Part of the **[Knowledge Bundle](./index.md)** for *${projectName}*.\n\n`;
    body += `**Confidence:** ${confidenceLevel(respondents)}\n\n`;

    if (bundleJson?.category_summaries?.[cat]) {
      const cs = bundleJson.category_summaries[cat];
      if (cs.summary) body += `## Summary\n\n${cs.summary}\n\n`;
      if (cs.consensus?.length) body += `## Consensus\n\n${cs.consensus.map((c: string) => `- ${c}`).join('\n')}\n\n`;
      if (cs.divergence?.length) body += `## Divergence\n\n${cs.divergence.map((d: string) => `- ${d}`).join('\n')}\n\n`;
      if (cs.takeaways?.length) body += `## Takeaways\n\n${cs.takeaways.map((t: string) => `- ${t}`).join('\n')}\n\n`;
    } else {
      body += '## Answers\n\n';
      for (const q of catAnswers) {
        body += `### ${q.q}\n\n`;
        body += `> **Question ID:** ${q.qid}\n\n`;
        for (const a of q.answers) {
          body += `<details>\n<summary><strong>${escHtml(a.name)}</strong> answered:</summary>\n\n${a.a}\n\n</details>\n\n`;
        }
        body += '---\n\n';
      }
    }

    // Cross-links
    body += '## Related\n\n';
    body += '- [Back to Bundle Index](./index.md)\n';
    for (const cl of catKeys) {
      if (cl !== cat && catQids[cl]) {
        body += `- [${CATEGORY_META[cl].title}](./${cl}.md)\n`;
      }
    }
    body += '\n## Contributors\n\n';
    for (const r of respondents) body += `- ${r.name}\n`;

    bundle[fileName] = body;
  }

  // Build index.md
  const indexSummary = bundleJson?.index_summary || '';
  let indexBody = '---\n';
  indexBody += 'type: KnowledgeBundle\n';
  indexBody += `title: ${escYaml(projectName)}\n`;
  indexBody += `description: "Chop-captured knowledge generated from expert interviews about: ${escYaml(seed)}"\n`;
  indexBody += 'tags: [chop, knowledge-capture, bundle]\n';
  indexBody += `timestamp: ${timestamp}\n`;
  indexBody += 'okf_version: "0.2"\n';
  indexBody += `source: "${escYaml(seed)}"\n`;
  indexBody += '---\n\n';
  indexBody += `# ${projectName}\n\n`;
  indexBody += `Captured on ${dateStr} via **Chop** — an interview-loop knowledge capture tool.\n\n`;
  if (indexSummary) indexBody += `${indexSummary}\n\n`;
  indexBody += '## Metadata\n\n';
  indexBody += `- **Seed:** ${seed}\n`;
  indexBody += `- **Respondents:** ${respondents.map(e => e.name).join(', ')}\n`;
  indexBody += `- **Questions Answered:** ${allAnswers.filter(a => !a.skipped && a.answer).length}\n`;
  indexBody += `- **Categories:** ${Object.keys(catQids).length}\n\n`;
  indexBody += '## Concepts\n\n';
  for (const icat of catKeys) {
    const imeta = CATEGORY_META[icat];
    const icount = (catQids[icat] || []).length;
    indexBody += `- [${imeta.title}](${icat}.md) — ${imeta.description}`;
    if (icount > 0) indexBody += ` (${icount} question${icount > 1 ? 's' : ''})`;
    indexBody += '\n';
  }
  indexBody += '\n## Contributors\n\n';
  for (const r of respondents) indexBody += `- ${r.name}\n`;
  bundle['index.md'] = indexBody;

  // Build log.md
  const logNotes = bundleJson?.log_notes || '';
  let logBody = '---\n';
  logBody += 'type: Log\n';
  logBody += `title: Capture Log — ${projectName}\n`;
  logBody += 'tags: [chop, log]\n';
  logBody += `timestamp: ${timestamp}\n`;
  logBody += '---\n\n';
  logBody += `# Capture Log\n\n`;
  logBody += `## ${dateStr}\n`;
  logBody += `* **Creation:** Bundle created from Chop capture session.\n`;
  logBody += `* **Seed:** "${seed}"\n`;
  logBody += `* **Respondents:** ${respondents.length} expert${respondents.length !== 1 ? 's' : ''} contributed.\n`;
  logBody += `* **Total answers:** ${allAnswers.filter(a => !a.skipped && a.answer).length}\n`;
  if (logNotes) logBody += `* **Notes:** ${logNotes}\n`;
  for (const r of respondents) {
    logBody += `* **${r.name}** completed ${r.answered} question${r.answered !== 1 ? 's' : ''}.\n`;
  }
  bundle['log.md'] = logBody;

  return bundle;
}

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

    // Run both AI calls in parallel (synthesis markdown + bundle JSON)
    const [markdown, bundleJson] = await Promise.all([
      synthesizeMarkdown(project.name, project.seed, experts, questions, allAnswers, apiKey),
      buildBundleJson(project.seed, questions, allAnswers, experts, apiKey),
    ]);

    // Build the OKF bundle
    const bundle = buildBundle(project.name, project.seed, experts, questions, allAnswers, markdown, bundleJson);

    // Save the result
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