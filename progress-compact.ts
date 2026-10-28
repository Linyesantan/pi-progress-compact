/**
 * progress-compact: 实时进度照常在 TUI 里滚动，但交给模型的 bash 结果
 * 会把进度刷新（%、ETA、速度、Transferred 等）折叠成"最后一帧"，不吃上下文。
 * 原始完整输出：pi 截断时用它的 fullOutputPath，否则另存 /tmp/pi-progress-*.log。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const PROGRESS =
  /\d(\.\d+)?\s*%|\bETA\b|\d\s*[KMGT]?i?B\/s|\bit\/s\b|Elapsed time:|Transferred:|Transferring:|^\s*\*\s+\S+:\s*\d|\[[#=>\- ]{5,}\]|━|█|--:--:--|\b\d+:\d\d:\d\d\s+\d+:\d\d:\d\d\b/;
const KEEP_LAST = 6; // 每段进度保留最后几行（最后一帧）

export function compact(text: string): { out: string; folded: number } | null {
  const lines = text
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split(/[\r\n]/)
    // rclone 等清屏重绘时 ANSI 被剥掉后帧会粘连，在常见帧头前补换行
    .flatMap((l) => l.replace(/(\S)(Transferred:|Elapsed time:|Transferring:|Checks:|Errors:)/g, "$1\n$2").split("\n"))
    .filter((l) => l.trim() !== "");
  const prog = lines.filter((l) => PROGRESS.test(l)).length;
  if (lines.length < 40 || prog < 20) return null;

  const out: string[] = [];
  let run: string[] = [];
  let folded = 0;
  const flush = () => {
    if (!run.length) return;
    if (run.length > KEEP_LAST) {
      folded += run.length - KEEP_LAST;
      out.push(`[… ${run.length - KEEP_LAST} 行进度刷新已折叠，以下为最后一帧]`);
      out.push(...run.slice(-KEEP_LAST));
    } else out.push(...run);
    run = [];
  };
  for (const l of lines) {
    if (PROGRESS.test(l)) run.push(l);
    else {
      flush();
      out.push(l);
    }
  }
  flush();
  return { out: out.join("\n"), folded };
}

// ── 实时网速/进度状态栏（只显示在界面底部，不进上下文）──
const IFACE = /^(en|eth|wl|ww)/;
function netBytes(): [number, number] {
  try {
    let rx = 0, tx = 0;
    for (const l of readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
      const m = l.trim().match(/^([^:]+):\s*(.*)$/);
      if (!m || !IFACE.test(m[1])) continue;
      const f = m[2].trim().split(/\s+/).map(Number);
      rx += f[0]; tx += f[8];
    }
    return [rx, tx];
  } catch { return [0, 0]; }
}
const fmt = (b: number) =>
  b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + "GB" : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + "MB" : (b / 1024).toFixed(0) + "KB";
const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const lastPct = (t: string) => {
  const m = t.slice(-600).replace(ANSI, "").match(/(\d{1,3}(?:\.\d+)?)\s*%(?!.*\d\s*%)/s);
  if (m && Number(m[1]) <= 100) return m[1] + "%";
  // curl 默认进度表：行首第一列就是百分比
  const rows = t.slice(-600).replace(ANSI, "").split(/[\r\n]/).filter((l) => /^\s*\d{1,3}\s+[\d.]+[kMGT]?\s+\d{1,3}\s+[\d.]+[kMGT]?\s/.test(l));
  const c = rows.length ? rows[rows.length - 1].trim().split(/\s+/)[0] : "";
  return c && Number(c) <= 100 ? c + "%" : "";
};

// ── scp 套伪终端才会打印进度；gh 下载按产物总大小估算百分比 ──
const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
function wrapScp(cmd: string): string {
  if (!/(^|[\s;&|(])scp\s/.test(cmd) || /PI_PTY_WRAPPED/.test(cmd)) return cmd;
  // 有了伪终端后 ssh 会在终端里等密码/确认指纹导致卡死；没用 sshpass 时强制走 askpass(false) 直接失败，和原来一样
  const ask = /\bsshpass\b/.test(cmd) ? "" : "SSH_ASKPASS=/bin/false SSH_ASKPASS_REQUIRE=force ";
  return `PI_PTY_WRAPPED=1 ${ask}SHELL=/bin/bash script -qefc ${shq(cmd)} /dev/null`;
}
function sh(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((res) =>
    execFile(cmd, args, { cwd, timeout: 15000 }, (err, out) => res(err ? "" : String(out).trim())));
}
function argOf(words: string[], ...flags: string[]): string[] {
  const r: string[] = [];
  words.forEach((w, i) => {
    for (const f of flags) {
      if (w === f && words[i + 1]) r.push(words[i + 1]);
      else if (w.startsWith(f + "=")) r.push(w.slice(f.length + 1));
    }
  });
  return r;
}
const globRe = (g: string) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
async function ghTotal(cmd: string, cwd: string): Promise<number> {
  const m = cmd.match(/\bgh\s+(run|release)\s+download\b([^;&|]*)/);
  if (!m) return 0;
  const words = m[2].trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, ""));
  const repo = argOf(words, "-R", "--repo")[0];
  const pos = words.filter((w, i) => !w.startsWith("-") && !/^-/.test(words[i - 1] ?? ""));
  if (m[1] === "run") {
    const id = pos[0];
    if (!id) return 0;
    const names = argOf(words, "-n", "--name");
    const r = repo ?? "{owner}/{repo}";
    const out = await sh("gh", ["api", `repos/${r}/actions/runs/${id}/artifacts`, "--jq",
      ".artifacts[] | select(.expired|not) | [.name, .size_in_bytes] | @tsv"], cwd);
    return out.split("\n").filter(Boolean).map((l) => l.split("\t"))
      .filter(([n]) => !names.length || names.includes(n)).reduce((a, [, b]) => a + Number(b), 0);
  }
  const tag = pos[0];
  const pats = argOf(words, "-p", "--pattern").map(globRe);
  const args = ["release", "view", ...(tag ? [tag] : []), ...(repo ? ["-R", repo] : []), "--json", "assets", "--jq", ".assets[] | [.name, .size] | @tsv"];
  const out = await sh("gh", args, cwd);
  return out.split("\n").filter(Boolean).map((l) => l.split("\t"))
    .filter(([n]) => !pats.length || pats.some((re) => re.test(n))).reduce((a, [, b]) => a + Number(b), 0);
}

function installMeter(pi: ExtensionAPI) {
  pi.on("tool_call", async (e: any) => {
    if (e.toolName !== "bash" || typeof e.input?.command !== "string") return;
    e.input.command = wrapScp(e.input.command);
  });
  type Job = { t0: number; rx0: number; tx0: number; prx: number; ptx: number; pt: number; pct: string; est?: string; total: number; timer: any };
  const jobs = new Map<string, Job>();
  const KEY = "dl-meter";
  pi.on("tool_execution_start", async (e: any, ctx: any) => {
    if (e.toolName !== "bash" || !ctx.hasUI) return;
    const [rx, tx] = netBytes();
    const now = Date.now();
    const j: Job = { t0: now, rx0: rx, tx0: tx, prx: rx, ptx: tx, pt: now, pct: "", total: 0, timer: null };
    const cmd = String(e.args?.command ?? "");
    if (/\bgh\s+(run|release)\s+download\b/.test(cmd)) ghTotal(cmd, ctx.cwd ?? process.cwd()).then((t) => (j.total = t));
    j.timer = setInterval(() => {
      const [r, t] = netBytes();
      const n = Date.now();
      const dt = Math.max((n - j.pt) / 1000, 0.001);
      const down = (r - j.prx) / dt, up = (t - j.ptx) / dt;
      j.prx = r; j.ptx = t; j.pt = n;
      const el = (n - j.t0) / 1000;
      if (j.total > 0 && !j.pct) {
        const p = Math.min(99, ((r - j.rx0) / j.total) * 100);
        j.est = `≈${p.toFixed(0)}%/${fmt(j.total)}`;
      }
      const pctTxt = j.pct || j.est;
      const busy = down > 30 * 1024 || up > 30 * 1024 || pctTxt;
      if (el < 2 || !busy) return ctx.ui.setStatus(KEY, undefined);
      ctx.ui.setStatus(KEY,
        `⬇ ${fmt(down)}/s ⬆ ${fmt(up)}/s · 收${fmt(r - j.rx0)} 发${fmt(t - j.tx0)}${pctTxt ? " · " + pctTxt : ""} · ${fmtT(el)}`);
    }, 1000);
    jobs.set(e.toolCallId, j);
  });
  pi.on("tool_execution_update", async (e: any) => {
    const j = jobs.get(e.toolCallId);
    if (!j) return;
    const c = e.partialResult?.content;
    const txt = Array.isArray(c) ? c.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("\n") : "";
    const p = lastPct(txt);
    if (p) j.pct = p;
  });
  pi.on("tool_execution_end", async (e: any, ctx: any) => {
    const j = jobs.get(e.toolCallId);
    if (!j) return;
    clearInterval(j.timer);
    jobs.delete(e.toolCallId);
    if (!jobs.size && ctx.hasUI) ctx.ui.setStatus(KEY, undefined);
  });
}

export default function (pi: ExtensionAPI) {
  installMeter(pi);
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash") return;
    const texts = event.content.filter((c: any) => c.type === "text");
    if (texts.length !== event.content.length) return;
    const raw = texts.map((c: any) => c.text).join("\n");
    const r = compact(raw);
    if (!r) return;
    let note = "";
    const full = (event as any).details?.fullOutputPath;
    if (!full) {
      const p = `/tmp/pi-progress-${Date.now()}.log`;
      try {
        writeFileSync(p, raw);
        note = `\n[原始输出: ${p}]`;
      } catch {}
    }
    return { content: [{ type: "text", text: r.out + note }] };
  });
}
