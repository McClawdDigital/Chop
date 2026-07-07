// Chop MVP -- one Worker, in-memory store (no KV), no build step
// When the flow is validated, this entire codebase is disposable.
// Data lives in memory -- survives warm Workers, lost on cold start.
// That's fine for a playtest with a few people for a few hours.

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function t(n) { let s='';for(let i=n||8;i>0;i--)s+=B62[Math.random()*62|0];return s; }

// Static fallback questions -- used when AI generation fails
const DEFAULT_QUESTIONS = [
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

// AI-powered question generation -- adaptive, seed-decomposing
// Calls OpenRouter to analyze the seed and produce specific questions
// Reads API key from Supabase chop_config table so deploys don't need re-secret-ing
async function generateQuestions(seed, env) {
  // Fetch API key from Supabase config
  var apiKey = await fetchOpenRouterKey(env);
  if (!apiKey) {
    console.error('generateQuestions: Could not retrieve OPENROUTER_API_KEY from Supabase, falling back to defaults');
    return DEFAULT_QUESTIONS;
  }

  var systemPrompt = `You are a knowledge-capture question designer. Your job is to decompose a seed topic into its concrete components, then generate deeply specific questions anchored to the actual nouns in that seed.

## STRUCTURED SEED DECOMPOSITION (internal — do not output this analysis)
First, extract the following from the seed topic:

1. **ENTITIES** — Named systems, tools, platforms, frameworks, datasets, services, or products mentioned or implied
2. **ROLES** — Specific job titles, teams, personas, stakeholders implied by the topic
3. **PROCESSES** — Workflows, pipelines, step sequences, approval gates, or operational rhythms
4. **TOOLS** — Specific software, CLIs, UIs, APIs, dashboards, configuration files, or infrastructure components
5. **CONSTRAINTS** — Security boundaries, compliance requirements, SLAs, scale limitations, or organizational policies
6. **GAPS** — What is NOT covered by the seed, what the reader might be confused about, what is commonly under-documented

Then generate 10-12 questions that are DEEPLY SPECIFIC — every question must reference at least one specific named thing extracted above.

## Question design rules
- Every question MUST contain concrete, named references from the seed. Do NOT use generic question patterns with the seed topic simply inserted.
- If the seed mentions "Kubernetes" and "Helm", ask about "Helm chart values" and "kubeconfig context", not just "what tools are used?"
- If the seed mentions "SOC 2 compliance" and "AWS", ask about "AWS Config rules" or "evidence collection for SOC 2 control A1.2", not just "what are the compliance requirements?"
- Questions should feel like they were written by someone who already understands the domain and wants to surface undocumented specifics.
- Cover categories that naturally fit the seed (scope, persona, process, people, gap, failure, source). You are NOT required to cover all 7 — pick the 4-6 that are most relevant, but do generate 10-12 total questions. Distribute questions across the selected categories naturally.
- Output ONLY a valid JSON array. No markdown fences, no commentary, no explanation.
- Each object: {"qid": "Q-CATEGORY-NN", "category": "scope|persona|process|people|gap|failure|source", "text": "the question text"}

## Examples of anchored vs template questions

Seed: "Document how we deploy our React SPA frontend to Cloudflare Pages using GitHub Actions"
ANCHORED (GOOD): "Which specific Cloudflare Pages project name and account ID are used for production, and what GitHub Actions workflow file (.github/workflows/deploy.yml) triggers the build — what are the exact branch triggers and environment secrets required?"
GENERIC (BAD): "What tools are used in the deployment process?"

Seed: "Capture the onboarding steps for a data engineer joining the analytics team, including Snowflake, dbt, Airflow, and Looker access"
ANCHORED (GOOD): "Which Snowflake role (e.g., TRANSFORMER, ANALYST) is assigned to new data engineers, and who in the analytics team currently manages Snowflake warehouse grants and dbt Cloud project permissions?"
GENERIC (BAD): "What tools does a new data engineer need?"

Seed: "Document the incident response process for production outages in our Kubernetes cluster (EKS, Istio, Datadog)"
ANCHORED (GOOD): "When Datadog triggers a P1 alert for high error rate on the 'checkout-service' pod, what is the exact sequence of commands (kubectl, istioctl, etc.) the on-call engineer runs to diagnose and mitigate — and which Slack channel receives the alert notification?"
GENERIC (BAD): "What happens during an incident?"`;

  var userPrompt = `Seed topic: "${seed}"

Decompose this seed topic into its specific entities, tools, roles, processes, constraints, and gaps. Then generate 10-12 deeply specific questions for a knowledge capture questionnaire. Every question must reference concrete, named things from the seed — not generic templates with the topic inserted. Output ONLY the JSON array, no other text.`;

  try {
    var response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'HTTP-Referer': 'https://chop-mvp.nousresearch.com',
        'X-Title': 'Chop MVP'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [
          {role: 'system', content: systemPrompt},
          {role: 'user', content: userPrompt}
        ],
        temperature: 0.7,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      console.error('generateQuestions: API returned ' + response.status, await response.text());
      return DEFAULT_QUESTIONS;
    }

    var data = await response.json();
    var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) {
      console.error('generateQuestions: No content in response', JSON.stringify(data));
      return DEFAULT_QUESTIONS;
    }

    // Strip any markdown code fences the model might add
    content = content.trim();
    if (content.startsWith('```json')) content = content.slice(7);
    else if (content.startsWith('```')) content = content.slice(3);
    if (content.endsWith('```')) content = content.slice(0, -3);
    content = content.trim();

    var questions = JSON.parse(content);

    // Validate structure
    if (!Array.isArray(questions) || questions.length < 8 || questions.length > 12) {
      console.error('generateQuestions: Invalid question count or not an array', questions.length);
      return DEFAULT_QUESTIONS;
    }

    for (var i = 0; i < questions.length; i++) {
      var q = questions[i];
      if (!q.qid || !q.category || !q.text ||
          ['scope','persona','process','people','gap','failure','source'].indexOf(q.category) === -1) {
        console.error('generateQuestions: Invalid question at index ' + i, JSON.stringify(q));
        return DEFAULT_QUESTIONS;
      }
    }

    return questions;

  } catch (e) {
    console.error('generateQuestions: Exception', e.message);
    return DEFAULT_QUESTIONS;
  }
}

// HTML shell -- string concatenation, no template literals
const CSS = '*{box-sizing:border-box;margin:0;padding:0}'+
'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f0f0f;color:#e0e0e0}'+
'.container{max-width:720px;margin:0 auto;padding:24px 16px}'+
'h1{font-size:1.6rem;margin-bottom:4px;color:#fff}'+
'.logo{font-size:1.8rem;margin-bottom:16px}'+
'.sub{color:#888;font-size:.9rem;margin-bottom:24px}'+
'.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin-bottom:16px}'+
'label{display:block;font-size:.85rem;color:#aaa;margin-bottom:6px;font-weight:600}'+
'input,textarea{width:100%;background:#222;border:1px solid #333;color:#e0e0e0;border-radius:8px;padding:10px 12px;font-size:.95rem;font-family:inherit;margin-bottom:12px}'+
'textarea{min-height:80px;resize:vertical}'+
'input:focus,textarea:focus{outline:none;border-color:#f97316}'+
'.btn{display:inline-flex;align-items:center;gap:6px;background:#f97316;color:#000;font-weight:600;border:none;border-radius:8px;padding:10px 20px;cursor:pointer;font-size:.95rem}'+
'.btn:hover{background:#fb923c}'+
'.btn-secondary{background:#2a2a2a;color:#ccc}'+
'.btn-secondary:hover{background:#333}'+
'.btn-sm{padding:6px 12px;font-size:.8rem}'+
'.q-badge{display:inline-block;background:#2d2d2d;color:#f97316;font-size:.75rem;font-weight:600;padding:2px 8px;border-radius:4px;margin-bottom:8px}'+
'.skip-btn{background:none;border:1px solid #444;color:#888;border-radius:8px;padding:10px 20px;cursor:pointer;font-size:.9rem}'+
'.skip-btn:hover{border-color:#666;color:#aaa}'+
'.progress{display:flex;gap:12px;font-size:.85rem;color:#888;margin-bottom:16px}'+
'.tag{display:inline-block;background:#1e3a5f;color:#60a5fa;font-size:.7rem;padding:2px 6px;border-radius:4px;margin-right:4px}'+
'.tag.scope{background:#1e3a1e;color:#4ade80}'+
'.tag.persona{background:#3b1e3a;color:#e879f9}'+
'.tag.process{background:#1e2a3a;color:#60a5fa}'+
'.tag.gap{background:#3a2a1e;color:#fb923c}'+
'.tag.people{background:#1e3a3a;color:#22d3ee}'+
'.tag.failure{background:#3a1e1e;color:#f87171}'+
'.tag.source{background:#2a1e3a;color:#a78bfa}'+
'.expert-card{display:flex;align-items:center;justify-content:space-between;padding:12px;border:1px solid #2a2a2a;border-radius:8px;margin-bottom:8px}'+
'.expert-card .name{font-weight:500}'+
'.status.done{color:#4ade80}.status.in-progress{color:#fbbf24}.status.pending{color:#888}'+
'.expert-input-row{display:flex;gap:8px;margin-bottom:8px}'+
'.expert-input-row input{margin-bottom:0;flex:1}'+
'.flex-between{display:flex;justify-content:space-between;align-items:center}'+
'.admin-table{width:100%;border-collapse:collapse;font-size:.8rem}'+
'.admin-table th,.admin-table td{text-align:left;padding:6px 8px;border-bottom:1px solid #2a2a2a}'+
'.admin-table th{color:#888;font-weight:600}'+
'pre{background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:16px;overflow-x:auto;font-size:.8rem;color:#ccc}'+
'.inline-code{background:#222;padding:2px 6px;border-radius:4px;font-size:.85rem}'+
'.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:12px 20px;display:none;z-index:100}';

