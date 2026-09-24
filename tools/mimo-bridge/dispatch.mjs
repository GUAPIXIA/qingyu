#!/usr/bin/env node
/**
 * DSH → Xiaomi MiMo 任务派发器.
 *
 * 把 agent-task-bridge 格式的任务包交给本机无头 MiMo agent 执行，并回传自包含回执。
 * 底层是 `mimo run --format json`（MiMoCode CLI），cwd = 任务包里的 workspace。
 *
 * 用法:
 *   node dispatch.mjs --workspace <绝对路径> --summary <一句话> --goal <目标> \
 *        [--requirement r]... [--acceptance a]... [--constraint c]... \
 *        [--id ATB-YYYYMMDD-NNN] [--from NAME] [--priority P0|P1|P2] \
 *        [--model xiaomi/mimo-v2.6-pro] [--agent build] \
 *        [--session ses_xxx | --continue] [--timeout ms] [--yolo] [--json]
 *   node dispatch.mjs --prompt "原始指令" --workspace <绝对路径> [同上]
 *
 * 退出码: 0 = MiMo 正常返回；1 = 参数/环境错误或超时；2 = MiMo 返回错误。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(HERE, "state.json");
const LOG_DIR = path.join(HERE, "logs");
const DEFAULT_MODEL = "xiaomi/mimo-v2.6-pro";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = { requirement: [], acceptance: [], constraint: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`无法识别的参数: ${a}`);
    const key = a.slice(2);
    const takesValue = !["continue", "yolo", "json", "help"].includes(key);
    const value = takesValue ? argv[++i] : true;
    if (takesValue && value === undefined) throw new Error(`参数 --${key} 缺少取值`);
    if (key === "requirement" || key === "acceptance" || key === "constraint") out[key].push(value);
    else out[key] = value;
  }
  return out;
}

const USAGE = `DSH → MiMo 派发器
  --workspace <绝对路径>            必填：MiMo 执行编码任务的目录
  --summary <一句话>                必填（或用 --prompt 传原始指令）
  --goal <目标>                     必填
  --requirement <要求>              可重复
  --acceptance <验收>               可重复
  --constraint <约束>               可重复（如「不要 git push」）
  --id / --from / --priority        任务包元数据
  --model <provider/model>          默认 ${DEFAULT_MODEL}
  --agent <build|plan|compose>      MiMo agent
  --session <ses_xxx> | --continue  续接既有 MiMo 会话
  --timeout <ms>                    默认 ${DEFAULT_TIMEOUT_MS}
  --yolo                            传给 MiMo --dangerously-skip-permissions（危险）
  --json                            输出机器可读 JSON
`;

// ---------- 任务包 ----------
function buildPacket(a) {
  const lines = ["【任务委托】"];
  if (a.id) lines.push(`id: ${a.id}`);
  lines.push(`from: ${a.from ?? "DSH (DeepSeek Harness)"}`);
  lines.push(`priority: ${a.priority ?? "P1"}`);
  lines.push(`workspace: ${a.workspace}`);
  lines.push(`summary: ${a.summary}`);
  lines.push("## 目标", a.goal);
  lines.push("## 要求", ...a.requirement.map((r) => `- ${r}`));
  lines.push("## 验收", ...a.acceptance.map((r) => `- ${r}`));
  if (a.constraint.length) lines.push("## 约束", ...a.constraint.map((r) => `- ${r}`));
  lines.push("## 回传", "结果摘要 + 产物路径(file:line) + 执行的验证命令与输出 + 未完成项");
  return lines.join("\n") + "\n";
}

// ---------- 事件流解析 ----------
function parseEvents(ndjson) {
  const res = { texts: [], sessionID: null, error: null, types: {}, toolCalls: 0, bad: 0 };
  for (const line of ndjson.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      res.bad++;
      continue;
    }
    const kind = ev.type ?? "unknown";
    res.types[kind] = (res.types[kind] ?? 0) + 1;
    if (kind === "tool" || kind === "tool_call" || kind === "tool_use") res.toolCalls++;
    if (kind === "error" || typeof ev.error === "string") {
      res.error = typeof ev.error === "string" ? ev.error : JSON.stringify(ev.error);
    }
    const text = ev.part?.text ?? ev.text ?? null;
    if (kind === "text" && typeof text === "string") res.texts.push(text);
    const sid = JSON.stringify(ev).match(/"(ses_[A-Za-z0-9]+)"/);
    if (sid) res.sessionID = sid[1];
  }
  return res;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** 解析 MiMoCode CLI 启动器；用 node 直跑可保留参数边界（Windows shell 会吃掉换行与引号）。 */
