// Chop MVP -- one Worker, in-memory store (no KV), no build step
// When the flow is validated, this entire codebase is disposable.
// Data lives in memory -- survives warm Workers, lost on cold start.
// That's fine for a playtest with a few people for a few hours.

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function t(n) { let s='';for(let i=n||8;i>0;i--)s+=B62[Math.random()*62|0];return s; }

// Static questions for MVP -- AI generation deferred
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

// Routes
async function homePage(req, env) {
  return new Response(shell(
    '<div class="flex-between"><div><div class="logo">\u{1FA97}</div><h1>Chop</h1><div class="sub">Not a chatbot. An interview loop.</div></div><div><a href="/admin" class="btn btn-secondary btn-sm" style="text-decoration:none">Admin</a></div></div>'+
    '<div class="card" id="new-project-card">'+
      '<label>What do you want to capture?</label>'+
      '<textarea id="seed" placeholder="e.g. We need to document how our data pipeline works..."></textarea>'+
      '<div style="display:flex;gap:8px;align-items:center"><button class="btn" onclick="startProject()">Generate Questions</button><span style="color:#666;font-size:0.8rem" id="status-msg"></span></div>'+
    '</div>'+
    '<div id="project-area" style="display:none"></div>',
    'Chop - Capture Knowledge',
    'var cp=null;var ct="";'+
    '(function(){var s=sessionStorage.getItem("chop_ot");if(s)ct=s})();'+
    'async function startProject(){var s=document.getElementById("seed").value.trim();if(!s){showToast("Enter a topic first");return}'+
    'var b=document.querySelector("#new-project-card .btn");b.disabled=true;b.textContent="Generating...";'+
    'try{var r=await fetch("/api/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({seed:s})});var d=await r.json();if(!r.ok)throw new Error(d.error||"Failed");'+
    'sessionStorage.setItem("chop_ot",d.owner_token);sessionStorage.setItem("chop_pid",d.id);cp=d;showProject(d)}catch(e){showToast("Error: "+e.message)}'+
    'b.disabled=false;b.textContent="Generate Questions"}'+
    'function showProject(p){'+
    'document.getElementById("new-project-card").style.display="none";var a=document.getElementById("project-area");a.style.display="block";'+
    'var qh="";for(var i=0;i<p.questions.length;i++){var q=p.questions[i];'+
    'qh+=\'<div style="padding:8px 0;border-bottom:1px solid #2a2a2a;display:flex;align-items:flex-start;gap:8px"><input type="checkbox" checked id="q-\'+i+\'" style="width:auto;margin-top:4px">\'+' +
    '\'<div><span class="q-badge">\'+q.qid+\'</span> <span class="tag \'+q.category+\'">\'+q.category+\'</span><div style="margin-top:4px;color:#ccc;font-size:0.9rem">\'+q.text+\'</div></div></div>\''+
    '}'+
    'a.innerHTML=\'<div class="flex-between" style="margin-bottom:16px"><div><h2>\'+p.name+\'</h2><div class="sub" style="margin-bottom:0">\'+p.seed.slice(0,100)+\'...</div></div><span class="tag">\'+p.status+\'</span></div>\'+\'<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><label style="margin-bottom:0;font-size:1rem">Questions (\'+p.questions.length+\')</label></div><div id="q-list">\'+qh+\'</div></div>\'+\'<div class="card"><label style="font-size:1rem">Add Experts</label><div style="margin-bottom:12px"><div class="expert-input-row"><input id="expert-name" placeholder="Name (e.g. Alice - Data Eng)" style="margin-bottom:0"><input id="expert-email" placeholder="Email (optional)" style="margin-bottom:0"><button class="btn btn-sm" onclick="addExpert()">+ Add</button></div></div><div id="expert-list"></div><div id="expert-links" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid #333"></div><div id="progress-area" style="margin-top:12px;display:none"></div><div style="margin-top:12px"><button class="btn" id="synthesize-btn" style="display:none" onclick="triggerSynth()">Synthesize Now</button></div></div>\'+\'<div id="synthesis-output" style="display:none"></div>\';'+
    'refreshExperts()}'+
    'async function addExpert(){var n=document.getElementById("expert-name").value.trim();if(!n){showToast("Enter a name");return}'+
    'var e=document.getElementById("expert-email").value.trim();var pid=sessionStorage.getItem("chop_pid");var tok=sessionStorage.getItem("chop_ot");'+
    'var r=await fetch("/api/projects/"+pid+"/experts",{method:"POST",headers:{"Content-Type":"application/json","X-Owner-Token":tok},body:JSON.stringify({name:n,email:e})});'+
    'var d=await r.json();if(!r.ok){showToast(d.error||"Failed");return}'+
    'document.getElementById("expert-name").value="";document.getElementById("expert-email").value="";refreshExperts()}'+
    'async function refreshExperts(){var pid=sessionStorage.getItem("chop_pid");var tok=sessionStorage.getItem("chop_ot");'+
    'var r=await fetch("/api/projects/"+pid+"/experts",{headers:{"X-Owner-Token":tok}});var d=await r.json();if(!r.ok)return;'+
    'var el=document.getElementById("expert-list");var ll=document.getElementById("expert-links");var pa=document.getElementById("progress-area");var sb=document.getElementById("synthesize-btn");'+
    'if(!d.experts||d.experts.length===0){el.innerHTML=\'<div style="color:#666;font-size:0.85rem">Add experts who have the knowledge you want to capture.</div>\';ll.style.display="none";pa.style.display="none";sb.style.display="none";return}'+
    'el.innerHTML=d.experts.map(function(e){var sc="pending",st="Pending";if(e.status==="sent"){sc="pending";st="Sent"}if(e.status==="in_progress"){sc="in-progress";st="In Progress"}if(e.status==="completed"){sc="done";st="Done"}'+
    'return\'<div class="expert-card"><div><div class="name">\'+e.name+\'</div><div style="font-size:0.75rem;color:#666;margin-top:2px">\'+(e.answered||0)+\'/\'+(e.total_questions||\'?\')+\' answered</div></div>\'+\'<div style="display:flex;align-items:center;gap:8px"><span class="status \'+sc+\'">\'+st+\'</span></div></div>\'}).join("");'+
    'll.style.display="block";ll.innerHTML=\'<label>Share Links</label>\';'+
    'd.experts.forEach(function(e){ll.innerHTML+=\'<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:0.85rem"><span style="min-width:120px">\'+e.name+\'</span><code class="inline-code" style="flex:1">\'+window.location.origin+\'/answer/\'+e.token+\'</code></div>\'});'+
    'var tot=d.experts.length;var done=d.experts.filter(function(e){return e.status==="completed"}).length;'+
    'pa.style.display="block";pa.innerHTML=\'<div style="margin-top:8px;padding-top:12px;border-top:1px solid #333"><div class="progress"><span>People: \'+tot+\'</span><span>Done: \'+done+\'</span></div></div>\';'+
    'var hasAns=d.experts.some(function(e){return parseInt(e.answered||0)>0});sb.style.display=hasAns?"inline-flex":"none"}'+
    'async function triggerSynth(){var pid=sessionStorage.getItem("chop_pid");var tok=sessionStorage.getItem("chop_ot");var b=document.getElementById("synthesize-btn");b.disabled=true;b.textContent="Synthesizing...";'+
    'try{var r=await fetch("/api/projects/"+pid+"/synthesize",{method:"POST",headers:{"Content-Type":"application/json","X-Owner-Token":tok}});var d=await r.json();if(!r.ok)throw new Error(d.error||"Failed");'+
    'var o=document.getElementById("synthesis-output");o.style.display="block";o.innerHTML=\'<div class="card"><h3>Output</h3><pre id="md-out">\'+escHtml(d.markdown)+\'</pre><div style="margin-top:12px"><button class="btn btn-sm" onclick="copyMd()">Copy</button></div></div>\';showToast("Synthesis complete!")}catch(e){showToast("Error: "+e.message)}'+
    'b.disabled=false;b.textContent="Synthesize Now"}'+
    'function copyMd(){var p=document.getElementById("md-out");navigator.clipboard.writeText(p.textContent).then(function(){showToast("Copied!")})}'+
    'function escHtml(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}'
  ), {headers:{'Content-Type':'text/html'}});
}