function shell(body, title, extra) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+(title||'Chop')+'</title><style>'+CSS+'</style></head><body><div class="container">'+body+'</div><div id="toast" class="toast"></div><script>function showToast(msg,d){var t=document.getElementById("toast");t.textContent=msg;t.classList.add("show");setTimeout(function(){t.classList.remove("show")},d||3000)}'+(extra||'')+'</script></body></html>';
}

// Auth UI helpers
function authScript() {
  return 'var tok=sessionStorage.getItem("chop_token");' +
    'async function authFetch(u,o){if(!o)o={};o.headers=o.headers||{};if(tok)o.headers["Authorization"]="Bearer "+tok;return fetch(u,o)}' +
    'async function getMe(){try{var r=await authFetch("/auth/me");return await r.json()}catch(e){return{user:null}}}' +
    'async function logout(){sessionStorage.removeItem("chop_token");window.location.href="/"}';
}

function navBar(user) {
  var items = '<div class="logo" style="font-size:1.2rem;margin-bottom:0">\u{1FA97}</div>';
  items += '<div style="display:flex;align-items:center;gap:12px;flex:1;justify-content:flex-end">';
  items += '<a href="/" style="color:#888;text-decoration:none;font-size:.85rem">Projects</a>';
  if (user && user.email) {
    items += '<span style="color:#666;font-size:.85rem">' + escHtml(user.email) + '</span>';
    items += '<button class="btn btn-sm btn-secondary" onclick="logout()" style="cursor:pointer">Logout</button>';
  } else {
    items += '<a href="/login" class="btn btn-sm btn-secondary" style="text-decoration:none">Login</a>';
    items += '<a href="/login" class="btn btn-sm" style="text-decoration:none;color:#000">Sign Up</a>';
  }
  items += '</div>';
  return '<div class="flex-between" style="margin-bottom:24px;padding-bottom:12px;border-bottom:1px solid #2a2a2a">' + items + '</div>';
}

// Routes
async function homePage(req, env) {
  var token = getAuthToken(req);
  var user = null;
  if (token) {
    var uid = jwtUserId(token);
    if (uid) {
      var r = await sbAuth(env, 'user', {});
      if (r.ok) user = {id: uid, email: r.data && r.data.email};
    }
  }

  var body = '';

  if (user && user.email) {
    // Logged in: show project dashboard
    body += navBar(user);
    body += '<div class="flex-between"><h1>Your Projects</h1></div>';
    body += '<div id="dashboard-area"></div>';
    body += '<div class="card" id="new-project-card" style="display:none">'+
      '<label>What do you want to capture?</label>'+
      '<textarea id="seed" placeholder="e.g. We need to document how our data pipeline works..."></textarea>'+
      '<div style="display:flex;gap:8px;align-items:center"><button class="btn" onclick="startProject()">Generate Questions</button><span style="color:#666;font-size:0.8rem" id="status-msg"></span></div>'+
    '</div>';

    var extra = authScript() +
      'var cp=null;' +
      'async function loadDashboard(){' +
      'try{var r=await authFetch("/api/projects");var d=await r.json();if(!r.ok)throw new Error(d.error||"Failed");renderDashboard(d.projects||[])}catch(e){showToast("Error: "+e.message)}' +
      '}' +
      'function renderDashboard(projects){' +
      'var da=document.getElementById("dashboard-area");' +
      'da.innerHTML=\'<div style="margin-bottom:16px"><button class="btn" onclick="showNewProject()" id="new-project-btn">+ New Project</button></div>\';' +
      'if(projects.length===0){da.innerHTML+=\'<div class="card" style="text-align:center;padding:40px 0"><div style="color:#666;font-size:1rem">No projects yet.</div><div style="color:#555;font-size:0.85rem;margin-top:8px">Create your first project to capture knowledge.</div></div>\';return}' +
      'da.innerHTML+=projects.map(function(p){' +
      'var qc=p.questions?p.questions.length:0;' +
      'return\'<div class="card project-card" style="cursor:pointer" onclick="window.location.href=\\\'/project/\'+p.id+\'\\\'">\' +' +
      '\'<div class="flex-between"><div><strong>\'+escHtml(p.name||"Untitled")+\'</strong><span class="tag" style="margin-left:8px">\'+escHtml(p.status||"draft")+\'</span></div>\' +' +
      '\'<span style="color:#666;font-size:0.8rem">\'+(p.created_at||"").slice(0,10)+\'</span></div>\' +' +
      '\'<div style="font-size:0.85rem;color:#888;margin-top:4px">\'+escHtml((p.seed||"").slice(0,100))+\'</div>\' +' +
      '\'<div style="font-size:0.8rem;color:#666;margin-top:8px">\'+qc+\' questions</div>\' +' +
      '\'</div>\'}).join("")' +
      '}' +
      'function showNewProject(){document.getElementById("new-project-card").style.display="block";document.getElementById("new-project-btn").style.display="none"}' +
      'async function startProject(){var s=document.getElementById("seed").value.trim();if(!s){showToast("Enter a topic first");return}' +
      'var b=document.querySelector("#new-project-card .btn");b.disabled=true;b.textContent="Generating...";' +
      'try{var r=await authFetch("/api/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({seed:s})});var d=await r.json();if(!r.ok)throw new Error(d.error||"Failed");' +
      'window.location.href="/project/"+d.id}catch(e){showToast("Error: "+e.message)}' +
      'b.disabled=false;b.textContent="Generate Questions"}' +
      'loadDashboard();';
    return new Response(shell(body, 'Chop - Dashboard', extra), {headers:{'Content-Type':'text/html'}});
  } else {
    // Not logged in: show landing with login prompt
    body += navBar(null);
    body += '<div style="text-align:center;padding:40px 0">';
    body += '<div class="logo" style="font-size:3rem;margin-bottom:16px">\u{1FA97}</div>';
    body += '<h1>Chop</h1>';
    body += '<div class="sub" style="font-size:1.1rem;margin-bottom:32px">Not a chatbot. An interview loop.</div>';
    body += '<div style="max-width:400px;margin:0 auto">';
    body += '<p style="color:#888;margin-bottom:24px">Capture expert knowledge by running structured interview loops. Create projects, invite experts, and synthesize their answers into knowledge documents.</p>';
    body += '<a href="/login" class="btn" style="text-decoration:none;display:inline-block">Sign Up or Log In</a>';
    body += '</div></div>';
    return new Response(shell(body, 'Chop - Capture Knowledge', authScript()), {headers:{'Content-Type':'text/html'}});
  }
}

