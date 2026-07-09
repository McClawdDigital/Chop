// Chop MVP -- one Worker, serves frontend + proxies REST + fires Edge Functions
// All AI work runs in Supabase Edge Functions (no 30s Worker CPU limit).
// Data lives in Supabase (chop_projects, chop_experts, chop_answers).

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function t(n) { let s='';for(let i=n||8;i>0;i--)s+=B62[Math.random()*62|0];return s; }

// HTML shell
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
      try {
        var r = await sbUser(token, env);
        if (r.ok) { var userData = await r.json(); user = {id: uid, email: userData && userData.email}; }
      } catch(e) { console.error('homePage: sbUser failed', e.message); }
    }
  }

  var body = '';

  if (user && user.email) {
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
      'return\'<div class="card project-card" style="cursor:pointer" onclick="window.location.href=\\\\\'/project/\'+p.id+\'\\\\\'">\' +' +
      '\'<div class="flex-between"><div><strong>\'+escHtml(p.name||"Untitled")+\'</strong><span class="tag" style="margin-left:8px">\'+escHtml(p.status||"draft")+\'</span></div>\' +' +
      '\'<span style="color:#666;font-size:0.8rem">\'+(p.created_at||"").slice(0,10)+\'</span></div>\' +' +
      '\'<div style="font-size:0.85rem;color:#888;margin-top:4px">\'+escHtml((p.seed||"").slice(0,100))+\'</div>\' +' +
      '\'<div style="font-size:0.8rem;color:#666;margin-top:8px">\'+qc+\' questions</div>\' +' +
      '\'</div>\'}).join("")' +
      '}' +
      'function showNewProject(){document.getElementById("new-project-card").style.display="block";document.getElementById("new-project-btn").style.display="none"}' +
      'async function startProject(){var s=document.getElementById("seed").value.trim();if(!s){showToast("Enter a topic first");return}' +
            'var b=document.querySelector("#new-project-card .btn");b.disabled=true;b.textContent="Generating...";document.getElementById("status-msg").textContent="Please wait...";' +
            'try{var r=await authFetch("/api/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({seed:s})});var d=await r.json();if(!r.ok)throw new Error(d.error||"Failed");window.location.href="/project/"+d.id}catch(e){document.getElementById("status-msg").textContent="Error: "+e.message+". Try again or use a simpler seed.";showToast("Error: "+e.message)}' +
            'b.disabled=false;b.textContent="Generate Questions"}' +
      'loadDashboard();';
    return new Response(shell(body, 'Chop - Dashboard', extra), {headers:{'Content-Type':'text/html'}});
  } else {
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
    'sessionStorage.setItem("chop_token",d.access_token);document.cookie="chop_token="+d.access_token+"; path=/; max-age=86400; SameSite=Lax";document.getElementById("login-form").style.display="none";document.getElementById("login-success").style.display="block";' +
    'setTimeout(function(){window.location.href="/"},1000)}catch(e){showToast("Error: "+e.message)}}' +
    'async function doSignup(){var e=document.getElementById("login-email").value.trim();var p=document.getElementById("login-password").value;if(!e||!p){showToast("Enter email and password");return}' +
    'try{var r=await fetch("/login/signup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:e,password:p})});var d=await r.json();' +
    'if(!r.ok){var er=document.getElementById("login-error");er.textContent=d.error||"Signup failed";er.style.display="block";return}' +
    'if(d.access_token){sessionStorage.setItem("chop_token",d.access_token);document.cookie="chop_token="+d.access_token+"; path=/; max-age=86400; SameSite=Lax"}' +
    'document.getElementById("login-form").style.display="none";document.getElementById("login-success").style.display="block";' +
    'setTimeout(function(){window.location.href="/"},1000)}catch(e){showToast("Error: "+e.message)}}'
  ), {headers:{'Content-Type':'text/html'}});
}

async function loginPost(req, env) {
  try {
    var body = await req.json();
    var r = await sbAuth(env, 'token?grant_type=password', {email: body.email, password: body.password});
    if (!r.ok) {
      var errMsg = (r.data && (r.data.msg || r.data.error_description)) || 'Login failed';
      return json({error: errMsg}, 401);
    }
    return json({user: r.data.user, access_token: r.data.access_token});
  } catch(e) {
    console.error('loginPost exception:', e.message, e.stack);
    return json({error: 'Internal error: ' + e.message}, 500);
  }
}

