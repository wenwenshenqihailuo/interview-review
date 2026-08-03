/**
 * 报告生成：写入 Obsidian vault
 */
import { App, Notice, TFile } from "obsidian";

export async function saveReport(
  app: App, report: string,
  meta: { company: string; position: string; round: string; type: string; language: string; interviewDate: string },
  settings: { reportFolder: string; autoOpenReport: boolean }
): Promise<TFile> {
  const dateStr = meta.interviewDate || new Date().toISOString().split("T")[0];
  const parts = [meta.company, meta.position, meta.round, dateStr].filter(Boolean);
  const name = parts.join("-") + ".md";
  const folder = settings.reportFolder.replace(/^\/+|\/+$/g, "");
  const filePath = folder ? `${folder}/${name}` : name;

  if (folder && !app.vault.getAbstractFileByPath(folder)) {
    await app.vault.createFolder(folder);
  }

  const header = `---
company: ${meta.company||"未提供"}
position: ${meta.position||"未提供"}
round: ${meta.round||"未提供"}
type: ${meta.type||"未提供"}
language: ${meta.language||"中英混合"}
date: ${dateStr}
plugin: interview-review
---

`;
  const content = header + report;
  const existing = app.vault.getAbstractFileByPath(filePath);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    new Notice(`已更新: ${filePath}`);
    return existing;
  }
  const file = await app.vault.create(filePath, content);
  new Notice(`报告已生成: ${filePath}`);
  if (settings.autoOpenReport) {
    await app.workspace.getLeaf(true).openFile(file);
  }
  return file;
}

export async function saveTranscript(
  app: App, transcript: string, meta: { company: string }, folder: string
): Promise<TFile> {
  const date = new Date().toISOString().split("T")[0];
  const c = meta.company ? `-${meta.company}` : "";
  const name = `面试文字稿${c}-${date}.md`;
  const cleanDir = folder.replace(/^\/+|\/+$/g, "");
  const filePath = cleanDir ? `${cleanDir}/${name}` : name;
  if (cleanDir && !app.vault.getAbstractFileByPath(cleanDir)) {
    await app.vault.createFolder(cleanDir);
  }
  const existing = app.vault.getAbstractFileByPath(filePath);
  if (existing instanceof TFile) { await app.vault.modify(existing, transcript); return existing; }
  return await app.vault.create(filePath, transcript);
}