async function answerPage(req, env, token) {
  var expertStr = await store.get('expert:' + token);
  if (!expertStr) {
    return new Response(shell(
      '<div style="text-align:center;padding:60px 0"><div class="logo" style="font-size:3rem">\u{1FA97}</div><h1>Link not found</h1><p style="color:#888;margin:16px 0">This answer link doesn\'t exist or has expired.</p><a href="/" class="btn">Start your own project</a></div>',
      'Chop - Link not found'
    ), {headers:{'Content-Type':'text/html'}});
  }
  var expert = JSON.parse(expertStr);
  var pStr = await store.get('project:' + expert.project_id);
  if (!pStr) return new Response('Not found', {status:404});
  var project = JSON.parse(pStr);

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
  var listStr = await store.get('projects_list');
  var ids = listStr ? JSON.parse(listStr) : [];
  var evStr = await store.get('admin_events');
  var evs = evStr ? JSON.parse(evStr) : [];

  var pHtml = '';
  for (var i = 0; i < ids.length; i++) {
    var pStr = await store.get('project:' + ids[i]);
    if (!pStr) continue;
    var p = JSON.parse(pStr);
    var eStr = await store.get('project_experts:' + ids[i]);
    var exps = eStr ? JSON.parse(eStr) : [];
    var rows = '';
    for (var j = 0; j < exps.length; j++) {
      var e = exps[j];
      rows += '<tr><td>'+escHtml(e.name)+'</td><td>'+(e.email||'-')+'</td><td>'+e.status+'</td><td>'+(e.answered||0)+'/'+(e.total_questions||'?')+'</td></tr>';
    }
    pHtml += '<div class="card" style="margin-bottom:16px">'+
      '<div class="flex-between" style="margin-bottom:8px"><div><strong>'+escHtml(p.name)+'</strong> <span class="tag">'+p.status+'</span></div><span style="color:#666;font-size:0.8rem">'+(p.created_at||'')+'</span></div>'+
      '<div style="font-size:0.85rem;color:#888;margin-bottom:8px">'+escHtml(p.seed.slice(0,150))+'</div>'+
      (exps.length > 0 ? '<table class="admin-table"><tr><th>Expert</th><th>Email</th><th>Status</th><th>Progress</th></tr>'+rows+'</table>' : '<span style="color:#666;font-size:0.8rem">No experts added</span>')+
      '<div style="margin-top:8px;font-size:0.8rem;color:#666">Questions: '+(p.questions||[]).length+' | Experts: '+exps.length+'</div></div>';
  }

  var evHtml = '';
  for (var k = Math.max(0, evs.length - 50); k < evs.length; k++) {
    var ev = evs[k];
    var pp = typeof ev.payload === 'string' ? ev.payload : JSON.stringify(ev.payload || {});
    evHtml += '<tr><td style="white-space:nowrap">'+ev.ts+'</td><td><span class="tag">'+ev.type+'</span></td><td><code class="inline-code">'+escHtml(pp.slice(0,120))+'</code></td></tr>';
  }

  return new Response(shell(
    '<div class="flex-between" style="margin-bottom:16px"><div><div class="logo" style="font-size:1.5rem">\u{1FA97}</div><h1>Admin</h1><div class="sub">Observe user behavior</div></div><div><a href="/" class="btn btn-secondary btn-sm" style="text-decoration:none">Home</a></div></div>'+
    '<div class="card"><h3>Projects ('+ids.length+')</h3>'+(ids.length === 0 ? '<div style="color:#666;padding:20px 0;text-align:center">No projects yet</div>' : pHtml)+'</div>'+
    '<div class="card"><div class="flex-between" style="margin-bottom:12px"><h3>Event Log (last 50)</h3><div style="font-size:0.8rem;color:#666">Total: '+evs.length+'</div></div>'+
    '<table class="admin-table"><tr><th>Time</th><th>Type</th><th>Payload</th></tr><tbody id="events-body">'+(evHtml || '<tr><td colspan="3" style="color:#666;text-align:center;padding:20px">No events yet</td></tr>')+'</tbody></table></div>',
    'Chop Admin',
    'setInterval(async function(){var r=await fetch("/api/admin/events");var d=await r.json();var tb=document.getElementById("events-body");if(!tb)return;'+
    'tb.innerHTML=d.events.slice(-50).reverse().map(function(e){var p=typeof e.payload==="string"?e.payload:JSON.stringify(e.payload||{});return"<tr><td>"+e.ts+'+
    '"</td><td><span class=\\"tag\\">"+e.type+"</span></td><td><code class=\\"inline-code\\">"+p.slice(0,120)+"</code></td></tr>"}).join("")},5000)'
  ), {headers:{'Content-Type':'text/html'}});
}