async function signupPost(req, env) {
  try {
    var body = await req.json();
    var r = await sbAuth(env, 'signup', {email: body.email, password: body.password});
    if (!r.ok) {
      var errMsg = (r.data && (r.data.msg || r.data.error_description)) || 'Signup failed';
      return json({error: errMsg}, 400);
    }
    var userId = r.data && (r.data.id || (r.data.user && r.data.user.id));
    if (userId) {
      try {
        await fetch(env.SUPABASE_URL + '/rest/v1/rpc/auto_confirm_user', {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({user_id: userId})
        });
      } catch (e) {
        console.error('signupPost: Auto-confirm failed', e.message);
      }
    }
    if (r.data && r.data.session && r.data.session.access_token) {
      return json({user: r.data.user, access_token: r.data.session.access_token});
    }
    var loginR = await sbAuth(env, 'token?grant_type=password', {email: body.email, password: body.password});
    if (loginR.ok && loginR.data && loginR.data.access_token) {
      return json({user: loginR.data.user, access_token: loginR.data.access_token});
    }
    return json({user: r.data.user, access_token: null});
  } catch(e) {
    console.error('signupPost exception:', e.message, e.stack);
    return json({error: 'Internal error: ' + e.message}, 500);
  }
}

async function projectDetailPage(req, env, pid) {
  var token = getAuthToken(req);
  var user = null;
  if (token) {
    var uid = jwtUserId(token);
    if (uid) {
      try {
        var r = await sbUser(token, env);
        if (r.ok) { var userData = await r.json(); user = {id: uid, email: userData && userData.email}; }
      } catch(e) { console.error('projectDetailPage: sbUser failed', e.message); }
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
    'var POLL_INTERVAL=null;' +
    'async function loadProject(){' +
    'try{var r=await authFetch("/api/projects/"+PID);var p=await r.json();if(!r.ok)throw new Error(p.error||"Not found");renderProject(p)}catch(e){' +
    'document.getElementById("project-loading").textContent="Error: "+e.message}}' +
    'function renderProject(p){' +
    'if(p.status==="generating"){' +
    'document.getElementById("project-area").innerHTML=\'<div class="card" style="text-align:center;padding:40px 0"><div style="font-size:2rem;margin-bottom:12px">&#9203;</div><h2>Generating questions...</h2><p style="color:#888;margin-top:8px">AI is analyzing your seed topic and crafting targeted questions. This usually takes 5-15 seconds.</p></div>\';' +
    'if(!POLL_INTERVAL){POLL_INTERVAL=setInterval(function(){loadProject()},3000)};return}' +
    'if(p.status==="synthesizing"){' +
    'document.getElementById("project-area").innerHTML=\'<div class="card" style="text-align:center;padding:40px 0"><div style="font-size:2rem;margin-bottom:12px">&#9203;</div><h2>Synthesizing answers...</h2><p style="color:#888;margin-top:8px">AI is analyzing expert answers and producing a knowledge document. This usually takes 10-30 seconds.</p></div>\';' +
    'if(!POLL_INTERVAL){POLL_INTERVAL=setInterval(function(){loadProject()},3000)};return}' +
    'if(POLL_INTERVAL){clearInterval(POLL_INTERVAL);POLL_INTERVAL=null}' +
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
    'async function triggerSynth(){var b=document.getElementById("synthesize-btn");b.disabled=true;b.textContent="Starting...";' +
    'try{var r=await authFetch("/api/projects/"+PID+"/synthesize",{method:"POST",headers:{"Content-Type":"application/json"}});var d=await r.json();if(!r.ok)throw new Error(d.error||"Failed");' +
    'if(d.status==="ok"){' +
    'b.textContent="Synthesizing in background...";' +
    'if(!POLL_INTERVAL){POLL_INTERVAL=setInterval(function(){checkSynthesis()},3000)};' +
    'loadProject()}' +
    '}catch(e){showToast("Error: "+e.message)}b.disabled=false}' +
    'async function checkSynthesis(){' +
    'try{var r=await authFetch("/api/projects/"+PID);var p=await r.json();if(!r.ok)return;' +
    'if(p.status==="synthesized"&&p.synthesis_result){' +
    'if(POLL_INTERVAL){clearInterval(POLL_INTERVAL);POLL_INTERVAL=null}' +
    'renderSynthesis(p.synthesis_result)}' +
    '}catch(e){}}' +
    'function renderSynthesis(sr){' +
    'var o=document.getElementById("synthesis-output");o.style.display="block";' +
    'var bundleHtml="";if(sr.bundle){var bkeys=Object.keys(sr.bundle);' +
    'bundleHtml=\'<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">\';' +
    'bundleHtml+=\'<button class="btn btn-sm" onclick="downloadBundle()">Download OKF Bundle (.zip)</button>\';' +
    'bundleHtml+=\'<button class="btn btn-sm btn-secondary" onclick="downloadFile(\'index.md\')">index.md</button>\';' +
    'bundleHtml+=\'<button class="btn btn-sm btn-secondary" onclick="downloadFile(\'log.md\')">log.md</button>\';' +
    'bkeys.forEach(function(f){if(f!==\'index.md\'&&f!==\'log.md\'){bundleHtml+=\'<button class="btn btn-sm btn-secondary" onclick="downloadFile(\'\'+f+\'\')">\'+f+\'</button>\'}});' +
    'bundleHtml+=\'</div>\';}' +
    'o.innerHTML=\'<div class="card"><h3>Output</h3><pre id="md-out">\'+escHtml(sr.markdown)+\'</pre><div style="margin-top:12px"><button class="btn btn-sm" onclick="copyMd()">Copy Markdown</button></div>\'+bundleHtml+\'</div>\';showToast("Synthesis complete!")}' +
    'function copyMd(){var p=document.getElementById("md-out");navigator.clipboard.writeText(p.textContent).then(function(){showToast("Copied!")})}' +
    'function downloadBundle(){' +
    'authFetch("/api/projects/"+PID+"/synthesize/download").then(function(r){return r.json()}).then(function(d){' +
    'if(!d.bundle){showToast("No bundle data");return}' +
    'var zip=new JSZip();var bkeys=Object.keys(d.bundle);' +
    'for(var i=0;i<bkeys.length;i++){zip.file(bkeys[i],d.bundle[bkeys[i]])}' +
    'zip.generateAsync({type:"blob"}).then(function(blob){' +
    'var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="okf-bundle-"+PID+".zip";a.click();' +
    'URL.revokeObjectURL(a.href);showToast("Bundle downloaded!")})})}' +
    'function downloadFile(fn){' +
    'authFetch("/api/projects/"+PID+"/synthesize/download").then(function(r){return r.json()}).then(function(d){' +
    'if(!d.bundle||!d.bundle[fn]){showToast("File not found");return}' +
    'var blob=new Blob([d.bundle[fn]],{type:"text/markdown"});var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=fn;a.click();URL.revokeObjectURL(a.href)})}' +
    'loadProject();'
  ), {headers:{'Content-Type':'text/html'}});
}

