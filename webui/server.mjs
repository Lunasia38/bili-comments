#!/usr/bin/env node
/**
 * server.mjs — bili-comments.mjs 的本地 WebUI 服务（零依赖，Node.js >= 18）
 *
 * 用法:
 *   node server.mjs            （默认端口 5177，可用 PORT 环境变量覆盖）
 *
 *   推荐通过 webui.mjs 启动（支持页面内改端口热切换 / 停止服务）:
 *   node webui.mjs [端口]
 *
 * 说明:
 *   - 不修改 bili-comments.mjs，通过 child_process.spawn 以命令行参数方式调用
 *   - 子进程 stderr 的进度行 -> NDJSON 流式推给浏览器
 *   - 子进程 stdout 的最终 JSON -> 解析后作为 done 事件返回
 *   - 输出文件写入 ./output/，通过 /output/<文件名> 提供下载
 *   - /api/restart: 写 .restart 标记后退出，由 webui.mjs 以新端口重新拉起
 *   - /api/shutdown: 直接退出（无标记，守护进程一并退出，释放端口）
 *   - /api/heartbeat: 页面心跳看门狗。抓取任务进行中不会停服务（防浏览器
 *     睡眠标签页冻结页面导致误杀）；任务卡死（长时间无进展）时先回收任务，
 *     心跳计时重置为任务结束时刻，重新计一个完整 TTL 后仍无心跳才退出
 */
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_PATH = path.resolve(__dirname, "..", "bili-comments.mjs");
const OUT_DIR = path.join(__dirname, "output");
const PORT = Number(process.env.PORT) || 5177;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

// ---------- 页面心跳看门狗 ----------
// 前端每 5s 上报一次心跳；所有页面关闭后心跳停止，超过 TTL 即自动退出。
// 不用 beforeunload 的原因：刷新页面同样会触发该事件，无法区分「刷新」与「关闭」。
// 90s TTL 可容忍：浏览器后台标签页定时器节流（约 60s）、页面刷新间隙、短暂网络抖动。
// 收到第一个心跳之前看门狗不生效（浏览器尚未打开时不误杀）。
//
// 抓取任务进行中（busy）绝不退出：
// 心跳停可能只是页面被浏览器冻结（睡眠标签页/省内存模式/系统休眠），任务本身还活着。
// 此时若任务仍有进展输出就继续等；仅当任务也长时间无进展（判定卡死）才先 kill 回收任务，
// 回收后心跳计时重置为任务结束时刻——页面若只是冻结，会在新的 TTL 窗口内恢复心跳；
// 页面若确实已关闭，下一个 TTL 到期后再退出。
let lastHeartbeatAt = 0;
const HEARTBEAT_TTL_MS = Number(process.env.HEARTBEAT_TTL_MS) || 90_000;
// 任务卡死判定：正常抓取每翻一页（约 1.1s）都有进度输出，10 分钟无任何输出视为卡死
const TASK_STUCK_TIMEOUT_MS =
  Number(process.env.TASK_STUCK_TIMEOUT_MS) || 10 * 60_000;

let busy = false; // 单任务互斥，避免并发请求触发 B 站风控
let taskChild = null; // 当前抓取子进程（卡死回收用；同时防止旧进程迟到事件误复位新任务）
let taskLastProgressAt = 0; // 任务最近一次有输出（stderr 进度行 / stdout 数据）的时间
let lastFrozenLogAt = 0; // 「页面冻结但任务存活」日志节流，避免每 5s 刷屏

