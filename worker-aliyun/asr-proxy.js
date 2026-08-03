/**
 * 面试复盘助手 - API 代理（FC Web 函数）
 * 必须监听 0.0.0.0:9000
 */
const fs = require("fs");
const http = require("http");
const https = require("https");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const REAL_API_KEY = process.env.DASHSCOPE_API_KEY || "sk-your-key-here";
// NAS 持久化优先，无 NAS 时用 /tmp（测试环境）
const NAS_DIR = "/mnt/interview_proxy";
const KEYS_FILE = fs.existsSync(NAS_DIR) ? NAS_DIR + "/interview_keys.json" : "/tmp/interview_keys.json";

function loadKeys() {
  try { if (fs.existsSync(KEYS_FILE)) return JSON.parse(fs.readFileSync(KEYS_FILE,"utf-8")); } catch {}
  return {};
}
function saveKeys(keys) {
  const dir = require("path").dirname(KEYS_FILE);
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true}); } catch {}
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys,null,2),"utf-8");
}
function generateKey() { const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; return [8,6,6,6,8].map(n => Array.from({length:n},() => chars[Math.floor(Math.random()*chars.length)]).join("")).join("-"); }

let keyDb = loadKeys();

function corsOrigin(req) { return req.headers.origin || req.headers.host || "*"; }

function json(res, req, status, data) {
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":corsOrigin(req)});
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d=""; req.on("data",c=>d+=c); req.on("end",()=>{try{resolve(JSON.parse(d))}catch{resolve({raw:d})}});
  });
}

function proxyToDashScope(bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    const r = https.request({hostname:u.hostname,port:443,path:u.pathname,method:"POST",headers:{"Authorization":"Bearer "+REAL_API_KEY,"Content-Type":"application/json","Content-Length":Buffer.byteLength(bodyStr)}}, (res) => {
      let d=""; res.on("data",c=>d+=c); res.on("end",()=>resolve({status:res.statusCode,body:d}));
    });
    r.on("error",reject); r.write(bodyStr); r.end();
  });
}

function proxyToDashScopeASR(bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
    const r = https.request({hostname:u.hostname,port:443,path:u.pathname,method:"POST",headers:{"Authorization":"Bearer "+REAL_API_KEY,"Content-Type":"application/json","X-DashScope-SSE":"disable","Content-Length":Buffer.byteLength(bodyStr)}}, (res) => {
      let d=""; res.on("data",c=>d+=c); res.on("end",()=>{
        // 解析 fun-asr 响应：output.text 或 output.output.sentence.text
        try {
          const j = JSON.parse(d);
          if (j.output) {
            const text = j.output.text || j.output.output?.sentence?.text || "";
            d = JSON.stringify({ choices: [{ message: { content: text } }] });
          }
        } catch {}
        resolve({status:res.statusCode, body:d});
      });
    });
    r.on("error",reject); r.write(bodyStr); r.end();
  });
}