// List user's projects
async function listUserProjects(req, env) {
  var uid = getUserId(req, env);
  if (!uid) return json({error: 'Unauthorized', projects: []}, 401);
  var ut = getUserToken(req);
  var projects = await sbQuery(env, 'chop_projects?user_id=eq.' + uid + '&select=*&order=created_at.desc', {userToken: ut});
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

// ---- Project CRUD ----

async function createProject(req, env, ctx) {
  var body = await req.json();
  if (!body.seed || body.seed.length < 5) return json({error:'Seed too short'}, 400);
  var name = body.seed.split('.')[0].slice(0,40).trim() || 'Untitled';
  var uid = getUserId(req, env);
  var ut = getUserToken(req);
  if (!uid) return json({error:'Authentication required'}, 401);

  // Create the project instantly with status='generating', empty questions
  var result = await sbQuery(env, 'chop_projects', {
    method: 'POST',
    userToken: ut,
    body: {name: name, seed: body.seed, questions: [], status: 'generating', user_id: uid}
  });
  var project = result && result[0];
  if (!project) return json({error:'Failed to create project'}, 500);

  // Fire off the AI question generation via Edge Function
  ctx.waitUntil((async function() {
    try {
      var efUrl = (env.SUPABASE_URL || 'https://ofggjtkweqlkncgablbm.supabase.co').replace(/\/+$/, '') + '/functions/v1/generate-questions';
      var efResp = await fetch(efUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SUPABASE-URL': env.SUPABASE_URL,
          'X-SUPABASE-SERVICE-KEY': env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + (ut || env.SUPABASE_SERVICE_KEY)
        },
        body: JSON.stringify({project_id: project.id})
      });
      if (!efResp.ok) {
        var efErr = await efResp.text();
        console.error('Background AI question gen failed for project', project.id, efResp.status, efErr);
      } else {
        console.log('Background AI question gen completed for project', project.id);
      }
    } catch(e) {
      console.error('Background AI question gen error for project', project.id, e.message);
    }
  })());

  return json(project);
}