async function loginPage(req, env) {
  return new Response(shell(
    navBar(null) +
    '<div style="max-width:400px;margin:40px auto">' +
      '<h1 style="text-align:center">Sign In</h1>' +
      '<div class="card" style="margin-top:20px">' +
        '<div id="login-form">' +
          '<label>Email</label>' +
          '<input type="email" id="login-email" placeholder="you@example.com" autocomplete="email">' +
          '<label>Password</label>' +
          '<input type="password" id="login-password" placeholder="Enter password" autocomplete="current-password">' +
          '<div style="display:flex;gap:8px">' +
            '<button class="btn" onclick="doLogin()" style="flex:1">Log In</button>' +
            '<button class="btn btn-secondary" onclick="doSignup()" style="flex:1">Sign Up</button>' +
          '</div>' +
          '<div id="login-error" style="color:#f87171;font-size:0.85rem;margin-top:8px;display:none"></div>' +
        '</div>' +
        '<div id="login-success" style="display:none;text-align:center;padding:20px 0">' +
          '<div style="font-size:2rem;margin-bottom:8px">\u2705</div>' +
          '<div>Success! Redirecting...</div>' +
        '</div>' +
      '</div>' +
    '</div>',
    'Chop - Login',
    'async function doLogin(){var e=document.getElementById("login-email").value.trim();var p=document.getElementById("login-password").value;if(!e||!p){showToast("Enter email and password");return}' +
    'try{var r=await fetch("/login/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:e,password:p})});var d=await r.json();' +
    'if(!r.ok){var er=document.getElementById("login-error");er.textContent=d.error||"Login failed";er.style.display="block";return}' +
    'sessionStorage.setItem("chop_token",d.access_token);document.getElementById("login-form").style.display="none";document.getElementById("login-success").style.display="block";' +
    'setTimeout(function(){window.location.href="/"},1000)}catch(e){showToast("Error: "+e.message)}}' +
    'async function doSignup(){var e=document.getElementById("login-email").value.trim();var p=document.getElementById("login-password").value;if(!e||!p){showToast("Enter email and password");return}' +
    'try{var r=await fetch("/login/signup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:e,password:p})});var d=await r.json();' +
    'if(!r.ok){var er=document.getElementById("login-error");er.textContent=d.error||"Signup failed";er.style.display="block";return}' +
    'if(d.access_token){sessionStorage.setItem("chop_token",d.access_token)}' +
    'document.getElementById("login-form").style.display="none";document.getElementById("login-success").style.display="block";' +
    'setTimeout(function(){window.location.href="/"},1000)}catch(e){showToast("Error: "+e.message)}}'
  ), {headers:{'Content-Type':'text/html'}});
}

async function loginPost(req, env) {
  var body = await req.json();
  var r = await sbAuth(env, 'token?grant_type=password', {email: body.email, password: body.password});
  if (!r.ok) {
    var errMsg = (r.data && (r.data.msg || r.data.error_description)) || 'Login failed';
    return json({error: errMsg}, 401);
  }
  return json({user: r.data.user, access_token: r.data.access_token});
}

async function signupPost(req, env) {
  var body = await req.json();
  var r = await sbAuth(env, 'signup', {email: body.email, password: body.password});
  if (!r.ok) {
    var errMsg = (r.data && (r.data.msg || r.data.error_description)) || 'Signup failed';
    return json({error: errMsg}, 400);
  }
  // If auto-confirm is on, we get a session back
  if (r.data && r.data.session && r.data.session.access_token) {
    return json({user: r.data.user, access_token: r.data.session.access_token});
  }
  // Otherwise try logging in immediately
  var loginR = await sbAuth(env, 'token?grant_type=password', {email: body.email, password: body.password});
  if (loginR.ok && loginR.data && loginR.data.access_token) {
    return json({user: loginR.data.user, access_token: loginR.data.access_token});
  }
  return json({user: r.data.user, access_token: null});
}

async function projectDetailPage(req, env, pid) {
  var token = getAuthToken(req);
  var user = null;
  if (token) {
    var uid = jwtUserId(token);
    if (uid) {
      var r = await sbAuth(env, 'user', {});
      if (r.ok) user = {id: uid, email: r.data && r.data.email};
    }
  }
  if (!user) {
    return new Response(shell(
      navBar(null) +
      '<div style="text-align:center;padding:60px 0"><h1>Unauthorized</h1><p style="color:#888;margin:16px 0">Please log in to view this project.</p><a href="/login" class="btn">Log In</a></div>',
      'Chop - Unauthorized'
    ), {headers:{'Content-Type':'text/html'}});
  }
  return new Response(shell(
    navBar(user) +
    '<div id="project-area">' +
      '<div id="project-loading" style="text-align:center;padding:40px 0;color:#888">Loading project...</div>' +
    '</div>' +
    '<div id="synthesis-output" style="display:none"></div>' +
    '<div id="toast" class="toast"></div>',
    'Chop - Project',
    authScript() +
    'var PID="'+pid+'";' +
    'async function loadProject(){' +
    'try{var r=await authFetch("/api/projects/"+PID);var p=await r.json();if(!r.ok)throw new Error(p.error||"Not found");renderProject(p)}catch(e){' +
    'document.getElementById("project-loading").textContent="Error: "+e.message}}' +
    'function renderProject(p){' +
    'var a=document.getElementById("project-area");' +
    'var qh="";for(var i=0;i<p.questions.length;i++){var q=p.questions[i];' +
    'qh+=\'<div style="padding:8px 0;border-bottom:1px solid #2a2a2a;display:flex;align-items:flex-start;gap:8px"><input type="checkbox" checked id="q-\'+i+\'" style="width:auto;margin-top:4px">\'' +
    '+\'<div><span class="q-badge">\'+q.qid+\'</span> <span class="tag \'+q.category+\'">\'+q.category+\'</span><div style="margin-top:4px;color:#ccc;font-size:0.9rem">\'+escHtml(q.text)+\'</div></div></div>\'}' +
    'a.innerHTML=\'<div class="flex-between" style="margin-bottom:16px"><div><a href="/" style="color:#888;text-decoration:none;font-size:0.85rem">&larr; Back to Projects</a><h2 style="margin-top:4px">\'+escHtml(p.name)+\'</h2><div class="sub" style="margin-bottom:0">\'+escHtml(p.seed.slice(0,150))+\'</div></div><span class="tag">\'+escHtml(p.status)+\'</span></div>\'+\'<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><label style="margin-bottom:0;font-size:1rem">Questions (\'+p.questions.length+\')</label></div><div id="q-list">\'+qh+\'</div></div>\'+\'<div class="card"><label style="font-size:1rem">Add Experts</label><div style="margin-bottom:12px"><div class="expert-input-row"><input id="expert-name" placeholder="Name (e.g. Alice - Data Eng)" style="margin-bottom:0"><input id="expert-email" placeholder="Email (optional)" style="margin-bottom:0"><button class="btn btn-sm" onclick="addExpert()">+ Add</button></div></div><div id="expert-list"></div><div id="expert-links" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid #333"></div><div id="progress-area" style="margin-top:12px;display:none"></div><div style="margin-top:12px"><button class="btn" id="synthesize-btn" style="display:none" onclick="triggerSynth()">Synthesize Now</button></div></div>\';' +
    'refreshExperts()}' +
    'async function addExpert(){var n=document.getElementById("expert-name").value.trim();if(!n){showToast("Enter a name");return}' +
    'var e=document.getElementById("expert-email").value.trim();' +
    'var r=await fetch("/api/projects/"+PID+"/experts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:n,email:e})});' +
    'var d=await r.json();if(!r.ok){showToast(d.error||"Failed");return}' +
    'document.getElementById("expert-name").value="";document.getElementById("expert-email").value="";refreshExperts()}' +
    'async function refreshExperts(){' +
    'var r=await fetch("/api/projects/"+PID+"/experts");var d=await r.json();if(!r.ok)return;' +
    'var el=document.getElementById("expert-list");var ll=document.getElementById("expert-links");var pa=document.getElementById("progress-area");var sb=document.getElementById("synthesize-btn");' +
    'if(!d.experts||d.experts.length===0){el.innerHTML=\'<div style="color:#666;font-size:0.85rem">Add experts who have the knowledge you want to capture.</div>\';ll.style.display="none";pa.style.display="none";sb.style.display="none";return}' +
    'el.innerHTML=d.experts.map(function(e){var sc="pending",st="Pending";if(e.status==="sent"){sc="pending";st="Sent"}if(e.status==="in_progress"){sc="in-progress";st="In Progress"}if(e.status==="completed"){sc="done";st="Done"}' +
    'return\'<div class="expert-card"><div><div class="name">\'+escHtml(e.name)+\'</div><div style="font-size:0.75rem;color:#666;margin-top:2px">\'+(e.answered||0)+\'/\'+(e.total_questions||\'?\')+\' answered</div></div>\'+\'<div style="display:flex;align-items:center;gap:8px"><span class="status \'+sc+\'">\'+st+\'</span></div></div>\'}).join("");' +
    'll.style.display="block";ll.innerHTML=\'<label>Share Links</label>\';' +
    'd.experts.forEach(function(e){ll.innerHTML+=\'<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:0.85rem"><span style="min-width:120px">\'+escHtml(e.name)+\'</span><code class="inline-code" style="flex:1">\'+window.location.origin+\'/answer/\'+e.token+\'</code></div>\'});' +
    'var tot=d.experts.length;var done=d.experts.filter(function(e){return e.status==="completed"}).length;' +
    'pa.style.display="block";pa.innerHTML=\'<div style="margin-top:8px;padding-top:12px;border-top:1px solid #333"><div class="progress"><span>People: \'+tot+\'</span><span>Done: \'+done+\'</span></div></div>\';' +
    'var hasAns=d.experts.some(function(e){return parseInt(e.answered||0)>0});sb.style.display=hasAns?"inline-flex":"none"}' +
    'async function triggerSynth(){var b=document.getElementById("synthesize-btn");b.disabled=true;b.textContent="Synthesizing...";' +
    'try{var r=await authFetch("/api/projects/"+PID+"/synthesize",{method:"POST",headers:{"Content-Type":"application/json"}});var d=await r.json();if(!r.ok)throw new Error(d.error||"Failed");' +
    'var o=document.getElementById("synthesis-output");o.style.display="block";' +
    'var bundleHtml="";if(d.bundle){var bkeys=Object.keys(d.bundle);' +
    'bundleHtml=\'<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">\';' +
    'bundleHtml+=\'<button class="btn btn-sm" onclick="downloadBundle()">Download OKF Bundle (.zip)</button>\';' +
    'bundleHtml+=\'<button class="btn btn-sm btn-secondary" onclick="downloadFile(\'index.md\')">index.md</button>\';' +
    'bundleHtml+=\'<button class="btn btn-sm btn-secondary" onclick="downloadFile(\'log.md\')">log.md</button>\';' +
    'bkeys.forEach(function(f){if(f!==\'index.md\'&&f!==\'log.md\'){bundleHtml+=\'<button class="btn btn-sm btn-secondary" onclick="downloadFile(\'\'+f+\'\')">\'+f+\'</button>\'}});' +
    'bundleHtml+=\'</div>\';}' +
    'o.innerHTML=\'<div class="card"><h3>Output</h3><pre id="md-out">\'+escHtml(d.markdown)+\'</pre><div style="margin-top:12px"><button class="btn btn-sm" onclick="copyMd()">Copy Markdown</button></div>\'+bundleHtml+\'</div>\';showToast("Synthesis complete!")}catch(e){showToast("Error: "+e.message)}' +
    'b.disabled=false;b.textContent="Synthesize Now"}' +
    'function copyMd(){var p=document.getElementById("md-out");navigator.clipboard.writeText(p.textContent).then(function(){showToast("Copied!")})}' +
    'function downloadBundle(){' +
    'authFetch("/api/projects/"+PID+"/synthesize",{method:"POST",headers:{"Content-Type":"application/json"}}).then(function(r){return r.json()}).then(function(d){' +
    'if(!d.bundle){showToast("No bundle data");return}' +
    'var zip=new JSZip();var bkeys=Object.keys(d.bundle);' +
    'for(var i=0;i<bkeys.length;i++){zip.file(bkeys[i],d.bundle[bkeys[i]])}' +
    'zip.generateAsync({type:"blob"}).then(function(blob){' +
    'var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="okf-bundle-"+PID+".zip";a.click();' +
    'URL.revokeObjectURL(a.href);showToast("Bundle downloaded!")})})}' +
    'function downloadFile(fn){' +
    'authFetch("/api/projects/"+PID+"/synthesize",{method:"POST",headers:{"Content-Type":"application/json"}}).then(function(r){return r.json()}).then(function(d){' +
    'if(!d.bundle||!d.bundle[fn]){showToast("File not found");return}' +
    'var blob=new Blob([d.bundle[fn]],{type:"text/markdown"});var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=fn;a.click();URL.revokeObjectURL(a.href)})}' +
    'loadProject();'
  ), {headers:{'Content-Type':'text/html'}});
}

