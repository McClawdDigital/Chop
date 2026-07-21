// Test: dump raw questions to see their structure
Deno.serve(async (req: Request) => {
  try {
    const body = await req.json();
    const seed = body.seed || 'Document our data platform';
    const apiKey = Deno.env.get('OPENROUTER_API_KEY');

    const system = `You are a knowledge-capture question designer. Your job is to decompose a seed topic and generate anchor-specific questions.

Rules:
1. Each question must reference specific named things from the seed.
2. Cover categories: scope, persona, process, people, gap, failure, source.
3. Generate 10-12 questions total.
4. Output ONLY a valid JSON array. No markdown fences, no commentary.

Each object must use these exact field names: qid, category, text (not 'question', not 'question_text').`;

    const user = `Seed topic: "${seed}"

Decompose and generate 10-12 questions. Output ONLY a valid JSON array. Use fields: qid, category, text. Example: [{"qid":"Q-1","category":"scope","text":"What systems?"}]`;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      }),
    });

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content || '';
    
    // Strip fences
    content = content.trim();
    if (content.startsWith('```json')) content = content.slice(7);
    else if (content.startsWith('```')) content = content.slice(3);
    if (content.endsWith('```')) content = content.slice(0, -3);
    content = content.trim();

    const questions = JSON.parse(content);
    
    // Dump the structure of each question
    const keys = new Set();
    const dumps = [];
    for (const q of questions) {
      Object.keys(q).forEach(k => keys.add(k));
      dumps.push(JSON.stringify(q));
    }

    return new Response(JSON.stringify({
      total: questions.length,
      fields_found: [...keys],
      samples: dumps.slice(0, 3),
      has_text: questions.every(q => 'text' in q),
      has_question: questions.every(q => 'question' in q),
    }), {status: 200, headers: {'Content-Type': 'application/json'}});
  } catch (e) {
    return new Response(JSON.stringify({
      error: e.message,
      stack: (e.stack || '').substring(0, 300),
    }), {status: 200, headers: {'Content-Type': 'application/json'}});
  }
});