async function addExpert(req, env, pid) {
  var projects = await sbQuery(env, 'chop_projects?id=eq.' + pid + '&select=*');
  var p = projects && projects[0];
  if (!p) return json({error:'Not found'}, 404);
  var body = await req.json();
  if (!body.name) return json({error:'Name required'}, 400);
  var et = t(8);
  var ut = getUserToken(req);
  var result = await sbQuery(env, 'chop_experts', {
    method: 'POST',
    userToken: ut,
    body: {project_id: pid, name: body.name, email: body.email||'', token: et, status:'pending', answered:0, total_questions: (p.questions||[]).length}
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

// ---- Synthesis ----

async function triggerSynthesis(req, env, pid) {
  var projects = await sbQuery(env, 'chop_projects?id=eq.' + pid + '&select=*');
  var p = projects && projects[0];
  if (!p) return json({error:'Not found'}, 404);

  // If already synthesized, just return the cached result
  if (p.status === 'synthesized' && p.synthesis_result) {
    return json({status: 'ok', cached: true});
  }

  // Fire the Edge Function asynchronously
  var ut = getUserToken(req);
  await sbQuery(env, 'chop_projects?id=eq.' + pid, {method:'PATCH', body:{status:'synthesizing'}});

  // Fire and forget via ctx.waitUntil would be ideal, but we need await for response
  // Since this is a POST endpoint, we can fire it and return immediately
  // The frontend will poll for completion
  try {
    var efUrl = (env.SUPABASE_URL || 'https://ofggjtkweqlkncgablbm.supabase.co').replace(/\/+$/, '') + '/functions/v1/synthesize-knowledge';
    var efResp = await fetch(efUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SUPABASE-URL': env.SUPABASE_URL,
        'X-SUPABASE-SERVICE-KEY': env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + (ut || env.SUPABASE_SERVICE_KEY)
      },
      body: JSON.stringify({project_id: pid})
    });
    if (!efResp.ok) {
      var efErr = await efResp.text();
      console.error('Synthesis EF returned error', efResp.status, efErr);
      return json({status: 'error', error: efErr});
    }
    return json({status: 'ok'});
  } catch(e) {
    console.error('Synthesis EF error', e.message);
    return json({status: 'error', error: e.message});
  }
}

async function getSynthesisBundle(req, env, pid) {
  var projects = await sbQuery(env, 'chop_projects?id=eq.' + pid + '&select=synthesis_result');
  var p = projects && projects[0];
  if (!p || !p.synthesis_result) return json({error:'No synthesis', bundle: null});
  return json({bundle: p.synthesis_result.bundle || {}});
}

async function expertQuestions(req, env, token) {
  var experts = await sbQuery(env, 'chop_experts?token=eq.' + token + '&select=*');
  var expert = experts && experts[0];
  if (!expert) return json({error:'Not found'}, 404);
  var projects = await sbQuery(env, 'chop_projects?id=eq.' + expert.project_id + '&select=name,questions');
  var project = projects && projects[0];
  if (!project) return json({error:'Not found'}, 404);
  var questions = project.questions || [];
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
  var questions = project.questions || [];
  if (body.idx < 0 || body.idx >= questions.length) return json({error:'Invalid index'}, 400);
  var q = questions[body.idx];
  var ans = body.skip ? null : (body.text || '');
  var existing = await sbQuery(env, 'chop_answers?expert_id=eq.' + expert.id + '&question_id=eq.' + q.qid + '&select=*');
  if (existing && existing.length > 0) {
    var ts = new Date().toISOString();
    await sbQuery(env, 'chop_answers?id=eq.' + existing[0].id, {method:'PATCH', body:{answer: ans, skipped: !!body.skip, answered_at: ts}});
  } else {
    await sbQuery(env, 'chop_answers', {method:'POST', body:{project_id: expert.project_id, expert_id: expert.id, question_id: q.qid, question_text: q.text, category: q.category, answer: ans, skipped: !!body.skip}});
  }
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
  var as = questions.map(function(qn, i) {
    var ea = allAnswers.find(function(a){return a.question_id === qn.qid;});
    return {idx:i, qid:qn.qid, category:qn.category, text:qn.text, answered:!!(ea && ea.answer), skipped: ea ? ea.skipped : false, answer: ea ? ea.answer : null};
  });
  var ci = as.findIndex(function(a){return !a.answered && !a.skipped});
  return json({assignments:as, current_index:ci >= 0 ? ci : as.length});
}

// Helpers
function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function json(d, s) { return new Response(JSON.stringify(d), {status:s||200, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}}); }