// List user's projects (needs auth)
async function listUserProjects(req, env) {
  var uid = getUserId(req, env);
  if (!uid) return json({error: 'Unauthorized', projects: []}, 401);
  var projects = await sbQuery(env, 'chop_projects?user_id=eq.' + uid + '&select=*&order=created_at.desc');
  if (!projects) projects = [];
  return json({projects: projects});
}

async function answerPage(req, env, token) {
  var experts = await sbQuery(env, 'chop_experts?token=eq.' + token + '&select=*');
  var expert = experts && experts[0];
  if (!expert) {
    return new Response(shell(
      '<div style="text-align:center;padding:60px 0"><div class="logo" style="font-size:3rem">\u{1FA97}</div><h1>Link not found</h1><p style="color:#888;margin:16px 0">This answer link doesn\'t exist or has expired.</p><a href="/" class="btn">Start your own project</a></div>',
      'Chop - Link not found'
    ), {headers:{'Content-Type':'text/html'}});
  }
  var projects = await sbQuery(env, 'chop_projects?id=eq.' + expert.project_id + '&select=*');
  var project = projects && projects[0];
  if (!project) return new Response('Not found', {status:404});

  return new Response(shell(
    '<div id="answer-app" style="padding:20px 0">'+
      '<div style="text-align:center;margin-bottom:24px">'+
        '<div class="logo" style="font-size:2rem">\u{1FA97}</div>'+
        '<h1>'+escHtml(project.name)+'</h1>'+
        '<div class="sub" style="margin-bottom:0">Answering on behalf of <strong>'+escHtml(expert.name)+'</strong></div>'+
      '</div>'+
      '<div class="card" id="answer-card">'+
        '<div class="progress" id="progress-bar"><span id="a-count">0</span> answered · <span id="s-count">0</span> skipped · <span id="t-count">0</span> total</div>'+
        '<div id="question-area">'+
          '<div class="q-badge" id="qid-badge">Q-??-??</div>'+
          '<div style="font-size:1.1rem;margin-bottom:16px;line-height:1.5" id="q-text"></div>'+
          '<textarea id="answer-input" placeholder="Type your answer..." style="min-height:120px"></textarea>'+
          '<div style="display:flex;gap:8px;justify-content:space-between">'+
            '<button class="skip-btn" onclick="skipQ()">Skip</button>'+
            '<button class="btn" onclick="submitA()">Submit & Next</button>'+
          '</div>'+
        '</div>'+
        '<div id="done-area" style="display:none;text-align:center;padding:40px 0">'+
          '<div style="font-size:3rem;margin-bottom:12px">\u2705</div>'+
          '<h2>All done! Thank you!</h2>'+
          '<p style="color:#888;margin-top:8px">Your answers have been saved. You can close this page.</p>'+
          '<div style="margin-top:16px;font-size:0.85rem;color:#666" id="done-stats"></div>'+
        '</div>'+
      '</div>'+
    '</div>',
    'Chop - Answer Questions',
    'var T="'+token+'";var A=[];var I=0;'+
    'async function loadQ(){var r=await fetch("/api/answer/"+T+"/questions");var d=await r.json();if(!r.ok){showToast("Error loading");return}A=d.assignments;I=d.current_index;renderQ()}'+
    'function renderQ(){var a=A.filter(function(x){return x.answered}).length;var s=A.filter(function(x){return x.skipped}).length;var t=A.length;'+
    'document.getElementById("a-count").textContent=a;document.getElementById("s-count").textContent=s;document.getElementById("t-count").textContent=t;'+
    'if(I>=t){document.getElementById("question-area").style.display="none";document.getElementById("done-area").style.display="block";'+
    'document.getElementById("done-stats").textContent="You answered "+a+" of "+t+" questions"+(s>0?" (skipped "+s+").":".");return}'+
    'var q=A[I];document.getElementById("qid-badge").textContent=q.qid;document.getElementById("q-text").textContent=q.text;document.getElementById("answer-input").value="";document.getElementById("answer-input").focus()}'+
    'async function submitA(){var txt=document.getElementById("answer-input").value.trim();var r=await fetch("/api/answer/"+T+"/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({idx:I,text:txt})});'+
    'var d=await r.json();if(!r.ok){showToast("Error");return}A=d.assignments;I=d.current_index;renderQ()}'+
    'async function skipQ(){var r=await fetch("/api/answer/"+T+"/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({idx:I,skip:true})});'+
    'var d=await r.json();if(!r.ok){showToast("Error");return}A=d.assignments;I=d.current_index;renderQ()}'+
    'loadQ()'
  ), {headers:{'Content-Type':'text/html'}});
}