setInterval(() => {
  if (!lastHeartbeatAt) return;
  if (Date.now() - lastHeartbeatAt <= HEARTBEAT_TTL_MS) return;

  if (busy) {
    const stuckFor = Date.now() - taskLastProgressAt;
    if (stuckFor <= TASK_STUCK_TIMEOUT_MS) {
      // 页面可能被冻结（心跳停）但抓取仍在推进：不杀服务，等任务自然结束
      if (Date.now() - lastFrozenLogAt > 60_000) {
        lastFrozenLogAt = Date.now();
        console.log(
          `[server] 页面心跳超时，但抓取任务仍在进行（最近进展 ${Math.round(stuckFor / 1000)}s 前），暂不停止服务`,
        );
      }
      return;
    }
    // 极端情况：页面无心跳且任务长时间无进展 → 判定任务卡死。
    // kill 后 child 的 close 事件里的 endTask 会复位 busy 并把
    // lastHeartbeatAt 重置为任务结束时刻（重新计一个完整 TTL）。
    console.log(
      `[server] 页面心跳超时且抓取任务 ${Math.round(TASK_STUCK_TIMEOUT_MS / 60000)} 分钟无进展，判定任务卡死，终止任务并重置心跳计时`,
    );
    const victim = taskChild;
    try {
      if (victim && !victim.killed) victim.kill();
    } catch {
      /* ignore */
    }
    // 立即重置心跳计时：给页面一个完整 TTL 自证存活，同时避免看门狗
    // 在 close 事件到达前反复进入本分支、重复 kill / 重复打日志
    lastHeartbeatAt = Date.now();
    // 兜底：若 close 事件因故未触发，10s 后强制复位，避免 busy 永远卡死
    setTimeout(() => {
      if (taskChild === victim) {
        taskChild = null;
        busy = false;
        lastHeartbeatAt = Date.now();
      }
    }, 10_000).unref();
    return;
  }

  console.log(
    `[server] ${Math.round(HEARTBEAT_TTL_MS / 1000)}s 未收到页面心跳，判定 WebUI 页面已全部关闭，自动停止服务并释放端口`,
  );
  process.exit(0); // 无 .restart 标记，守护进程一并退出
}, 5000).unref();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (
    req.method === "GET" &&
    (url.pathname === "/" || url.pathname === "/index.html")
  ) {
    return serveStatic(res, path.join(__dirname, "index.html"));
  }

  if (req.method === "GET" && url.pathname.startsWith("/output/")) {
    // path.basename 防目录穿越
    const name = path.basename(
      decodeURIComponent(url.pathname.slice("/output/".length)),
    );
    return serveStatic(res, path.join(OUT_DIR, name));
  }

  if (req.method === "POST" && url.pathname === "/api/fetch") {
    return handleFetch(req, res);
  }

  if (req.method === "POST" && url.pathname === "/api/shutdown") {
    return handleShutdown(req, res);
  }

  if (req.method === "POST" && url.pathname === "/api/restart") {
    return handleRestart(req, res);
  }

  if (req.method === "POST" && url.pathname === "/api/heartbeat") {
    lastHeartbeatAt = Date.now();
    return sendJson(res, 200, { ok: true });
  }

  send(res, 404, "Not Found");
});

// 长任务：放宽请求超时
server.requestTimeout = 0;
server.headersTimeout = 60000;

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type || "text/plain; charset=utf-8",
  });
  res.end(body);
}

function serveStatic(res, filePath) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile())
      return send(res, 404, "Not Found");
    const ext = path.extname(filePath).toLowerCase();
    send(
      res,
      200,
      fs.readFileSync(filePath),
      MIME[ext] || "application/octet-stream",
    );
  } catch {
    send(res, 500, "Internal Server Error");
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), "application/json; charset=utf-8");
}

// 检查端口是否可绑定（空闲）
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

// 停止服务，释放端口
function handleShutdown(req, res) {
  if (busy)
    return sendJson(res, 409, {
      ok: false,
      message: "有抓取任务正在进行，请等它完成后再停止服务",
    });
  sendJson(res, 200, { ok: true });
  setTimeout(() => process.exit(0), 300); // 等响应送达后再退出
}

// 以新端口重启：写 .restart 标记文件 -> 退出；由 webui.mjs 守护进程以新端口重新拉起
async function handleRestart(req, res) {
  if (busy)
    return sendJson(res, 409, {
      ok: false,
      message: "有抓取任务正在进行，请等它完成后再重启",
    });
  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    /* ignore */
  }
  const port = parseInt(body.port, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return sendJson(res, 400, {
      ok: false,
      message: "端口必须是 1024–65535 的整数",
    });
  }
  if (port === PORT) {
    return sendJson(res, 400, { ok: false, message: "新端口与当前端口相同" });
  }
  if (!(await portFree(port))) {
    return sendJson(res, 409, { ok: false, message: `端口 ${port} 已被占用` });
  }

  // 通知守护进程（webui.mjs）以新端口拉起新实例
  fs.writeFileSync(path.join(__dirname, ".restart"), String(port), "utf8");
  sendJson(res, 200, { ok: true, port });
  setTimeout(() => process.exit(0), 400); // 等响应送达后再退出
}