// API
async function createProject(req, env) {
  var body = await req.json();
  if (!body.seed || body.seed.length < 5) return json({error:'Seed too short'}, 400);
  var id = t(12), ot = t(8), name = body.seed.split('.')[0].slice(0,40).trim() || 'Untitled';
  var project = {id, owner_token:ot, name, seed:body.seed, questions:DEFAULT_QUESTIONS, status:'questions_generated', created_at:new Date().toISOString()};
  await store.put('project:'+id, JSON.stringify(project));
  await store.put('owner:'+ot+':project', id);
  var list = JSON.parse(await store.get('projects_list') || '[]');
  list.push(id); await store.put('projects_list', JSON.stringify(list));
  logEvent(env, 'project_created', {id, name, qs:DEFAULT_QUESTIONS.length});
  return json({...project});
}

async function addExpert(req, env, pid) {
  var ot = req.headers.get('X-Owner-Token');
  var pStr = await store.get('project:'+pid);
  if (!pStr) return json({error:'Not found'}, 404);
  var p = JSON.parse(pStr);
  if (p.owner_token !== ot) return json({error:'Unauthorized'}, 403);
  var body = await req.json();
  if (!body.name) return json({error:'Name required'}, 400);
  var et = t(8), ei = t(6);
  var experts = JSON.parse(await store.get('project_experts:'+pid) || '[]');
  var expert = {id:ei, name:body.name, email:body.email||'', token:et, status:'pending', answered:0, total_questions:DEFAULT_QUESTIONS.length, project_id:pid};
  experts.push(expert);
  await store.put('project_experts:'+pid, JSON.stringify(experts));
  await store.put('expert:'+et, JSON.stringify(expert));
  logEvent(env, 'expert_added', {pid, name:body.name});
  return json({expert});
}

