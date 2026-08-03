/**
 * 面试复盘助手 - API 代理 Worker
 *
 * 功能：
 * 1. 校验用户 Key 的配额
 * 2. 代理请求到阿里云百炼
 * 3. 扣减配额
 *
 * 部署：npx wrangler deploy
 */

interface Env {
  QUOTA: KVNamespace;
  REAL_API_KEY: string;  // wrangler secret put REAL_API_KEY
}

// 每次调用的扣减量（按字数量阶梯计价，这里简化）
const COST_PER_CALL = 1;

// CORS headers
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // 管理端：生成 Key
    if (url.pathname === "/admin/generate-key" && request.method === "POST") {
      return handleGenerateKey(request, env);
    }

    // 管理端：查看所有 Key
    if (url.pathname === "/admin/list-keys" && request.method === "GET") {
      return handleListKeys(request, env);
    }

    // 客户注册页面
    if (url.pathname === "/customer" && request.method === "GET") {
      return new Response(CUSTOMER_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // 客户：注册/登录（Worker 代理到 FC）
    if (url.pathname === "/customer/register" && request.method === "POST") {
      return handleCustomerRegister(request, env);
    }

    // 客户：查配额（Worker 代理到 FC）
    if (url.pathname === "/customer/quota" && request.method === "POST") {
      return handleCustomerQuota(request, env);
    }

    // 管理端：管理页面
    if (url.pathname === "/admin" && request.method === "GET") {
      return new Response(ADMIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // 管理端：续费 Key
    if (url.pathname === "/admin/renew-key" && request.method === "POST") {
      return handleRenewKey(request, env);
    }

    // 客户端：查询配额
    if (url.pathname === "/api/quota" && request.method === "GET") {
      return handleQuota(request, env);
    }

    // 客户端：代理 API 调用
    if (url.pathname === "/api/transcribe" || url.pathname === "/api/chat") {
      return handleProxy(request, env, url.pathname);
    }

    return new Response("Not Found", { status: 404, headers: CORS });
  },
};

// ========== Key 管理 ==========

async function handleGenerateKey(request: Request, env: Env): Promise<Response> {
  const adminKey = request.headers.get("x-admin-key");
  if (adminKey !== env.REAL_API_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
  }

  const body: any = await request.json();
  const key = generateKey();
  const quota = body.quota || 100;
  const label = body.label || "";

  await env.QUOTA.put(`key:${key}`, JSON.stringify({
    quota,
    used: 0,
    label,
    created: Date.now(),
  }));

  return new Response(JSON.stringify({ key, quota, label }), { headers: { ...CORS, "Content-Type": "application/json" } });
}

async function handleListKeys(request: Request, env: Env): Promise<Response> {
  const adminKey = request.headers.get("x-admin-key");
  if (adminKey !== env.REAL_API_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
  }

  const list = await env.QUOTA.list({ prefix: "key:" });
  const keys = [];
  for (const k of list.keys) {
    const data = await env.QUOTA.get(k.name);
    if (data) keys.push({ key: k.name.replace("key:", ""), ...JSON.parse(data) });
  }

  return new Response(JSON.stringify(keys), { headers: { ...CORS, "Content-Type": "application/json" } });
}

async function handleRenewKey(request: Request, env: Env): Promise<Response> {
  const adminKey = request.headers.get("x-admin-key");
  if (adminKey !== env.REAL_API_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
  }

  const body: any = await request.json();
  const targetKey = body.key;
  const addQuota = body.addQuota || 0;

  const data = await env.QUOTA.get(`key:${targetKey}`);
  if (!data) {
    return new Response(JSON.stringify({ error: "Key not found" }), { status: 404, headers: CORS });
  }

  const info = JSON.parse(data);
  info.quota += addQuota;
  await env.QUOTA.put(`key:${targetKey}`, JSON.stringify(info));

  return new Response(JSON.stringify({ key: targetKey, quota: info.quota, used: info.used }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ========== 客户端 API ==========

async function handleQuota(request: Request, env: Env): Promise<Response> {
  const userKey = request.headers.get("x-api-key");
  if (!userKey) return new Response(JSON.stringify({ error: "Missing API key" }), { status: 401, headers: CORS });

  const data = await env.QUOTA.get(`key:${userKey}`);
  if (!data) return new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401, headers: CORS });

  const info = JSON.parse(data);
  return new Response(JSON.stringify({ quota: info.quota, used: info.used, remaining: info.quota - info.used }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function handleProxy(request: Request, env: Env, path: string): Promise<Response> {
  // 1. 校验用户 Key
  const userKey = request.headers.get("x-api-key");
  if (!userKey) {
    return new Response(JSON.stringify({ error: "Missing API key" }), { status: 401, headers: CORS });
  }

  const data = await env.QUOTA.get(`key:${userKey}`);
  if (!data) {
    return new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401, headers: CORS });
  }

  const info = JSON.parse(data);

  // 2. 检查配额
  if (info.used >= info.quota) {
    return new Response(JSON.stringify({ error: "Quota exhausted", quota: info.quota, used: info.used }), {
      status: 429, headers: CORS,
    });
  }

  // 3. 代理到阿里云百炼
  const targetUrl = path === "/api/transcribe"
    ? "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    : "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

  const body = await request.text();

  const proxyResp = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.REAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body,
  });

  // 4. 扣减配额（仅成功时）
  if (proxyResp.ok) {
    info.used += COST_PER_CALL;
    await env.QUOTA.put(`key:${userKey}`, JSON.stringify(info));
  }

  // 5. 返回结果
  const result = await proxyResp.text();

  return new Response(result, {
    status: proxyResp.status,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      "X-Quota-Remaining": String(info.quota - info.used),
    },
  });
}

// ========== 客户 API（代理到 FC）==========

async function handleCustomerRegister(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const email = (body.email || "").trim().toLowerCase();
  if (!email) return new Response(JSON.stringify({ error: "Missing email" }), { status: 400, headers: CORS });

  // 先查 FC 是否已有此邮箱的 Key（FC 管理员密码是 12345）
  const fcAdminPassword = "12345";
  const listResp = await fetch("https://interview-proxy-zuoftlbtnc.cn-hangzhou.fcapp.run/admin/list-keys", {
    headers: { "x-admin-key": fcAdminPassword },
  });
  const keys = await listResp.json();
  const existing = keys.find((k: any) => (k.label || "").toLowerCase().includes(email));
  if (existing) {
    return new Response(JSON.stringify({ key: existing.key, quota: existing.quota, used: existing.used, label: existing.label, isNew: false }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // 新用户：调 FC 生成 Key
  const genResp = await fetch("https://interview-proxy-zuoftlbtnc.cn-hangzhou.fcapp.run/admin/generate-key", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": fcAdminPassword },
    body: JSON.stringify({ label: email, quota: 3 }),
  });
  const result = await genResp.json();
  return new Response(JSON.stringify({ key: result.key, quota: 3, used: 0, label: email, isNew: true }), { headers: { ...CORS, "Content-Type": "application/json" } });
}

async function handleCustomerQuota(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const key = (body.key || "").trim();
  if (!key) return new Response(JSON.stringify({ error: "Missing key" }), { status: 400, headers: CORS });

  const resp = await fetch("https://interview-proxy-zuoftlbtnc.cn-hangzhou.fcapp.run/api/quota", {
    headers: { "x-api-key": key },
  });
  const result = await resp.text();
  return new Response(result, { headers: { ...CORS, "Content-Type": "application/json" } });
}

// ========== 工具 ==========

function generateKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const segments = [8, 6, 6, 6, 8];
  return segments.map(n => Array.from({length: n}, () => chars[Math.floor(Math.random() * chars.length)]).join("")).join("-");
}

// ========== 管理页面 ==========

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>面试复盘助手 - Key 管理</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;max-width:900px;margin:0 auto;padding:20px;background:#f5f5f5;color:#333}
.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px}
.topbar h1{font-size:22px}
.login-box{display:flex;gap:6px;align-items:center}
.login-box input{padding:7px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;width:280px}
.login-box button{padding:7px 14px;background:#6c5ce7;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap}
.login-box button:hover{background:#5a4bd1}
.logged-in{font-size:13px;color:#07c160}
.grid{display:grid;grid-template-columns:280px 1fr;gap:16px}
@media(max-width:700px){.grid{grid-template-columns:1fr}}
.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card h2{margin-bottom:14px;font-size:15px;display:flex;align-items:center;gap:8px}
.card h2 .count{font-size:12px;color:#999;font-weight:400}
label{display:block;margin-bottom:4px;font-weight:600;font-size:13px;color:#555}
input,select{padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;width:100%;margin-bottom:10px}
.btn{display:inline-block;padding:8px 18px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;border:none}
.btn-primary{background:#6c5ce7;color:#fff;width:100%}
.btn-primary:hover{background:#5a4bd1}
.btn-sm{padding:3px 10px;font-size:11px;border-radius:4px;margin:0 2px}
.btn-renew{background:#e8f5e9;color:#07c160;border:1px solid #07c160}
.btn-renew:hover{background:#07c160;color:#fff}
.btn-delete{background:#fde8e8;color:#e74c3c;border:1px solid #e74c3c}
.btn-delete:hover{background:#e74c3c;color:#fff}
.btn-batch{background:#fff3e0;color:#e67e22;border:1px solid #e67e22}
.key-result{padding:12px;background:#ecfdf3;border:1px solid #07c160;border-radius:8px;margin-top:10px;display:none}
.key-result .key-val{font-family:monospace;font-weight:700;background:#e8f5e9;padding:6px 10px;border-radius:4px;word-break:break-all;margin:6px 0}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 6px;border-bottom:2px solid #eee;color:#999;font-weight:600;font-size:11px}
td{padding:8px 6px;border-bottom:1px solid #f0f0f0;vertical-align:middle}
tr:hover{background:#fafafa}
.progress-bar{height:5px;background:#eee;border-radius:3px;overflow:hidden;min-width:60px}
.progress-fill{height:100%;border-radius:3px;transition:width .3s}
.progress-fill.low{background:#07c160}.progress-fill.mid{background:#f39c12}.progress-fill.high{background:#e74c3c}
.badge{font-size:10px;padding:2px 6px;border-radius:3px;font-weight:600}
.badge-ok{background:#e8f5e9;color:#07c160}.badge-warn{background:#fff3e0;color:#e67e22}.badge-end{background:#fde8e8;color:#e74c3c}
.actions{display:flex;gap:4px;flex-wrap:wrap}
.toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:8px;color:#fff;font-size:14px;z-index:99;display:none}
.toast-ok{background:#07c160}.toast-err{background:#e74c3c}
small{color:#999}
.search-box{margin-bottom:10px}
.search-box input{padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:12px;width:100%}
</style>
</head>
<body>

<div class="topbar">
  <h1>🔑 面试复盘 - Key 管理</h1>
  <div id="loginArea" class="login-box">
    <input id="adminKey" type="password" placeholder="输入管理员密钥（百炼Key）" />
    <button onclick="login()">登录</button>
  </div>
  <div id="loggedInArea" style="display:none">
    <span class="logged-in">✅ 已登录</span>
    <button class="btn btn-sm" onclick="logout()" style="margin-left:8px">退出</button>
  </div>
</div>

<div id="mainContent" style="display:none">
<div class="grid">
  <!-- 左侧：生成 + 批量 -->
  <div>
    <div class="card">
      <h2>🎫 生成新 Key</h2>
      <label>标签/备注</label>
      <input id="label" placeholder="小红书-张三-月卡" />
      <label>配额（次数）</label>
      <input id="quota" type="number" value="100" min="1" />
      <button class="btn btn-primary" onclick="generate()">生成</button>
      <div id="genResult" class="key-result"></div>
    </div>

    <div class="card" style="margin-top:12px">
      <h2>📦 批量生成</h2>
      <label>数量</label>
      <input id="batchCount" type="number" value="10" min="1" max="50" />
      <label>每个配额</label>
      <input id="batchQuota" type="number" value="100" min="1" />
      <label>标签前缀</label>
      <input id="batchLabel" placeholder="小红书-月卡" />
      <button class="btn btn-batch" onclick="batchGenerate()" style="width:100%">批量生成</button>
      <div id="batchResult" class="key-result"></div>
    </div>
  </div>

  <!-- 右侧：列表 -->
  <div class="card">
    <h2>👥 客户列表 <span class="count" id="keyCount"></span></h2>
    <div class="search-box"><input id="searchInput" placeholder="🔍 搜索标签或Key..." oninput="renderTable()" /></div>
    <div style="max-height:60vh;overflow-y:auto">
      <table>
        <thead><tr><th>Key</th><th>标签</th><th>用量</th><th>进度</th><th>状态</th><th>操作</th></tr></thead>
        <tbody id="keyTableBody"></tbody>
      </table>
    </div>
    <div style="margin-top:10px"><button class="btn btn-sm" onclick="loadKeys()">🔄 刷新</button></div>
  </div>
</div>
</div>

<div id="toast" class="toast"></div>

<script>
let ADMIN_KEY = "";
let allKeys = [];

function toast(msg, ok) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "toast " + (ok ? "toast-ok" : "toast-err");
  t.style.display = "block";
  setTimeout(() => t.style.display = "none", 2000);
}

function saveLogin() {
  localStorage.setItem("ir_admin_key", ADMIN_KEY);
}

function login() {
  ADMIN_KEY = document.getElementById("adminKey").value.trim();
  if (!ADMIN_KEY) return toast("请输入密钥", false);
  loadKeys().then(() => {
    document.getElementById("loginArea").style.display = "none";
    document.getElementById("loggedInArea").style.display = "";
    document.getElementById("mainContent").style.display = "";
    saveLogin();
  }).catch(() => toast("登录失败，请检查密钥", false));
}

function logout() {
  ADMIN_KEY = ""; allKeys = [];
  localStorage.removeItem("ir_admin_key");
  document.getElementById("loginArea").style.display = "";
  document.getElementById("loggedInArea").style.display = "none";
  document.getElementById("mainContent").style.display = "none";
}

// 自动登录
(function(){
  const saved = localStorage.getItem("ir_admin_key");
  if (saved) {
    ADMIN_KEY = saved;
    document.getElementById("adminKey").value = saved;
    loadKeys().then(() => {
      document.getElementById("loginArea").style.display = "none";
      document.getElementById("loggedInArea").style.display = "";
      document.getElementById("mainContent").style.display = "";
    }).catch(() => {});
  }
})();

async function api(path, opts = {}) {
  const h = opts.headers || {};
  h["x-admin-key"] = ADMIN_KEY;
  const r = await fetch(path, { ...opts, headers: h });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

async function generate() {
  const label = document.getElementById("label").value || "未备注";
  const quota = parseInt(document.getElementById("quota").value) || 100;
  try {
    const d = await api("/admin/generate-key", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({label, quota}) });
    document.getElementById("genResult").style.display = "block";
    document.getElementById("genResult").innerHTML = \`<b>✅ 已生成</b><div class="key-val">\${d.key}</div><small>标签: \${d.label} | 配额: \${d.quota}次</small>\`;
    document.getElementById("label").value = "";
    loadKeys();
  } catch(e) { toast(e.message, false); }
}

async function batchGenerate() {
  const count = parseInt(document.getElementById("batchCount").value) || 10;
  const quota = parseInt(document.getElementById("batchQuota").value) || 100;
  const label = document.getElementById("batchLabel").value || "批量";
  const keys = [];
  try {
    for (let i = 0; i < count; i++) {
      const d = await api("/admin/generate-key", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({label: label + "-" + (i+1), quota}) });
      keys.push(d.key);
    }
    document.getElementById("batchResult").style.display = "block";
    document.getElementById("batchResult").innerHTML = "<b>✅ 已生成 " + count + " 个 Key</b><br><textarea style='width:100%;height:120px;margin-top:8px;font-size:11px;font-family:monospace' onclick='this.select()'>" + keys.join("\\n") + "</textarea><small>点击文本框全选复制</small>";
    loadKeys();
  } catch(e) { toast(e.message, false); }
}

function renderTable() {
  const search = (document.getElementById("searchInput").value || "").toLowerCase();
  const filtered = allKeys.filter(k => (k.label||"").toLowerCase().includes(search) || (k.key||"").toLowerCase().includes(search));

  document.getElementById("keyCount").textContent = "共 " + filtered.length + " 个客户";
  const tbody = document.getElementById("keyTableBody");
  tbody.innerHTML = filtered.map(k => {
    const pct = k.quota > 0 ? Math.round(k.used / k.quota * 100) : 0;
    let cls = "low", badge = "badge-ok", status = "正常";
    if (k.used >= k.quota) { cls = "high"; badge = "badge-end"; status = "用完"; }
    else if (pct > 80) { cls = "mid"; badge = "badge-warn"; status = "快用完"; }

    return \`<tr>
      <td><small title="\${k.key}">\${k.key.substring(0,12)}...</small></td>
      <td>\${k.label||"-"}</td>
      <td>\${k.used}/\${k.quota}</td>
      <td><div class="progress-bar"><div class="progress-fill \${cls}" style="width:\${pct}%"></div></div></td>
      <td><span class="badge \${badge}">\${status}</span></td>
      <td><div class="actions">
        <button class="btn btn-sm btn-renew" onclick="renew('\${k.key}')">+100</button>
        <button class="btn btn-sm btn-renew" onclick="renew('\${k.key}',500)">+500</button>
        <button class="btn btn-sm btn-delete" onclick="del('\${k.key}')">删</button>
      </div></td>
    </tr>\`;
  }).join("");
}

async function loadKeys() {
  try {
    allKeys = await api("/admin/list-keys");
    renderTable();
    toast("已刷新", true);
  } catch(e) { toast(e.message, false); throw e; }
}

async function renew(key, add = 100) {
  try {
    await api("/admin/renew-key", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({key, addQuota: add}) });
    toast("已续费 +" + add, true);
    loadKeys();
  } catch(e) { toast(e.message, false); }
}

async function del(key) {
  if (!confirm("确定删除 Key: " + key.substring(0,12) + "...?")) return;
  try {
    await api("/admin/renew-key", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({key, addQuota: -999999}) });
    toast("已删除", true);
    loadKeys();
  } catch(e) { toast(e.message, false); }
}
</script>
</body>
</html>`;


const CUSTOMER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>面试复盘助手 · 我的许可证</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;color:#333}
.container{max-width:600px;margin:0 auto;padding:40px 20px}
.hero{text-align:center;color:#fff;padding:40px 0 20px}
.hero h1{font-size:26px;margin-bottom:8px}
.hero p{opacity:.85;font-size:14px}
.card{background:#fff;border-radius:16px;padding:32px;box-shadow:0 8px 32px rgba(0,0,0,.15);margin-bottom:20px}
.card h2{font-size:17px;margin-bottom:20px}
label{display:block;font-size:13px;font-weight:600;color:#555;margin-bottom:4px}
input{padding:10px 14px;border:1px solid #ddd;border-radius:8px;font-size:14px;width:100%;margin-bottom:14px}
.btn{display:block;width:100%;padding:12px;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;text-align:center;transition:.2s}
.btn-primary{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}.btn-primary:hover{opacity:.9}
.btn-green{background:#07c160;color:#fff;margin-top:8px}.btn-green:hover{opacity:.9}
.btn-outline{background:#fff;color:#764ba2;border:2px solid #764ba2;margin-top:8px}.btn-outline:hover{background:#f8f5ff}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:20px 0}
.stat{text-align:center;padding:16px 8px;background:#f8f9fa;border-radius:10px}
.stat .num{font-size:28px;font-weight:800;color:#764ba2}
.stat .lbl{font-size:12px;color:#999;margin-top:4px}
.key-display{background:#f0fdf4;border:2px solid #07c160;border-radius:12px;padding:20px;text-align:center}
.key-display .title{font-weight:700;color:#07c160;margin-bottom:12px}
.key-code{font-family:monospace;font-size:13px;font-weight:700;background:#e8f5e9;padding:10px 16px;border-radius:6px;word-break:break-all;margin:8px 0}
.copy-btn{display:inline-block;padding:6px 20px;background:#07c160;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;margin-top:8px}
.plan-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}
@media(max-width:500px){.plan-grid{grid-template-columns:1fr}}
.plan-card{border:2px solid #eee;border-radius:10px;padding:16px;text-align:center;cursor:pointer;transition:.2s}
.plan-card:hover{border-color:#764ba2;transform:translateY(-1px)}
.plan-card .name{font-weight:700;font-size:14px}
.plan-card .price{font-size:22px;font-weight:800;color:#764ba2;margin:8px 0}
.plan-card .price s{font-size:12px;color:#bbb;font-weight:400}
.plan-card .quota{font-size:12px;color:#888}
.toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:8px;color:#fff;font-size:14px;z-index:99;display:none}
.toast-ok{background:#07c160}.toast-err{background:#e74c3c}
.foot{text-align:center;color:rgba(255,255,255,.7);font-size:12px;padding:20px}
.logout-link{color:rgba(255,255,255,.6);font-size:13px;cursor:pointer}
</style>
</head>
<body>

<div class="container">
  <div class="hero">
    <h1>🎯 面试复盘助手</h1>
    <p>我的许可证管理</p>
  </div>

  <!-- 注册/登录 -->
  <div id="loginCard" class="card">
    <h2>📧 注册 / 登录</h2>
    <p style="font-size:13px;color:#888;margin-bottom:16px">输入邮箱，新用户自动注册并赠送 3 次免费试用</p>
    <label>邮箱</label>
    <input id="loginEmail" type="email" placeholder="your@email.com">
    <button class="btn btn-primary" onclick="login()">进入</button>
    <p id="loginError" style="color:#e74c3c;font-size:12px;margin-top:8px;display:none"></p>
  </div>

  <!-- 已登录 -->
  <div id="dashboard" style="display:none">
    <!-- 用量 -->
    <div class="card">
      <h2>📊 我的用量</h2>
      <div class="stats">
        <div class="stat"><div class="num" id="statTotal">-</div><div class="lbl">总配额</div></div>
        <div class="stat"><div class="num" id="statUsed">-</div><div class="lbl">已用</div></div>
        <div class="stat"><div class="num" id="statRemain">-</div><div class="lbl">剩余</div></div>
      </div>
      <div style="background:#f8f9fa;border-radius:8px;height:8px;overflow:hidden">
        <div id="progressBar" style="height:100%;background:linear-gradient(90deg,#07c160,#f39c12,#e74c3c);border-radius:8px;width:0%;transition:.5s"></div>
      </div>
      <p style="text-align:center;font-size:12px;color:#999;margin-top:8px" id="emailDisplay"></p>
      <button class="btn btn-outline" onclick="logout()">退出登录</button>
    </div>

    <!-- 我的 Key -->
    <div id="keyCard" class="card" style="display:none">
      <h2>🔑 我的许可证 Key</h2>
      <div class="key-display">
        <p class="title">复制下面这个 Key，填入插件设置即可使用</p>
        <div class="key-code" id="keyCode">-</div>
        <button class="copy-btn" onclick="copyKey()">📋 复制 Key</button>
      </div>
    </div>

    <!-- 续费 -->
    <div class="card">
      <h2>🛒 续费 / 升级</h2>
      <div class="plan-grid">
        <div class="plan-card" onclick="renew(10,'单次试用','¥9.9')">
          <div class="name">试用</div>
          <div class="price">¥9.9</div>
          <div class="quota">+10 次</div>
        </div>
        <div class="plan-card" onclick="renew(50,'月卡','¥29.9')">
          <div class="name">月卡</div>
          <div class="price">¥29.9</div>
          <div class="quota">+50 次</div>
        </div>
        <div class="plan-card" onclick="renew(200,'年卡','¥99')">
          <div class="name">年卡</div>
          <div class="price">¥99</div>
          <div class="quota">+200 次</div>
        </div>
      </div>
      <p style="font-size:12px;color:#999;text-align:center;margin-top:12px">
        续费后联系客服处理，或稍后刷新页面查看
      </p>
    </div>
  </div>
</div>

<div class="foot">有问题? 小红书私信 @面试复盘学姐</div>
<div id="toast" class="toast"></div>

<script>
const PROXY = "https://interview-review-proxy.eu.cc";
const FREE_TRIAL = 3;

let currentKey = "";
let currentQuota = 0;
let currentUsed = 0;
let currentEmail = "";

// 恢复会话
if (localStorage.getItem("customer_email")) {
  currentEmail = localStorage.getItem("customer_email");
  currentKey = localStorage.getItem("customer_key") || "";
  loadDashboard();
}

function toast(msg, ok) {
  const e = document.getElementById("toast");
  e.textContent = msg;
  e.className = "toast " + (ok ? "toast-ok" : "toast-err");
  e.style.display = "block";
  setTimeout(() => e.style.display = "none", 2500);
}

async function api(path, method, body) {
  const opts = { method: method || "GET", headers: {} };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(PROXY + path, opts);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

// ===== 注册/登录 =====
async function login() {
  const email = document.getElementById("loginEmail").value.trim();
  if (!email) return showLoginError("请输入邮箱");
  currentEmail = email;

  try {
    const result = await api("/customer/register", "POST", { email });
    currentKey = result.key;
    currentQuota = result.quota;
    currentUsed = result.used;
    localStorage.setItem("customer_email", currentEmail);
    localStorage.setItem("customer_key", currentKey);
    loadDashboard();
  } catch (e) {
    showLoginError("网络错误，请重试");
  }
}

function showLoginError(msg) {
  const el = document.getElementById("loginError");
  el.textContent = msg;
  el.style.display = "";
}

function logout() {
  localStorage.removeItem("customer_email");
  localStorage.removeItem("customer_key");
  currentEmail = ""; currentKey = ""; currentQuota = 0; currentUsed = 0;
  document.getElementById("loginCard").style.display = "";
  document.getElementById("dashboard").style.display = "none";
  document.getElementById("loginEmail").value = "";
}

// ===== 面板 =====
async function loadDashboard() {
  document.getElementById("loginCard").style.display = "none";
  document.getElementById("dashboard").style.display = "";

  try {
    // 拉最新配额
    const quota = await api("/customer/quota", "POST", { key: currentKey });
    currentQuota = quota.quota;
    currentUsed = quota.used;

    document.getElementById("statTotal").textContent = currentQuota;
    document.getElementById("statUsed").textContent = currentUsed;
    document.getElementById("statRemain").textContent = quota.remaining;
    document.getElementById("emailDisplay").textContent = currentEmail;

    const pct = currentQuota > 0 ? Math.round(currentUsed / currentQuota * 100) : 0;
    document.getElementById("progressBar").style.width = pct + "%";

    // 显示 Key
    if (currentKey) {
      document.getElementById("keyCard").style.display = "";
      document.getElementById("keyCode").textContent = currentKey;
    }
  } catch (e) {
    toast("加载失败，请重试");
  }
}

function copyKey() {
  navigator.clipboard.writeText(currentKey).then(() => toast("已复制到剪贴板", true));
}

function renew(amount, name, price) {
  const msg = \`方案: \${name}\\n次数: +\${amount}\\n价格: \${price}\\n邮箱: \${currentEmail}\\nKey: \${currentKey}\\n\\n请联系客服付款激活\`;
  if (confirm(msg + "\\n\\n已复制信息，点确定去联系客服")) {
    navigator.clipboard.writeText(msg);
    toast("信息已复制，去小红书私信客服", true);
  }
}
</script>
`;