async function adminPage(req, env) {
  var uid = getUserId(req, env);
  if (!uid) return new Response(shell('<div style="text-align:center;padding:60px 0"><h1>Unauthorized</h1><p style="color:#888;margin:16px 0">Please log in first.</p><a href="/" class="btn">Go Home</a></div>', 'Chop - Unauthorized'), {headers:{'Content-Type':'text/html'}});

  var projects = await sbQuery(env, 'chop_projects?select=*');
  if (!projects) projects = [];

  var pHtml = '';
  for (var i = 0; i < projects.length; i++) {
    var p = projects[i];
    var experts = await sbQuery(env, 'chop_experts?project_id=eq.' + p.id + '&select=*');
    if (!experts) experts = [];
    var rows = '';
    for (var j = 0; j < experts.length; j++) {
      var e = experts[j];
      rows += '<tr><td>'+escHtml(e.name)+'</td><td>'+(e.email||'-')+'</td><td>'+e.status+'</td><td>'+(e.answered||0)+'/'+(e.total_questions||'?')+'</td></tr>';
    }
    pHtml += '<div class="card" style="margin-bottom:16px">'+
      '<div class="flex-between" style="margin-bottom:8px"><div><strong>'+escHtml(p.name)+'</strong> <span class="tag">'+p.status+'</span></div><span style="color:#666;font-size:0.8rem">'+(p.created_at||'')+'</span></div>'+
      '<div style="font-size:0.85rem;color:#888;margin-bottom:8px">'+escHtml((p.seed||'').slice(0,150))+'</div>'+
      (experts.length > 0 ? '<table class="admin-table"><tr><th>Expert</th><th>Email</th><th>Status</th><th>Progress</th></tr>'+rows+'</table>' : '<span style="color:#666;font-size:0.8rem">No experts added</span>')+
      '<div style="margin-top:8px;font-size:0.8rem;color:#666">Questions: '+(p.questions||[]).length+' | Experts: '+experts.length+'</div></div>';
  }

  return new Response(shell(
    '<div class="flex-between" style="margin-bottom:16px"><div><div class="logo" style="font-size:1.5rem">\u{1FA97}</div><h1>Admin</h1><div class="sub">All projects</div></div><div><a href="/" class="btn btn-secondary btn-sm" style="text-decoration:none">Home</a></div></div>'+
    '<div class="card"><h3>Projects ('+projects.length+')</h3>'+(projects.length === 0 ? '<div style="color:#666;padding:20px 0;text-align:center">No projects yet</div>' : pHtml)+'</div>',
    'Chop Admin'
  ), {headers:{'Content-Type':'text/html'}});
}

async function getEvents(req, env) {
  return json({events: []});
}

async function createProject(req, env) {
  var body = await req.json();
  if (!body.seed || body.seed.length < 5) return json({error:'Seed too short'}, 400);
  var questions = await generateQuestions(body.seed, env);
  var name = body.seed.split('.')[0].slice(0,40).trim() || 'Untitled';
  var result = await sbQuery(env, 'chop_projects', {
    method: 'POST',
    body: {name: name, seed: body.seed, questions: questions, status: 'questions_generated', user_id: '00000000-0000-0000-0000-000000000000'}
  });
  var project = result && result[0];
  if (!project) return json({error:'Failed to create project'}, 500);
  var ot = t(8);
  return json({...project, owner_token: ot});
}

async function addExpert(req, env, pid) {
  var projects = await sbQuery(env, 'chop_projects?id=eq.' + pid + '&select=*');
  var p = projects && projects[0];
  if (!p) return json({error:'Not found'}, 404);
  var body = await req.json();
  if (!body.name) return json({error:'Name required'}, 400);
  var et = t(8);
  var result = await sbQuery(env, 'chop_experts', {
    method: 'POST',
    body: {project_id: pid, name: body.name, email: body.email||'', token: et, status:'pending', answered:0, total_questions: (p.questions||DEFAULT_QUESTIONS).length}
  });
  var expert = result && result[0];
  if (!expert) return json({error:'Failed to add expert'}, 500);
  return json({expert});
}

async function listExperts(req, env, pid) {
  var experts = await sbQuery(env, 'chop_experts?project_id=eq.' + pid + '&select=*');
  if (!experts) experts = [];
  return json({experts: experts.map(function(e){return {...e, link:'/answer/'+e.token}})});
}

async function getProject(req, env, pid) {
  var projects = await sbQuery(env, 'chop_projects?id=eq.' + pid + '&select=*');
  var p = projects && projects[0];
  if (!p) return json({error:'Not found'}, 404);
  var experts = await sbQuery(env, 'chop_experts?project_id=eq.' + pid + '&select=*');
  if (!experts) experts = [];
  return json({...p, experts});
}

async function expertQuestions(req, env, token) {
  var experts = await sbQuery(env, 'chop_experts?token=eq.' + token + '&select=*');
  var expert = experts && experts[0];
  if (!expert) return json({error:'Not found'}, 404);
  var projects = await sbQuery(env, 'chop_projects?id=eq.' + expert.project_id + '&select=name,questions');
  var project = projects && projects[0];
  if (!project) return json({error:'Not found'}, 404);
  var questions = project.questions || DEFAULT_QUESTIONS;
  var answers = await sbQuery(env, 'chop_answers?expert_id=eq.' + expert.id + '&select=*');
  if (!answers) answers = [];
  var as = questions.map(function(q, i) {
    var existing = answers.find(function(a) { return a.question_id === q.qid; });
    return {idx:i, qid:q.qid, category:q.category, text:q.text, answered:!!(existing && existing.answer), skipped: existing ? existing.skipped : false, answer: existing ? existing.answer : null};
  });
  await sbQuery(env, 'chop_experts?id=eq.' + expert.id, {method:'PATCH', body:{status:'in_progress'}});
  var ci = as.findIndex(function(a){return !a.answered && !a.skipped});
  return json({assignments:as, current_index:ci >= 0 ? ci : as.length});
}

async function submitAnswer(req, env, token) {
  var body = await req.json();
  var experts = await sbQuery(env, 'chop_experts?token=eq.' + token + '&select=*');
  var expert = experts && experts[0];
  if (!expert) return json({error:'Not found'}, 404);
  var projects = await sbQuery(env, 'chop_projects?id=eq.' + expert.project_id + '&select=name,questions');
  var project = projects && projects[0];
  if (!project) return json({error:'Not found'}, 404);
  var questions = project.questions || DEFAULT_QUESTIONS;
  if (body.idx < 0 || body.idx >= questions.length) return json({error:'Invalid index'}, 400);
  var q = questions[body.idx];
  var ans = body.skip ? null : (body.text || '');
  // Upsert answer
  var existing = await sbQuery(env, 'chop_answers?expert_id=eq.' + expert.id + '&question_id=eq.' + q.qid + '&select=*');
  if (existing && existing.length > 0) {
    var ts = new Date().toISOString();
    await sbQuery(env, 'chop_answers?id=eq.' + existing[0].id, {method:'PATCH', body:{answer: ans, skipped: !!body.skip, answered_at: ts}});
  } else {
    await sbQuery(env, 'chop_answers', {method:'POST', body:{project_id: expert.project_id, expert_id: expert.id, question_id: q.qid, question_text: q.text, category: q.category, answer: ans, skipped: !!body.skip}});
  }
  // Count progress
  var allAnswers = await sbQuery(env, 'chop_answers?expert_id=eq.' + expert.id + '&select=*');
  if (!allAnswers) allAnswers = [];
  var answered = allAnswers.filter(function(a){return !a.skipped && a.answer;}).length;
  var skipped = allAnswers.filter(function(a){return a.skipped;}).length;
  var remaining = questions.length - answered - skipped;
  if (remaining <= 0) {
    await sbQuery(env, 'chop_experts?id=eq.' + expert.id, {method:'PATCH', body:{answered: answered, status:'completed'}});
  } else {
    await sbQuery(env, 'chop_experts?id=eq.' + expert.id, {method:'PATCH', body:{answered: answered}});
  }
  // Rebuild assignments
  var as = questions.map(function(qn, i) {
    var ea = allAnswers.find(function(a){return a.question_id === qn.qid;});
    return {idx:i, qid:qn.qid, category:qn.category, text:qn.text, answered:!!(ea && ea.answer), skipped: ea ? ea.skipped : false, answer: ea ? ea.answer : null};
  });
  var ci = as.findIndex(function(a){return !a.answered && !a.skipped});
  return json({assignments:as, current_index:ci >= 0 ? ci : as.length});
}