async function listExperts(req, env, pid) {
  var ot = req.headers.get('X-Owner-Token');
  var pStr = await store.get('project:'+pid);
  if (!pStr) return json({error:'Not found'}, 404);
  var p = JSON.parse(pStr);
  if (p.owner_token !== ot) return json({error:'Unauthorized'}, 403);
  var experts = JSON.parse(await store.get('project_experts:'+pid) || '[]');
  return json({experts: experts.map(function(e){return {...e, link:'/answer/'+e.token}})});
}

async function getProject(req, env, pid) {
  var pStr = await store.get('project:'+pid);
  if (!pStr) return json({error:'Not found'}, 404);
  var p = JSON.parse(pStr);
  var experts = JSON.parse(await store.get('project_experts:'+pid) || '[]');
  return json({...p, experts});
}

async function expertQuestions(req, env, token) {
  var eStr = await store.get('expert:'+token);
  if (!eStr) return json({error:'Not found'}, 404);
  var expert = JSON.parse(eStr);
  if (expert.status === 'pending' || expert.status === 'sent') {
    expert.status = 'in_progress';
    await store.put('expert:'+token, JSON.stringify(expert));
    updateExpert(env, expert.project_id, expert.id, {status:'in_progress'});
    logEvent(env, 'expert_started', {pid:expert.project_id, name:expert.name});
  }
  var ak = 'assignments:'+expert.project_id+':'+token;
  var aStr = await store.get(ak);
  var as = aStr ? JSON.parse(aStr) : DEFAULT_QUESTIONS.map(function(q,i){return {idx:i, qid:q.qid, category:q.category, text:q.text, answered:false, skipped:false, answer:null}});
  if (!aStr) await store.put(ak, JSON.stringify(as));
  var ci = as.findIndex(function(a){return !a.answered && !a.skipped});
  return json({assignments:as, current_index:ci >= 0 ? ci : as.length});
}

async function submitAnswer(req, env, token) {
  var body = await req.json();
  var eStr = await store.get('expert:'+token);
  if (!eStr) return json({error:'Not found'}, 404);
  var expert = JSON.parse(eStr);
  var ak = 'assignments:'+expert.project_id+':'+token;
  var aStr = await store.get(ak);
  if (!aStr) return json({error:'No assignments'}, 400);
  var as = JSON.parse(aStr);
  var idx = body.idx;
  if (idx < 0 || idx >= as.length) return json({error:'Invalid index'}, 400);
  as[idx].answered = !body.skip;
  as[idx].skipped = !!body.skip;
  as[idx].answer = body.skip ? null : (body.text || '');
  as[idx].answered_at = new Date().toISOString();
  await store.put(ak, JSON.stringify(as));
  var answered = as.filter(function(a){return a.answered}).length;
  var skipped = as.filter(function(a){return a.skipped}).length;
  var remaining = as.length - answered - skipped;
  expert.answered = answered;
  if (remaining === 0) {
    expert.status = 'completed';
    updateExpert(env, expert.project_id, expert.id, {status:'completed', answered});
    logEvent(env, 'expert_completed', {pid:expert.project_id, name:expert.name, answered, skipped});
  } else {
    updateExpert(env, expert.project_id, expert.id, {answered});
  }
  await store.put('expert:'+token, JSON.stringify(expert));
  logEvent(env, body.skip ? 'answer_skipped' : 'answer_submitted', {pid:expert.project_id, name:expert.name, q:as[idx].qid});
  var ci = as.findIndex(function(a){return !a.answered && !a.skipped});
  return json({assignments:as, current_index:ci >= 0 ? ci : as.length});
}

