/**
 * 面试复盘 - Key 管理命令行工具
 * 用法: node admin-cli.mjs <命令>
 *
 * 命令:
 *   list           查看所有 Key
 *   gen <标签> <配额>  生成一个 Key
 *   batch <数量> <配额> <前缀>  批量生成
 *   renew <key> <加配额>  续费
 *   quota <key>   查单个配额
 *   purge         清空所有测试 Key
 */
import https from "https";

const PROXY = "interview-proxy-zuoftlbtnc.cn-hangzhou.fcapp.run";
const PASSWORD = "12345";

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(`https://${PROXY}${path}`);
    const headers = { "x-admin-key": PASSWORD, "Content-Type": "application/json" };
    const data = body ? JSON.stringify(body) : null;
    if (data) headers["Content-Length"] = Buffer.byteLength(data);

    const req = https.request({ hostname: u.hostname, port: 443, path: u.pathname, method, headers }, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function list() {
  const keys = await api("GET", "/admin/list-keys");
  console.log(`\n共 ${keys.length} 个 Key:\n`);
  console.log("Key                                    标签              用量      状态");
  console.log("─".repeat(90));
  for (const k of keys) {
    const pct = k.quota > 0 ? Math.round(k.used / k.quota * 100) : 0;
    const status = k.used >= k.quota ? "用完" : pct > 80 ? "快用完" : "正常";
    const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
    console.log(`${k.key.padEnd(40)} ${(k.label||"-").padEnd(16)} ${String(k.used).padStart(3)}/${String(k.quota).padEnd(5)} ${bar} ${status}`);
  }
}

async function gen(label, quota) {
  const result = await api("POST", "/admin/generate-key", { label, quota: parseInt(quota) });
  if (result.error) return console.log("❌", result.error);
  console.log(`\n✅ Key 已生成:`);
  console.log(`   Key:    ${result.key}`);
  console.log(`   标签:   ${result.label}`);
  console.log(`   配额:   ${result.quota} 次\n`);
}

async function batch(count, quota, prefix) {
  console.log(`\n⏳ 生成 ${count} 个 Key...`);
  const keys = [];
  for (let i = 0; i < parseInt(count); i++) {
    const label = `${prefix}-${i + 1}`;
    const r = await api("POST", "/admin/generate-key", { label, quota: parseInt(quota) });
    if (r.error) { console.log(`❌ ${label}: ${r.error}`); continue; }
    keys.push(r.key);
    process.stdout.write(`   ${i + 1}/${count} ${r.key}\r`);
  }
  console.log(`\n\n✅ ${keys.length} 个 Key:\n`);
  console.log(keys.join("\n"));
  console.log();
}

async function renew(key, add) {
  const r = await api("POST", "/admin/renew-key", { key, addQuota: parseInt(add) });
  if (r.error) return console.log("❌", r.error);
  console.log(`\n✅ 已续费: ${r.used}/${r.quota} (+${add})\n`);
}

async function quota(key) {
  return new Promise((resolve) => {
    const u = new URL(`https://${PROXY}/api/quota`);
    https.get({ hostname: u.hostname, path: u.pathname, headers: { "x-api-key": key } }, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => {
        const r = JSON.parse(d);
        console.log(`\n配额: ${r.used}/${r.quota} (剩余 ${r.remaining})\n`);
        resolve();
      });
    });
  });
}

async function deleteKey(key) {
  const r = await api("POST", "/admin/delete-key", { key });
  if (r.error) return console.log("❌", r.error);
  console.log("✅ 已删除:", key);
}

async function purge() {
  const r = await api("POST", "/admin/purge");
  if (r.error) return console.log("❌", r.error);
  console.log("✅ 已清空所有 Key");
}

// ========== Main ==========

const cmd = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (cmd) {
    case "list":
      await list();
      break;
    case "gen":
      await gen(args[0] || "未备注", args[1] || 100);
      break;
    case "batch":
      await batch(args[0] || 10, args[1] || 100, args[2] || "批量");
      break;
    case "renew":
      await renew(args[0], args[1] || 100);
      break;
    case "quota":
      await quota(args[0]);
      break;
    case "delete":
      await deleteKey(args[0]);
      break;
    case "purge":
      await purge();
      break;
    default:
      console.log(`
🔑 面试复盘 - Key 管理工具

用法: node admin-cli.mjs <命令> [参数]

命令:
  list                    查看所有 Key
  gen <标签> <配额>        生成一个 Key
  batch <数量> <配额> <前缀> 批量生成
  delete <Key>            删除单个
  renew <Key> <加配额>     续费
  quota <Key>             查配额
  purge                   清空全部
`);
  }
}

main().catch(e => console.error("❌", e.message));