function sbUrl(env) { return env.SUPABASE_URL; }
function sbKey(env) { return env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY; }
function sbAnonKey(env) { return env.SUPABASE_ANON_KEY; }

async function sbQuery(env, path, opts) {
  var url = env.SUPABASE_URL + '/rest/v1/' + path;
  var bearerKey = (opts && opts.userToken) || sbKey(env);
  var headers = {
    'apikey': sbKey(env),
    'Authorization': 'Bearer ' + bearerKey,
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

function sbUser(token, env) {
  return fetch(env.SUPABASE_URL + '/auth/v1/user', {
    method: 'GET',
    headers: {'apikey': sbAnonKey(env), 'Authorization': 'Bearer ' + token}
  });
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

function getUserToken(req) {
  var auth = req.headers.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// Auth handlers
async function handleSignup(req, env) {
  var body = await req.json();
  var r = await sbAuth(env, 'signup', {email: body.email, password: body.password});
  if (!r.ok) return json({error: (r.data && (r.data.msg || r.data.error_description)) || 'Signup failed'}, 400);
  return json({user: r.data.user, session: r.data.session ? {access_token: r.data.session.access_token, expires_in: r.data.session.expires_in} : null});
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
  try {
    var r = await sbUser(token, env);
    if (!r.ok) return json({user: null});
    var userData = await r.json();
    return json({user: {id: uid, email: userData && userData.email}});
  } catch(e) { return json({user: null}); }
}

// Router
export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var path = url.pathname;
    var method = request.method;
    if (method === 'OPTIONS') return new Response(null, {status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT','Access-Control-Allow-Headers':'Content-Type,X-Owner-Token,Authorization'}});

    // Auth API
    if (path === '/auth/signup' && method === 'POST') return handleSignup(request, env);
    if (path === '/auth/login' && method === 'POST') return handleLogin(request, env);
    if (path === '/auth/logout' && method === 'POST') return handleLogout(request, env);
    if (path === '/auth/me' && method === 'GET') return handleMe(request, env);

    // Auth UI
    if (path === '/login' && method === 'GET') return loginPage(request, env);
    if (path === '/login/login' && method === 'POST') return loginPost(request, env);
    if (path === '/login/signup' && method === 'POST') return signupPost(request, env);

    // API - projects
    if (path === '/api/projects' && method === 'GET') return listUserProjects(request, env);
    if (path === '/api/projects' && method === 'POST') return createProject(request, env, ctx);
    if (path === '/api/admin/events') return getEvents(request, env);

    var m = path.match(/^\/api\/projects\/([^/]+)$/);
    if (m && method === 'GET') return getProject(request, env, m[1]);

    m = path.match(/^\/api\/projects\/([^/]+)\/experts$/);
    if (m && method === 'POST') return addExpert(request, env, m[1]);
    if (m && method === 'GET') return listExperts(request, env, m[1]);

    // Synthesis
    m = path.match(/^\/api\/projects\/([^/]+)\/synthesize$/);
    if (m && method === 'POST') return triggerSynthesis(request, env, m[1]);

    m = path.match(/^\/api\/projects\/([^/]+)\/synthesize\/download$/);
    if (m && method === 'GET') return getSynthesisBundle(request, env, m[1]);
    if (m && method === 'POST') return getSynthesisBundle(request, env, m[1]);

    // Answer routes
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