async function synthesize(req, env, pid) {
  var projects = await sbQuery(env, 'chop_projects?id=eq.' + pid + '&select=*');
  var p = projects && projects[0];
  if (!p) return json({error:'Not found'}, 404);
  var experts = await sbQuery(env, 'chop_experts?project_id=eq.' + pid + '&select=*');
  if (!experts) experts = [];
  var respondents = experts.filter(function(e){return e.answered > 0});
  var allAnswers = await sbQuery(env, 'chop_answers?project_id=eq.' + pid + '&select=*');
  if (!allAnswers) allAnswers = [];
  var all = [];
  var expertMap = {};
  for (var ei = 0; ei < experts.length; ei++) {
    expertMap[experts[ei].id] = experts[ei].name;
  }
  for (var ai = 0; ai < allAnswers.length; ai++) {
    var aa = allAnswers[ai];
    if (aa.answer && !aa.skipped) {
      all.push({name: expertMap[aa.expert_id] || 'Unknown', qid: aa.question_id, q: aa.question_text, a: aa.answer});
    }
  }
  var byQ = {};
  for (var k = 0; k < all.length; k++) {
    if (!byQ[all[k].qid]) byQ[all[k].qid] = {qid:all[k].qid, q:all[k].q, answers:[]};
    byQ[all[k].qid].answers.push({name:all[k].name, a:all[k].a});
  }
  var qidToCategory = {};
  var questions = p.questions || [];
  for (var qi = 0; qi < questions.length; qi++) {
    qidToCategory[questions[qi].qid] = questions[qi].category;
  }
  var groups = Object.values(byQ);
  var now = new Date();
  var dateStr = now.toISOString().slice(0,10);
  var timestamp = now.toISOString();

  // ---- Group answers by category (still needed for the prompt and bundle) ----
  var byCategory = {};
  for (var ci = 0; ci < groups.length; ci++) {
    var g = groups[ci];
    var cat = qidToCategory[g.qid] || 'uncategorized';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(g);
  }

  // Category display names and descriptions
  var categoryMeta = {
    scope:     {title: 'Scope',     description: 'Boundaries, systems, tools, and coverage areas.'},
    persona:   {title: 'Persona',   description: 'Who needs this knowledge and what they need.'},
    process:   {title: 'Process',   description: 'Core workflow steps, tools, and permissions.'},
    people:    {title: 'People',    description: 'Key people, roles, and ownership.'},
    gap:       {title: 'Gap',       description: 'What is undocumented or poorly understood.'},
    failure:   {title: 'Failure',   description: 'Common mistakes and failure points.'},
    source:    {title: 'Source',    description: 'Authoritative sources of truth.'}
  };

  // Determine confidence levels (kept for bundle building)
  function confidenceLevel(catAnswers) {
    var total = 0, expertsWithAnswer = {};
    for (var i = 0; i < catAnswers.length; i++) {
      for (var j = 0; j < catAnswers[i].answers.length; j++) {
        expertsWithAnswer[catAnswers[i].answers[j].name] = true;
        total++;
      }
    }
    var numExperts = Object.keys(expertsWithAnswer).length;
    if (numExperts >= 3 && total >= 5) return 'high';
    if (numExperts >= 2 && total >= 3) return 'medium';
    if (numExperts > 0) return 'low';
    return 'none';
  }

  function escYaml(s) {
    if (!s) return '';
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  }

  function buildConceptFrontmatter(type, title, description, tags) {
    var fm = '---\n';
    fm += 'type: ' + type + '\n';
    fm += 'title: ' + escYaml(title) + '\n';
    fm += 'description: ' + escYaml(description) + '\n';
    fm += 'tags: [' + tags.join(', ') + ']\n';
    fm += 'timestamp: ' + timestamp + '\n';
    fm += 'source: "' + escYaml(p.seed) + '"\n';
    fm += '---\n';
    return fm;
  }

  // ---- Build the AI synthesis prompt ----
  var answerBlocks = '';
  for (var gi = 0; gi < groups.length; gi++) {
    var g = groups[gi];
    var cat = qidToCategory[g.qid] || 'uncategorized';
    answerBlocks += '## Question: ' + g.q + '\n';
    answerBlocks += 'QID: ' + g.qid + ' | Category: ' + cat + '\n';
    for (var ai = 0; ai < g.answers.length; ai++) {
      answerBlocks += '- **' + g.answers[ai].name + '**: ' + g.answers[ai].a + '\n';
    }
    answerBlocks += '\n';
  }

  var systemPrompt = 'You are an expert knowledge synthesizer. Given raw expert interview answers about a topic, your job is to produce a coherent, structured knowledge document.';
  systemPrompt += ' Identify consensus statements, flag divergences or disagreements, highlight uncertainty, and extract actionable takeaways.';
  systemPrompt += ' Output valid markdown. Be thorough but concise.';

  var userPrompt = 'Synthesize the following expert answers into a structured knowledge document.\n\n';
  userPrompt += 'Project: ' + p.name + '\n';
  userPrompt += 'Seed topic: ' + p.seed + '\n\n';
  userPrompt += '## Expert Answers\n\n';
  userPrompt += answerBlocks;
  userPrompt += '\n\nProduce a markdown document with the following sections:\n';
  userPrompt += '1. **Executive Summary** — 2-3 paragraph synthesis of the key takeaways from all answers.\n';
  userPrompt += '2. **Key Insights by Category** — For each category that has answers, provide: consensus statements (what experts agreed on), divergence notes (where they disagreed or offered different perspectives), and uncertainty flags (areas lacking data).\n';
  userPrompt += '3. **Actionable Takeaways** — Concrete next steps, decisions, or actions implied by the knowledge.\n';
  userPrompt += '4. **Gaps & Recommended Follow-ups** — What is missing or needs further investigation.\n\n';
  userPrompt += 'Format: clean markdown. Use headings, bullet points, and **bold** for emphasis. Do NOT wrap in code fences.';

  // ---- Call OpenRouter for AI synthesis ----
  var apiKey = await fetchOpenRouterKey(env);
  var md = '';
  var mdFallback = '';

  if (apiKey) {
    try {
      var response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'HTTP-Referer': 'https://chop-mvp.nousresearch.com',
          'X-Title': 'Chop MVP'
        },
        body: JSON.stringify({
          model: 'openai/gpt-4o',
          messages: [
            {role: 'system', content: systemPrompt},
            {role: 'user', content: userPrompt}
          ],
          temperature: 0.7,
          max_tokens: 4000
        })
      });

      if (response.ok) {
        var data = await response.json();
        var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (content) {
          md = content.trim();
          // Strip code fences if model adds them
          if (md.startsWith('```markdown')) md = md.slice(12);
          else if (md.startsWith('```')) md = md.slice(3);
          if (md.endsWith('```')) md = md.slice(0, -3);
          md = md.trim();
        }
      } else {
        console.error('synthesize: API returned ' + response.status, await response.text());
      }
    } catch (e) {
      console.error('synthesize: Exception calling OpenRouter', e.message);
    }
  } else {
    console.error('synthesize: Could not retrieve OPENROUTER_API_KEY from Supabase');
  }

  // ---- Fallback: if AI call failed, produce a basic structured document ----
  if (!md) {
    md = '# ' + p.name + ' - Context Summary\n\n';
    md += '> **Note:** AI synthesis was unavailable. This is a structured fallback document.\n\n';
    md += '## Metadata\n';
    md += '- **Seed:** ' + p.seed + '\n';
    md += '- **Respondents:** ' + respondents.map(function(e){return e.name}).join(', ') + '\n';
    md += '- **Questions Answered:** ' + all.length + '\n';
    md += '- **Generated:** ' + dateStr + '\n\n';
    md += '## Answers by Category\n\n';
    var catKeys = Object.keys(categoryMeta);
    for (var fci = 0; fci < catKeys.length; fci++) {
      var cat = catKeys[fci];
      var catAnswers = byCategory[cat];
      var meta = categoryMeta[cat];
      if (!catAnswers || catAnswers.length === 0) continue;
      md += '### ' + meta.title + '\n\n';
      md += '*Confidence: ' + confidenceLevel(catAnswers) + '*\n\n';
      for (var fq = 0; fq < catAnswers.length; fq++) {
        var q = catAnswers[fq];
        md += '**' + q.q + '** (QID: ' + q.qid + ')\n\n';
        for (var fa = 0; fa < q.answers.length; fa++) {
          md += '- **' + q.answers[fa].name + ':** ' + q.answers[fa].a + '\n';
        }
        md += '\n';
      }
    }
    md += '---\n';
    md += '*Fallback document — no AI synthesis was performed.*\n';
  }

  // ---- Build AI-synthesized OKF Bundle ----
  // The AI-produced md is used as the primary content. We also build a structured
  // OKF bundle where concept files contain the AI-synthesized category insights.

  // First, ask the model to produce per-category summaries for the bundle files.
  var bundlePrompt = 'Based on the same expert answers below, produce a structured JSON output with per-category summaries.';
  bundlePrompt += ' The JSON must have this exact structure:\n';
  bundlePrompt += '{\n';
  bundlePrompt += '  "category_summaries": {\n';
  bundlePrompt += '    "scope": {"summary": "...", "consensus": ["..."], "divergence": ["..."], "takeaways": ["..."]},\n';
  bundlePrompt += '    "persona": {...},\n';
  bundlePrompt += '    ... only categories that have answers ...\n';
  bundlePrompt += '  },\n';
  bundlePrompt += '  "index_summary": "2-3 sentence bundle overview",\n';
  bundlePrompt += '  "log_notes": "1-2 sentences on what was captured"\n';
  bundlePrompt += '}\n\n';
  bundlePrompt += 'Expert answers:\n' + answerBlocks;
  bundlePrompt += '\n\nOutput ONLY the JSON object. No markdown fences, no commentary.';

  var bundleJson = null;
  if (apiKey) {
    try {
      var bundleResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'HTTP-Referer': 'https://chop-mvp.nousresearch.com',
          'X-Title': 'Chop MVP'
        },
        body: JSON.stringify({
          model: 'openai/gpt-4o',
          messages: [
            {role: 'system', content: 'You produce structured JSON summaries from expert answers. Output ONLY valid JSON.'},
            {role: 'user', content: bundlePrompt}
          ],
          temperature: 0.5,
          max_tokens: 3000
        })
      });

      if (bundleResp.ok) {
        var bundleData = await bundleResp.json();
        var bundleContent = bundleData.choices && bundleData.choices[0] && bundleData.choices[0].message && bundleData.choices[0].message.content;
        if (bundleContent) {
          bundleContent = bundleContent.trim();
          if (bundleContent.startsWith('```json')) bundleContent = bundleContent.slice(7);
          else if (bundleContent.startsWith('```')) bundleContent = bundleContent.slice(3);
          if (bundleContent.endsWith('```')) bundleContent = bundleContent.slice(0, -3);
          bundleContent = bundleContent.trim();
          bundleJson = JSON.parse(bundleContent);
        }
      } else {
        console.error('synthesize: Bundle API returned ' + bundleResp.status, await bundleResp.text());
      }
    } catch (e) {
      console.error('synthesize: Exception fetching bundle summaries', e.message);
    }
  }

  // Build the bundle object
  var bundle = {};
  var catKeys = Object.keys(categoryMeta);

  // Helper to create concept file content using AI summaries if available
  function buildCategoryContent(cat, meta, catAnswers, bundleJson) {
    var body = buildConceptFrontmatter('Concept', meta.title + ' — ' + p.name, meta.description, ['chop', 'knowledge-capture', cat]);
    body += '\n# ' + meta.title + '\n\n';
    body += meta.description + '\n\n';
    body += 'Part of the **[Knowledge Bundle](./index.md)** for *' + p.name + '*.\n\n';
    body += '**Confidence:** ' + confidenceLevel(catAnswers || []) + '\n\n';

    if (bundleJson && bundleJson.category_summaries && bundleJson.category_summaries[cat]) {
      var cs = bundleJson.category_summaries[cat];
      if (cs.summary) {
        body += '## Summary\n\n' + cs.summary + '\n\n';
      }
      if (cs.consensus && cs.consensus.length > 0) {
        body += '## Consensus\n\n';
        for (var ci2 = 0; ci2 < cs.consensus.length; ci2++) {
          body += '- ' + cs.consensus[ci2] + '\n';
        }
        body += '\n';
      }
      if (cs.divergence && cs.divergence.length > 0) {
        body += '## Divergence\n\n';
        for (var di = 0; di < cs.divergence.length; di++) {
          body += '- ' + cs.divergence[di] + '\n';
        }
        body += '\n';
      }
      if (cs.takeaways && cs.takeaways.length > 0) {
        body += '## Takeaways\n\n';
        for (var ti = 0; ti < cs.takeaways.length; ti++) {
          body += '- ' + cs.takeaways[ti] + '\n';
        }
        body += '\n';
      }
    } else {
      body += '## Answers\n\n';
      if (!catAnswers || catAnswers.length === 0) {
        body += '*No answers recorded for this category.*\n';
      } else {
        for (var ca = 0; ca < catAnswers.length; ca++) {
          var q = catAnswers[ca];
          body += '### ' + q.q + '\n\n';
          body += '> **Question ID:** ' + q.qid + '\n\n';
          for (var aii = 0; aii < q.answers.length; aii++) {
            body += '<details>\n<summary><strong>' + escHtml(q.answers[aii].name) + '</strong> answered:</summary>\n\n';
            body += q.answers[aii].a + '\n\n';
            body += '</details>\n\n';
          }
          body += '---\n\n';
        }
      }
    }

    // Cross-link to other categories
    body += '## Related\n\n';
    body += '- [Back to Bundle Index](./index.md)\n';
    for (var cl = 0; cl < catKeys.length; cl++) {
      if (catKeys[cl] !== cat && byCategory[catKeys[cl]]) {
        body += '- [' + categoryMeta[catKeys[cl]].title + '](./' + catKeys[cl] + '.md)\n';
      }
    }
    var respondentLinks = '';
    for (var rl = 0; rl < respondents.length; rl++) {
      respondentLinks += '- ' + respondents[rl].name + '\n';
    }
    if (respondentLinks) {
      body += '\n## Contributors\n\n' + respondentLinks;
    }
    return body;
  }

  // Build concept files
  for (var ck = 0; ck < catKeys.length; ck++) {
    var cat = catKeys[ck];
    var catAnswers = byCategory[cat];
    var meta = categoryMeta[cat];
    var fileName = cat + '.md';
    bundle[fileName] = buildCategoryContent(cat, meta, catAnswers, bundleJson);
  }

  // Build index.md
  var indexSummary = '';
  if (bundleJson && bundleJson.index_summary) {
    indexSummary = bundleJson.index_summary;
  }
  var indexBody = '---\n';
  indexBody += 'type: KnowledgeBundle\n';
  indexBody += 'title: ' + escYaml(p.name) + '\n';
  indexBody += 'description: "Chop-captured knowledge generated from expert interviews about: ' + escYaml(p.seed) + '"\n';
  indexBody += 'tags: [chop, knowledge-capture, bundle]\n';
  indexBody += 'timestamp: ' + timestamp + '\n';
  indexBody += 'okf_version: "0.2"\n';
  indexBody += 'source: "' + escYaml(p.seed) + '"\n';
  indexBody += '---\n\n';
  indexBody += '# ' + p.name + '\n\n';
  indexBody += 'Captured on ' + dateStr + ' via **Chop** — an interview-loop knowledge capture tool.\n\n';
  if (indexSummary) {
    indexBody += indexSummary + '\n\n';
  }
  indexBody += '## Metadata\n\n';
  indexBody += '- **Seed:** ' + p.seed + '\n';
  indexBody += '- **Respondents:** ' + respondents.map(function(e){return e.name}).join(', ') + '\n';
  indexBody += '- **Questions Answered:** ' + all.length + '\n';
  indexBody += '- **Categories:** ' + Object.keys(byCategory).length + '\n\n';
  indexBody += '## Concepts\n\n';
  for (var ic = 0; ic < catKeys.length; ic++) {
    var icat = catKeys[ic];
    var imeta = categoryMeta[icat];
    var icount = (byCategory[icat] || []).length;
    indexBody += '- [' + imeta.title + '](' + icat + '.md) — ' + imeta.description;
    if (icount > 0) indexBody += ' (' + icount + ' question' + (icount > 1 ? 's' : '') + ')';
    indexBody += '\n';
  }
  indexBody += '\n## Contributors\n\n';
  for (var ic2 = 0; ic2 < respondents.length; ic2++) {
    indexBody += '- ' + respondents[ic2].name + '\n';
  }
  bundle['index.md'] = indexBody;

  // Build log.md
  var logNotes = '';
  if (bundleJson && bundleJson.log_notes) {
    logNotes = bundleJson.log_notes;
  }
  var logBody = '---\n';
  logBody += 'type: Log\n';
  logBody += 'title: Capture Log — ' + p.name + '\n';
  logBody += 'tags: [chop, log]\n';
  logBody += 'timestamp: ' + timestamp + '\n';
  logBody += '---\n\n';
  logBody += '# Capture Log\n\n';
  logBody += '## ' + dateStr + '\n';
  logBody += '* **Creation:** Bundle created from Chop capture session.\n';
  logBody += '* **Seed:** "' + p.seed + '"\n';
  logBody += '* **Respondents:** ' + respondents.length + ' expert' + (respondents.length !== 1 ? 's' : '') + ' contributed.\n';
  logBody += '* **Total answers:** ' + all.length + '\n';
  if (logNotes) {
    logBody += '* **Notes:** ' + logNotes + '\n';
  }
  for (var lc = 0; lc < respondents.length; lc++) {
    logBody += '* **' + respondents[lc].name + '** completed ' + respondents[lc].answered + ' question' + (respondents[lc].answered !== 1 ? 's' : '') + '.\n';
  }
  bundle['log.md'] = logBody;

  await sbQuery(env, 'chop_projects?id=eq.' + pid, {method:'PATCH', body:{status:'synthesized'}});
  return json({markdown:md, bundle:bundle});
}