async function synthesize(req, env, pid) {
  var ot = req.headers.get('X-Owner-Token');
  var pStr = await store.get('project:'+pid);
  if (!pStr) return json({error:'Not found'}, 404);
  var p = JSON.parse(pStr);
  if (p.owner_token !== ot) return json({error:'Unauthorized'}, 403);
  var experts = JSON.parse(await store.get('project_experts:'+pid) || '[]');
  var all = [];
  for (var i = 0; i < experts.length; i++) {
    var ak = 'assignments:'+pid+':'+experts[i].token;
    var aStr = await store.get(ak);
    if (!aStr) continue;
    var as = JSON.parse(aStr);
    for (var j = 0; j < as.length; j++) {
      if (as[j].answered && as[j].answer) {
        all.push({name:experts[i].name, qid:as[j].qid, q:as[j].text, a:as[j].answer});
      }
    }
  }
  var byQ = {};
  for (var k = 0; k < all.length; k++) {
    if (!byQ[all[k].qid]) byQ[all[k].qid] = {qid:all[k].qid, q:all[k].q, answers:[]};
    byQ[all[k].qid].answers.push({name:all[k].name, a:all[k].a});
  }
  var groups = Object.values(byQ);
  var now = new Date().toISOString().slice(0,10);
  var md = '# ' + p.name + ' - Context Summary\n';
  md += '#version v1\n#generated ' + now + '\n\n';
  md += '## Metadata\n';
  md += '- Seed: ' + p.seed + '\n';
  md += '- Respondents: ' + experts.filter(function(e){return e.answered > 0}).map(function(e){return e.name}).join(', ') + '\n';
  md += '- Questions Answered: ' + all.length + '\n';
  md += '- Status: MVP raw answers\n\n';
  md += '## Raw Answers by Question\n\n';
  for (var m = 0; m < groups.length; m++) {
    md += '---\n\n';
    md += '<respondent>\n  <question id="' + groups[m].qid + '">\n    <prompt>' + groups[m].q + '</prompt>\n';
    for (var n = 0; n < groups[m].answers.length; n++) {
      md += '    <answer expert="' + groups[m].answers[n].name + '">' + groups[m].answers[n].a + '</answer>\n';
    }
    md += '  </question>\n</respondent>\n\n';
  }
  md += '--- End of Document ---\n';
  p.status = 'synthesized';
  await store.put('project:'+pid, JSON.stringify(p));
  logEvent(env, 'synthesis_completed', {pid, respondents:experts.filter(function(e){return e.answered>0}).length, answers:all.length});
  return json({markdown:md});
}

async function getEvents(req, env) {
  var str = await store.get('admin_events');
  var evs = str ? JSON.parse(str) : [];
  return json({events:evs.slice(-100).reverse()});
}

// Helpers
async function updateExpert(env, pid, eid, updates) {
  var str = await store.get('project_experts:'+pid);
  if (!str) return;
  var arr = JSON.parse(str);
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].id === eid) { Object.assign(arr[i], updates); break; }
  }
  await store.put('project_experts:'+pid, JSON.stringify(arr));
}

async function logEvent(env, type, payload) {
  try {
    var str = await store.get('admin_events');
    var arr = str ? JSON.parse(str) : [];
    arr.push({ts:new Date().toISOString(), type, payload});
    if (arr.length > 500) arr.splice(0, arr.length - 500);
    await store.put('admin_events', JSON.stringify(arr));
  } catch(e) { console.error('log:', e); }
}

function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function json(d, s) { return new Response(JSON.stringify(d), {status:s||200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}}); }

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
    if (method === 'OPTIONS') return new Response(null, {status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT','Access-Control-Allow-Headers':'Content-Type,X-Owner-Token'}});

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

    m = path.match(/^\/answer\/([^/]+)$/);
    if (m) return answerPage(request, env, m[1]);

    return homePage(request, env);
  }
};