// ========== HTTP 服务器 ==========

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url||"/","http://localhost");
    const p = url.pathname.replace(/\/$/,"")||"/";
    const m = req.method||"GET";
    const headers = req.headers;

    if (m === "OPTIONS") { res.writeHead(204,{"Access-Control-Allow-Origin":corsOrigin(req),"Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,x-api-key"}); res.end(); return; }

    // 管理：生成 Key
    if (p === "/admin/generate-key" && m === "POST") {
      if ((headers["x-admin-key"]||"").trim() !== ADMIN_PASSWORD) return json(res, req,401,{error:"Unauthorized"});
      const b = await readBody(req);
      const k = generateKey();
      keyDb[k] = {quota:b.quota||100,used:0,label:b.label||"",created:Date.now()};
      saveKeys(keyDb);
      return json(res, req,200,{key:k,quota:b.quota||100,label:b.label||""});
    }

    // 管理：查看所有 Key
    if (p === "/admin/list-keys" && m === "GET") {
      if ((headers["x-admin-key"]||"").trim() !== ADMIN_PASSWORD) return json(res, req,401,{error:"Unauthorized"});
      return json(res, req,200,Object.entries(keyDb).map(([k,v])=>({key:k,...v})));
    }

    // 管理：设置配额
    if (p === "/admin/set-quota" && m === "POST") {
      if ((headers["x-admin-key"]||"").trim() !== ADMIN_PASSWORD) return json(res, req,401,{error:"Unauthorized"});
      const b = await readBody(req);
      if (!keyDb[b.key]) return json(res, req,404,{error:"Key not found"});
      keyDb[b.key].quota = b.quota;
      saveKeys(keyDb);
      return json(res, req,200,keyDb[b.key]);
    }

    // 管理：续费
    if (p === "/admin/renew-key" && m === "POST") {
      if ((headers["x-admin-key"]||"").trim() !== ADMIN_PASSWORD) return json(res, req,401,{error:"Unauthorized"});
      const b = await readBody(req);
      if (!keyDb[b.key]) return json(res, req,404,{error:"Key not found"});
      keyDb[b.key].quota += (b.addQuota||0);
      saveKeys(keyDb);
      return json(res, req,200,keyDb[b.key]);
    }

    // 管理：编辑 Key
    if (p === "/admin/edit-key" && m === "POST") {
      if ((headers["x-admin-key"]||"").trim() !== ADMIN_PASSWORD) return json(res, req, 401, {error:"Unauthorized"});
      const b = await readBody(req);
      if (!keyDb[b.key]) return json(res, req, 404, {error:"Key not found"});
      if (b.label !== undefined) keyDb[b.key].label = b.label;
      if (b.quota !== undefined) keyDb[b.key].quota = b.quota;
      saveKeys(keyDb);
      return json(res, req, 200, keyDb[b.key]);
    }

    // 管理：删除单个 Key
    if (p === "/admin/delete-key" && m === "POST") {
      if ((headers["x-admin-key"]||"").trim() !== ADMIN_PASSWORD) return json(res, req, 401, {error:"Unauthorized"});
      const b = await readBody(req);
      if (!keyDb[b.key]) return json(res, req, 404, {error:"Key not found"});
      delete keyDb[b.key];
      saveKeys(keyDb);
      return json(res, req, 200, {ok: true});
    }

    // 管理：清空所有 Key
    if (p === "/admin/purge" && m === "POST") {
      if ((headers["x-admin-key"]||"").trim() !== ADMIN_PASSWORD) return json(res, req, 401, {error:"Unauthorized"});
      keyDb = {};
      saveKeys(keyDb);
      return json(res, req, 200, {ok: true, message: "All keys deleted"});
    }

    // 客户：按邮箱查 Key（公开，无需管理员密码）
    if (p === "/customer/find-key" && m === "POST") {
      const b = await readBody(req);
      const email = (b.email || "").trim().toLowerCase();
      if (!email) return json(res, req, 400, { error: "Missing email" });

      // 遍历找匹配的 Key
      for (const [k, v] of Object.entries(keyDb)) {
        if ((v.label || "").toLowerCase().includes(email)) {
          return json(res, req, 200, { key: k, quota: v.quota, used: v.used, label: v.label });
        }
      }
      return json(res, req, 404, { error: "Not found" });
    }

    // 客户：注册新 Key（公开，新用户送 3 次）
    if (p === "/customer/register" && m === "POST") {
      const b = await readBody(req);
      const email = (b.email || "").trim().toLowerCase();
      if (!email) return json(res, req, 400, { error: "Missing email" });

      // 检查是否已存在
      for (const [k, v] of Object.entries(keyDb)) {
        if ((v.label || "").toLowerCase().includes(email)) {
          return json(res, req, 200, { key: k, quota: v.quota, used: v.used, label: v.label, isNew: false });
        }
      }

      // 新用户：自动生成 Key
      const k = generateKey();
      keyDb[k] = { quota: 3, used: 0, label: email, created: Date.now() };
      saveKeys(keyDb);
      return json(res, req, 200, { key: k, quota: 3, used: 0, label: email, isNew: true });
    }

    // 客户查配额
    if (p === "/customer/quota" && m === "POST") {
      const b = await readBody(req);
      const k = (b.key || "").trim();
      if (!k || !keyDb[k]) return json(res, req, 401, { error: "Invalid key" });
      return json(res, req, 200, { quota: keyDb[k].quota, used: keyDb[k].used, remaining: keyDb[k].quota - keyDb[k].used });
    }

    // 查配额
    if (p === "/api/quota" && m === "GET") {
      const k = (headers["x-api-key"]||"").trim();
      if (!k||!keyDb[k]) return json(res, req,401,{error:"Invalid key"});
      return json(res, req,200,{quota:keyDb[k].quota,used:keyDb[k].used,remaining:keyDb[k].quota-keyDb[k].used});
    }

    // 转写 API（测试版跳过 Key 校验）
    if (p === "/api/transcribe" && m === "POST") {
      const b = await readBody(req);
      const bodyObj = b.raw ? JSON.parse(b.raw) : b;
      const model = (bodyObj.model || "").toString();

      const isFlash = model.includes("fun-asr-flash");
      const result = isFlash
        ? await proxyToDashScopeASR(JSON.stringify(bodyObj))
        : await proxyToDashScope(JSON.stringify(bodyObj));

      res.writeHead(result.status,{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":corsOrigin(req)});
      return res.end(result.body);
    }

    // 分析 API（测试版跳过 Key 校验）
    if (p === "/api/chat" && m === "POST") {
      const b = await readBody(req);
      const bodyStr = JSON.stringify(b.raw?JSON.parse(b.raw):b);
      const result = await proxyToDashScope(bodyStr);

      res.writeHead(result.status,{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":corsOrigin(req)});
      return res.end(result.body);
    }

    // 复盘完成上报（测试版跳过配额校验，直接返回成功）
    if (p === "/api/review-complete" && m === "POST") {
      return json(res, req, 200, { quota: 999, used: 0, remaining: 999 });
    }

    // 管理页面
    if (p === "/admin" && m === "GET") {
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Disposition":"inline","Access-Control-Allow-Origin":corsOrigin(req)});
      return res.end(ADMIN_HTML);
    }

    json(res, req, 404, {error:"Not Found"});
  } catch(e) {
    console.error(e);
    json(res, req, 500, {error:e.message});
  }
});

server.listen(9000, "0.0.0.0", () => {
  console.log("Server running on 0.0.0.0:9000");
});

// ========== 管理页面 ==========
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>面试复盘助手 - Key管理</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;max-width:900px;margin:0 auto;padding:20px;background:#f5f5f5;color:#333}
.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}.topbar h1{font-size:22px}
.login-box{display:flex;gap:6px}.login-box input{padding:7px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;width:280px}
.login-box button{padding:7px 14px;background:#6c5ce7;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px}
.grid{display:grid;grid-template-columns:280px 1fr;gap:16px}@media(max-width:700px){.grid{grid-template-columns:1fr}}
.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}.card h2{margin-bottom:14px;font-size:15px}
label{display:block;margin-bottom:4px;font-weight:600;font-size:13px;color:#555}
input,select{padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;width:100%;margin-bottom:10px}
.btn{padding:8px 18px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;border:none}
.btn-primary{background:#6c5ce7;color:#fff;width:100%}.btn-sm{padding:3px 10px;font-size:11px;border-radius:4px;margin:0 2px}
.btn-renew{background:#e8f5e9;color:#07c160;border:1px solid #07c160}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:8px 6px;border-bottom:2px solid #eee;color:#999;font-weight:600;font-size:11px}
td{padding:8px 6px;border-bottom:1px solid #f0f0f0}.progress-bar{height:5px;background:#eee;border-radius:3px;overflow:hidden;min-width:60px}
.progress-fill{height:100%;border-radius:3px}.low{background:#07c160}.mid{background:#f39c12}.high{background:#e74c3c}
.badge{font-size:10px;padding:2px 6px;border-radius:3px;font-weight:600}.badge-ok{background:#e8f5e9;color:#07c160}.badge-warn{background:#fff3e0;color:#e67e22}.badge-end{background:#fde8e8;color:#e74c3c}
.key-result{padding:12px;background:#ecfdf3;border:1px solid #07c160;border-radius:8px;margin-top:10px;display:none}
.key-val{font-family:monospace;font-weight:700;background:#e8f5e9;padding:6px 10px;border-radius:4px;word-break:break-all;margin:6px 0}
.toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:8px;color:#fff;font-size:14px;z-index:99;display:none}
.toast-ok{background:#07c160}.toast-err{background:#e74c3c}
</style></head>
<body>
<div class="topbar"><h1>🔑 面试复盘 - Key管理</h1>
<div id="loginArea" class="login-box"><input id="adminKey" type="password" placeholder="输入管理员密钥"/><button onclick="login()">登录</button></div>
<div id="loggedInArea" style="display:none"><span style="color:#07c160">✅ 已登录</span><button class="btn btn-sm" onclick="logout()" style="margin-left:8px">退出</button></div></div>
<div id="main" style="display:none"><div class="grid">
<div><div class="card"><h2>🎫 生成新Key</h2><label>标签</label><input id="label" placeholder="如: 张三-月卡"/><label>配额</label><input id="quota" type="number" value="100"/>
<button class="btn btn-primary" onclick="gen()">生成</button><div id="genResult" class="key-result"></div></div>
<div class="card" style="margin-top:12px"><h2>📦 批量生成</h2><label>数量</label><input id="batchCount" type="number" value="10"/><label>每个配额</label><input id="batchQuota" type="number" value="100"/>
<label>标签前缀</label><input id="batchLabel" placeholder="小红书-月卡"/><button class="btn btn-renew" onclick="batch()" style="width:100%">批量生成</button><div id="batchResult" class="key-result"></div></div></div>
<div class="card"><h2>👥 客户列表 <span id="keyCount" style="font-size:12px;color:#999;font-weight:400"></span></h2>
<input id="search" placeholder="🔍 搜索..." oninput="render()" style="margin-bottom:10px;padding:6px 10px;font-size:12px;width:100%;border:1px solid #ddd;border-radius:6px"/>
<div style="max-height:60vh;overflow-y:auto"><table><thead><tr><th>Key</th><th>标签</th><th>用量</th><th>进度</th><th>状态</th><th>操作</th></tr></thead><tbody id="tbody"></tbody></table></div>
<button class="btn btn-sm" onclick="load()" style="margin-top:10px">🔄 刷新</button></div></div></div>
<div id="toast" class="toast"></div>
<script>
let AK="";let keys=[];
function t(m,ok){let e=document.getElementById("toast");e.textContent=m;e.className="toast "+(ok?"toast-ok":"toast-err");e.style.display="block";setTimeout(()=>e.style.display="none",2000)}
function login(){AK=document.getElementById("adminKey").value.trim();load().then(()=>{document.getElementById("loginArea").style.display="none";document.getElementById("loggedInArea").style.display="";document.getElementById("main").style.display=""}).catch(e=>t(e.message))}
function logout(){AK="";keys=[];document.getElementById("loginArea").style.display="";document.getElementById("loggedInArea").style.display="none";document.getElementById("main").style.display="none"}
async function api(p,o){o=o||{};o.headers=o.headers||{};o.headers["x-admin-key"]=AK;let r=await fetch(p,o);let d=await r.json();if(d.error)throw new Error(d.error);return d}
async function load(){keys=await api("/admin/list-keys");render();t("已刷新",true)}
async function gen(){let lb=document.getElementById("label").value||"未备注",qt=parseInt(document.getElementById("quota").value)||100;let d=await api("/admin/generate-key",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({label:lb,quota:qt})});document.getElementById("genResult").style.display="block";document.getElementById("genResult").innerHTML='<b>✅ 已生成</b><div class="key-val">'+d.key+'</div><small>'+d.label+' | '+d.quota+'次</small>';load()}
async function batch(){let n=parseInt(document.getElementById("batchCount").value)||10,q=parseInt(document.getElementById("batchQuota").value)||100,lb=document.getElementById("batchLabel").value||"批量",ks=[];for(let i=0;i<n;i++){let d=await api("/admin/generate-key",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({label:lb+"-"+(i+1),quota:q})});ks.push(d.key)}document.getElementById("batchResult").style.display="block";document.getElementById("batchResult").innerHTML='<b>✅ '+n+'个Key</b><br><textarea style="width:100%;height:120px;margin-top:8px;font-size:11px;font-family:monospace" onclick="this.select()">'+ks.join("\\n")+'</textarea><small>点击全选复制</small>';load()}
function render(){let s=(document.getElementById("search").value||"").toLowerCase();let f=keys.filter(k=>(k.label||"").toLowerCase().includes(s)||(k.key||"").toLowerCase().includes(s));document.getElementById("keyCount").textContent="共 "+f.length+" 个";document.getElementById("tbody").innerHTML=f.map(k=>{let p=k.quota>0?Math.round(k.used/k.quota*100):0,cls="low",badge="badge-ok",st="正常";if(k.used>=k.quota){cls="high";badge="badge-end";st="用完"}else if(p>80){cls="mid";badge="badge-warn";st="快用完"}return'<tr><td><small title="'+k.key+'">'+k.key.substring(0,12)+'...</small></td><td>'+(k.label||"-")+'</td><td>'+k.used+'/'+k.quota+'</td><td><div class="progress-bar"><div class="progress-fill '+cls+'" style="width:'+p+'%"></div></div></td><td><span class="badge '+badge+'">'+st+'</span></td><td><button class="btn btn-sm btn-renew" onclick="renew(\''+k.key+'\',100)">+100</button><button class="btn btn-sm btn-renew" onclick="renew(\''+k.key+'\',500)">+500</button></td></tr>'}).join("")}
async function renew(k,a){await api("/admin/renew-key",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:k,addQuota:a})});t("续费+"+a,true);load()}
</script>

</body>
</html>`;