// Helpers
function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function json(d, s) { return new Response(JSON.stringify(d), {status:s||200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}}); }

// Supabase REST API helpers
function sbUrl(env) { return env.SUPABASE_URL; }
function sbKey(env) { return env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY; }
function sbAnonKey(env) { return env.SUPABASE_ANON_KEY; }

async function sbQuery(env, path, opts) {
  var url = env.SUPABASE_URL + '/rest/v1/' + path;
  var headers = {
    'apikey': sbKey(env),
    'Authorization': 'Bearer ' + sbKey(env),
    'Content-Type': 'application/json',
    'Prefer': opts && opts.prefer ? opts.prefer : 'return=representation'
  };
  if (opts && opts.accept) headers['Accept'] = opts.accept;
  var req = {method: opts && opts.method ? opts.method : 'GET', headers: headers};
  if (opts && opts.body) req.body = JSON.stringify(opts.body);
  var res = await fetch(url, req);
  if (!res.ok) {
    var txt = await res.text();
    console.error('Supabase error', res.status, path, txt.slice(0,200));
    return null;
  }
  if (opts && opts.noParse) return res;
  if (res.status === 204 || !res.headers.get('content-type')) return null;
  return await res.json();
}

async function sbAuth(env, path, body) {
  var res = await fetch(env.SUPABASE_URL + '/auth/v1/' + path, {
    method: 'POST',
    headers: {'apikey': sbAnonKey(env), 'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });
  return {ok: res.ok, status: res.status, data: await res.json()};
}

function jwtUserId(token) {
  try {
    var parts = token.split('.');
    if (parts.length !== 3) return null;
    var payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
    return payload.sub || null;
  } catch(e) { return null; }
}

function getAuthToken(req) {
  var auth = req.headers.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  var cookie = req.headers.get('Cookie') || '';
  var m = cookie.match(/chop_token=([^;]+)/);
  return m ? m[1] : null;
}

// Auth handlers
async function handleSignup(req, env) {
  var body = await req.json();
  var r = await sbAuth(env, 'signup', {email: body.email, password: body.password});
  if (!r.ok) return json({error: (r.data && (r.data.msg || r.data.error_description)) || 'Signup failed'}, 400);
  return json({
    user: r.data.user,
    session: r.data.session ? {access_token: r.data.session.access_token, expires_in: r.data.session.expires_in} : null
  });
}

async function handleLogin(req, env) {
  var body = await req.json();
  var r = await sbAuth(env, 'token?grant_type=password', {email: body.email, password: body.password});
  if (!r.ok) return json({error: (r.data && (r.data.msg || r.data.error_description)) || 'Login failed'}, 401);
  return json({user: r.data.user, access_token: r.data.access_token, expires_in: r.data.expires_in});
}

async function handleLogout(req, env) {
  return json({ok: true});
}

async function handleMe(req, env) {
  var token = getAuthToken(req);
  if (!token) return json({user: null});
  var uid = jwtUserId(token);
  if (!uid) return json({user: null});
  var r = await sbAuth(env, 'user', {});
  if (!r.ok) return json({user: null});
  return json({user: {id: uid, email: r.data && r.data.email}});
}

function getUserId(req, env) {
  var token = getAuthToken(req);
  return token ? jwtUserId(token) : null;
}

// Fetches the OpenRouter API key from Supabase chop_config table
// This avoids storing secrets as Worker env vars — just update the DB.
async function fetchOpenRouterKey(env) {
  try {
    var resp = await fetch(env.SUPABASE_URL + '/rest/v1/chop_config?key=eq.openrouter_api_key&select=value', {
      headers: {
        'apikey': env.SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + env.SUPABASE_ANON_KEY
      }
    });
    if (!resp.ok) {
      console.error('fetchOpenRouterKey: HTTP ' + resp.status);
      return null;
    }
    var data = await resp.json();
    if (data && data.length > 0 && data[0].value) {
      return data[0].value;
    }
    console.error('fetchOpenRouterKey: No config row found');
    return null;
  } catch(e) {
    console.error('fetchOpenRouterKey: Error', e);
    return null;
  }
}

// In-memory store (no KV dependency) -- looks like a KV namespace
// Also logs events to BigQuery queue_master_payloads table
var store = {
  _data: {},
  async get(key) { return this._data[key] || null; },
  async put(key, val) { this._data[key] = val; }
};

// Replace store with `store` -- the router still receives `env` for other uses
// Routes
export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var path = url.pathname;
    var method = request.method;
    if (method === 'OPTIONS') return new Response(null, {status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT','Access-Control-Allow-Headers':'Content-Type,X-Owner-Token,Authorization'}});

    // Auth - keep existing auth API routes
    if (path === '/auth/signup' && method === 'POST') return handleSignup(request, env);
    if (path === '/auth/login' && method === 'POST') return handleLogin(request, env);
    if (path === '/auth/logout' && method === 'POST') return handleLogout(request, env);
    if (path === '/auth/me' && method === 'GET') return handleMe(request, env);

    // Auth UI routes (before project routes so they match first)
    if (path === '/login' && method === 'GET') return loginPage(request, env);
    if (path === '/login/login' && method === 'POST') return loginPost(request, env);
    if (path === '/login/signup' && method === 'POST') return signupPost(request, env);

    // API - list user projects (needs auth)
    if (path === '/api/projects' && method === 'GET') return listUserProjects(request, env);
    if (path === '/api/projects' && method === 'POST') return createProject(request, env);
    if (path === '/api/admin/events') return getEvents(request, env);

    var m = path.match(/^\/api\/projects\/([^/]+)$/);
    if (m && method === 'GET') return getProject(request, env, m[1]);

    m = path.match(/^\/api\/projects\/([^/]+)\/experts$/);
    if (m && method === 'POST') return addExpert(request, env, m[1]);
    if (m && method === 'GET') return listExperts(request, env, m[1]);

    m = path.match(/^\/api\/projects\/([^/]+)\/synthesize$/);
    if (m && method === 'POST') return synthesize(request, env, m[1]);

    m = path.match(/^\/api\/answer\/([^/]+)\/questions$/);
    if (m && method === 'GET') return expertQuestions(request, env, m[1]);

    m = path.match(/^\/api\/answer\/([^/]+)\/submit$/);
    if (m && method === 'POST') return submitAnswer(request, env, m[1]);

    if (path === '/admin') return adminPage(request, env);

    m = path.match(/^\/project\/([^/]+)$/);
    if (m) return projectDetailPage(request, env, m[1]);

    m = path.match(/^\/answer\/([^/]+)$/);
    if (m) return answerPage(request, env, m[1]);

    return homePage(request, env);
  }
};