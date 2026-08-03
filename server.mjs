/**
 * 面试复盘 - 本地管理服务器
 * 解决浏览器 CORS 限制，提供可视化面板
 * 启动: node server.mjs
 */
import http from "http";
import https from "https";
import fs from "fs";
import path from "path";

const PORT = 8888;
const PROXY = "interview-proxy-zuoftlbtnc.cn-hangzhou.fcapp.run";
const ADMIN_HTML = fs.readFileSync(path.join(import.meta.dirname || ".", "admin.html"), "utf-8");
const CUSTOMER_HTML = fs.readFileSync(path.join(import.meta.dirname || ".", "customer.html"), "utf-8");

// 订单存储（内存，重启会丢，正式用需要持久化）
let orders = {};

function proxyToFC(req, res, extraHeaders) {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const fcReq = https.request({
      hostname: PROXY, port: 443,
      path: req.url.replace("/api-proxy", "").replace("/customer-proxy", ""),
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": req.headers["x-admin-key"] || "",
        "x-api-key": req.headers["x-api-key"] || "",
        ...extraHeaders,
      },
    }, (fcRes) => {
      let d = "";
      fcRes.on("data", c => d += c);
      fcRes.on("end", () => {
        res.writeHead(fcRes.statusCode, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(d);
      });
    });
    fcReq.on("error", () => { res.writeHead(502); res.end('{"error":"FC unreachable"}'); });
    if (body) fcReq.write(body);
    fcReq.end();
  });
}

function callFC(path, method, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: PROXY, port: 443, path, method: method || "GET",
      headers: { "Content-Type": "application/json", ...extraHeaders },
    };
    const data = body ? JSON.stringify(body) : null;
    if (data) opts.headers["Content-Length"] = Buffer.byteLength(data);

    const fcReq = https.request(opts, (fcRes) => {
      let d = ""; fcRes.on("data", c => d += c);
      fcRes.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
      });
    });
    fcReq.on("error", reject);
    if (data) fcReq.write(data);
    fcReq.end();
  });
}

function readBody(req) {
  return new Promise(resolve => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p === "/" || p === "/admin") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ADMIN_HTML);
  } else if (p === "/customer") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(CUSTOMER_HTML);
  } else if (p.startsWith("/api-proxy")) {
    proxyToFC(req, res);

  // === 客户接口（用管理员密码调 FC，不需要改 FC）===

  } else if (p === "/customer/register" && req.method === "POST") {
    const b = await readBody(req);
    const email = (b.email || "").trim().toLowerCase();
    if (!email) { res.writeHead(400); return res.end(JSON.stringify({ error: "Missing email" })); }

    try {
      // 查所有 Key，找是否已有这个邮箱
      const keys = await callFC("/admin/list-keys", "GET", null, { "x-admin-key": process.env.ADMIN_PASSWORD || "change-me" });
      const existing = keys.find(k => (k.label || "").toLowerCase().includes(email));
      if (existing) {
        return res.end(JSON.stringify({ key: existing.key, quota: existing.quota, used: existing.used, label: existing.label, isNew: false }));
      }
      // 新用户：生成 Key，送 3 次
      const result = await callFC("/admin/generate-key", "POST", { label: email, quota: 3 }, { "x-admin-key": process.env.ADMIN_PASSWORD || "change-me" });
      res.end(JSON.stringify({ key: result.key, quota: 3, used: 0, label: email, isNew: true }));
    } catch (e) {
      res.writeHead(502); res.end(JSON.stringify({ error: "FC unreachable" }));
    }

  } else if (p === "/customer/quota" && req.method === "POST") {
    const b = await readBody(req);
    const key = (b.key || "").trim();
    if (!key) { res.writeHead(400); return res.end(JSON.stringify({ error: "Missing key" })); }
    try {
      const result = await callFC("/api/quota", "GET", null, { "x-api-key": key });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(502); res.end(JSON.stringify({ error: "FC unreachable" }));
    }
  } else {
    res.writeHead(404);
    res.end("404");
  }
});

server.listen(PORT, () => {
  console.log(`✅ 管理: http://localhost:${PORT}/admin`);
  console.log(`✅ 客户: http://localhost:${PORT}/customer`);
  console.log("按 Ctrl+C 退出");
});