function resolveLauncher() {
  const candidates = [
    process.env.MIMO_LAUNCHER,
    path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@mimo-ai", "cli", "bin", "mimo"),
    "/usr/local/lib/node_modules/@mimo-ai/cli/bin/mimo",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return { cmd: process.execPath, prefix: [c], shell: false };
  }
  return { cmd: "mimo", prefix: [], shell: process.platform === "win32" };
}
function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- 主流程 ----------
async function main() {
  let a;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    return 1;
  }
  if (a.help) {
    console.log(USAGE);
    return 0;
  }

  // workspace 必须是存在的绝对目录（协议硬要求，不猜路径）
  if (!a.workspace) {
    console.error("缺少 --workspace（绝对路径）。任务包不完整，拒绝执行。\n\n" + USAGE);
    return 1;
  }
  if (!path.isAbsolute(a.workspace)) {
    console.error(`--workspace 必须是绝对路径: ${a.workspace}`);
    return 1;
  }
  if (!fs.existsSync(a.workspace) || !fs.statSync(a.workspace).isDirectory()) {
    console.error(`--workspace 不存在或不是目录: ${a.workspace}`);
    return 1;
  }
  if (!a.prompt && !a.summary) {
    console.error("缺少 --summary 或 --prompt。\n\n" + USAGE);
    return 1;
  }
  if (!a.prompt && !a.goal) {
    console.error("缺少 --goal。\n\n" + USAGE);
    return 1;
  }

  const model = a.model ?? DEFAULT_MODEL;
  const timeoutMs = Number(a.timeout ?? DEFAULT_TIMEOUT_MS);
  const state = readState();

  // 续接既有会话
  let session = a.session ?? null;
  if (!session && a.continue && a.id && state[a.id]?.sessionID) session = state[a.id].sessionID;
  if (!session && a.continue) session = state.__last?.sessionID ?? null;

  const message = a.prompt ? String(a.prompt) : buildPacket(a);

  const args = ["run", "--format", "json", "-m", model];
  if (a.agent) args.push("--agent", String(a.agent));
  args.push("--title", String(a.id ?? a.summary ?? "DSH task"));
  if (session) args.push("--session", session);
  if (a.yolo) args.push("--dangerously-skip-permissions");
  args.push(message);

  // 优先用 node 直接跑 CLI launcher：argv 以数组传递，避免 Windows shell 破坏任务包里的换行/引号
  const launcher = resolveLauncher();
  const started = Date.now();
  const child = spawn(launcher.cmd, [...launcher.prefix, ...args], {
    cwd: a.workspace,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: launcher.shell,
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {}
  }, timeoutMs);

  child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
  child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

  const code = await new Promise((resolve) => {
    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      resolve(-1);
    });
    child.on("close", resolve);
  });
  clearTimeout(timer);
  const durationMs = Date.now() - started;

  // 落日志，便于追溯
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${(a.id ?? "task").replace(/[^\w.-]/g, "_")}-${started}.log`);
  fs.writeFileSync(logPath, `# args: ${JSON.stringify(args.slice(0, -1))}\n# code=${code}\n\n## stdout\n${stdout}\n\n## stderr\n${stderr}\n`);

  const parsed = parseEvents(stdout);
  const reply = parsed.texts.join("\n").trim();
  const status = timedOut ? "受阻" : parsed.error || code !== 0 ? "受阻" : reply ? "完成" : "受阻";
  const reason = timedOut
    ? `超过 ${timeoutMs}ms 未返回，已终止`
    : parsed.error ?? (code !== 0 ? `mimo 退出码 ${code}` : reply ? null : "MiMo 未返回文本");

  // 记录会话，供后续 --continue 续接
  const sid = parsed.sessionID;
  if (sid) {
    state.__last = { sessionID: sid, at: new Date().toISOString(), workspace: a.workspace };
    if (a.id) state[a.id] = { sessionID: sid, at: new Date().toISOString(), workspace: a.workspace };
    writeState(state);
  }

  if (a.json) {
    console.log(
      JSON.stringify(
        { ok: status === "完成", id: a.id ?? null, status, model, sessionID: sid, workspace: a.workspace, durationMs, toolCalls: parsed.toolCalls, reason, reply, logPath },
        null,
        2,
      ),
    );
  } else {
    console.log(`【任务回执】id: ${a.id ?? "(未指定)"} | 状态: ${status}`);
    console.log(`## 结果`);
    console.log(reply || `（无文本回复）${reason ? `\n原因: ${reason}` : ""}`);
    console.log(`## 产物`);
    console.log(`- MiMo 会话: ${sid ?? "(未捕获)"}${sid ? "（可用 --session 续接）" : ""}`);
    console.log(`- workspace: ${a.workspace}`);
    console.log(`- 模型: ${model} | 工具调用: ${parsed.toolCalls} 次 | 耗时: ${(durationMs / 1000).toFixed(1)}s`);
    console.log(`- 事件日志: ${logPath}`);
    console.log(`## 未完成 / 下一步`);
    console.log(
      reason
        ? reason
        : "验收点由 MiMo 自述，DSH 侧需按 ## 验收 自行复核（这是回执，不是已验证结论）。",
    );
  }

  return status === "完成" ? 0 : parsed.error || code !== 0 ? 2 : 1;
}

main().then((c) => process.exit(c));