async function handleFetch(req, res) {
  const ndjson = (obj) => {
    if (!res.destroyed && !res.writableEnded)
      res.write(JSON.stringify(obj) + "\n");
  };

  if (busy) {
    res.writeHead(409, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
    });
    res.end(
      JSON.stringify({
        type: "error",
        message: "已有一个抓取任务正在进行，请等它完成后再试",
      }) + "\n",
    );
    return;
  }

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    /* ignore */
  }

  const input = String(body.input || "").trim();
  const sort = body.sort === "time" ? "time" : "hot";
  const count = Math.min(9999999, Math.max(1, parseInt(body.count, 10) || 50));
  const replies = !!body.replies;

  if (!/BV1[0-9A-Za-z]{9}/.test(input)) {
    res.writeHead(400, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
    });
    res.end(
      JSON.stringify({
        type: "error",
        message: "请输入包含 BV 号的视频链接或 BV 号",
      }) + "\n",
    );
    return;
  }

  busy = true;
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
  });

  // 以命令行参数调用原脚本，不做任何修改
  const args = [
    TOOL_PATH,
    input,
    "--sort",
    sort,
    "--count",
    String(count),
    "--out",
    OUT_DIR,
  ];
  if (replies) args.push("--replies");

  const child = spawn(process.execPath, args, { cwd: __dirname });
  taskChild = child;
  taskLastProgressAt = Date.now();

  // 任务结束统一复位（正常完成 / 异常退出 / 被中断共用）：
  // 幂等，且只认当前子进程——防止 error/close 重复触发或旧进程迟到的事件误复位新任务。
  // 复位时把心跳计时重置为任务结束时刻，看门狗从此刻重新计一个完整 TTL，
  // 保证「任务刚结束、页面还活着但心跳恰好断过」时服务不会被立刻误杀。
  const endTask = () => {
    if (taskChild !== child) return;
    taskChild = null;
    busy = false;
    lastHeartbeatAt = Date.now();
  };

  // 客户端断开时终止子进程（复位由 close 事件里的 endTask 完成）
  req.on("close", () => {
    if (!child.killed && busy) child.kill();
  });

  // stderr: 进度日志流式转发（每行都算任务进展，供卡死判定）
  const rl = readline.createInterface({ input: child.stderr });
  rl.on("line", (line) => {
    taskLastProgressAt = Date.now();
    ndjson({ type: "log", line });
  });

  // stdout: 最终结果 JSON
  let stdout = "";
  child.stdout.on("data", (c) => {
    taskLastProgressAt = Date.now();
    stdout += c;
  });

  child.on("error", (e) => {
    endTask();
    ndjson({ type: "error", message: `无法启动抓取进程：${e.message}` });
    res.end();
  });

  child.on("close", (code) => {
    endTask();
    if (code === 0) {
      try {
        const r = JSON.parse(stdout);
        ndjson({
          type: "done",
          result: {
            title: r.title,
            bvid: r.bvid,
            upName: r.upName,
            upMid: r.upMid,
            total: r.total,
            fetched: r.fetched,
            csv: path.basename(r.csv),
            md: path.basename(r.md),
          },
        });
      } catch {
        ndjson({ type: "error", message: "任务完成，但解析结果失败" });
      }
    } else {
      ndjson({
        type: "error",
        message: `抓取进程退出（退出码 ${code}），详情见上方日志`,
      });
    }
    if (!res.destroyed) res.end();
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`B站评论抓取 WebUI 已启动: http://localhost:${PORT}`);
  console.log(`调用脚本: ${TOOL_PATH}`);
  console.log(`输出目录: ${OUT_DIR}`);
});
