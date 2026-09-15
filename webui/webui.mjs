#!/usr/bin/env node
/**
 * webui.mjs — WebUI 启动器 / 守护进程（零依赖）
 *
 * 用法:
 *   node webui.mjs [端口]        （默认 5177，也可用 PORT 环境变量）
 *
 * 职责:
 *   - 以子进程方式拉起 server.mjs，并转发其日志
 *   - server.mjs 收到「重启换端口」请求时会写 .restart 标记文件后退出，
 *     本守护进程检测到标记即以新端口重新拉起（端口热切换）
 *   - server.mjs 直接退出且无标记（「停止服务」），守护进程一并退出、释放端口
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'server.mjs');
const RESTART_FLAG = path.join(__dirname, '.restart');

function start(port) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port) },
    cwd: __dirname,
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    let next = null;
    try {
      if (fs.existsSync(RESTART_FLAG)) {
        next = parseInt(fs.readFileSync(RESTART_FLAG, 'utf8').trim(), 10);
        fs.unlinkSync(RESTART_FLAG);
      }
    } catch { /* ignore */ }

    if (Number.isInteger(next) && next >= 1024 && next <= 65535) {
      console.log(`[webui] 端口切换 -> ${next}，重新拉起服务 ...`);
      start(next);
    } else {
      console.log(`[webui] 服务已退出（code ${code ?? 0}），端口已释放`);
      process.exit(code ?? 0);
    }
  });
}

const port = Number(process.argv[2]) || Number(process.env.PORT) || 5177;
console.log(`[webui] 启动服务，端口 ${port}`);
start(port);
