#!/usr/bin/env node
/**
 * bili-comments.mjs — B站视频评论抓取工具（零依赖，Node.js >= 18）
 *
 * 用法:
 *   node bili-comments.mjs <BV号或视频URL> [选项]
 *
 * 选项:
 *   --sort hot|time     排序方式：hot=按热度（默认），time=按时间
 *   --count N           抓取评论条数（默认 50，自动截断到视频评论总数上限）
 *   --out <目录>        输出目录（默认当前目录）
 *   --replies           同时抓取楼中楼回复（默认只抓楼层主评论）
 *
 * 示例:
 *   node bili-comments.mjs BV1Z7Kz6RE3o --sort time --count 200 --out ./out
 *   node bili-comments.mjs "https://www.bilibili.com/video/BV1Z7Kz6RE3o/" --count 100
 *
 * 输出:
 *   <视频标题>_评论<N>条_<hot|time>.csv  （UTF-8 带 BOM，Excel 可直接打开）
 *   <视频标题>_评论<N>条_<hot|time>.md   （表格形式，方便阅读）
 *
 * 原理:
 *   使用 B 站网页版公开接口（与浏览器前端同源）：
 *   - x/web-interface/view       用 BV 号换 aid、视频标题、评论总数
 *   - x/v2/reply/wbi/main        新版评论接口（wbi 签名，匿名可用）
 *   旧接口 x/v2/reply 匿名被限量（热评仅 3 条），故不使用。
 *
 * 合规提示:
 *   请遵守 B 站用户协议与 robots 规则，仅用于研究用途；
 *   脚本已内置请求间隔（约 1.1s/页），请勿调高频率以免触发风控。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PAGE_SIZE = 20;          // wbi/main 接口固定每页 20 条
const PAGE_DELAY_MS = 1100;    // 翻页间隔，避免触发风控

// ---------- wbi 签名 ----------
const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,
  33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,
  30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

async function getMixinKey() {
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { 'User-Agent': UA } });
  const j = await res.json();
  const { img_url, sub_url } = j.data.wbi_img;
  const raw = img_url.split('/').pop().split('.')[0] + sub_url.split('/').pop().split('.')[0];
  return MIXIN_KEY_ENC_TAB.map(i => raw[i]).join('').slice(0, 32);
}

function wbiSign(params, mixinKey) {
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(p).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return query + '&w_rid=' + crypto.createHash('md5').update(query + mixinKey).digest('hex');
}

// ---------- 工具函数 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseBV(input) {
  const m = String(input).match(/BV1[0-9A-Za-z]{9}/);
  if (!m) { console.error('错误：无法从输入中解析 BV 号 ->', input); process.exit(1); }
  return m[0];
}

// 过滤 Windows/macOS/Linux 文件名非法字符，防止无法保存
function sanitizeFilename(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '')   // 文件系统非法字符
    .replace(/\p{C}/gu, '')               // 控制字符
    .trim()
    .replace(/\.+$/, '')                  // Windows 不允许以点结尾
    .slice(0, 80) || 'untitled';          // 限制长度，防空名
}

const csvEscape = s => '"' + String(s ?? '').replace(/"/g, '""') + '"';
const fmtTime = ts => new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19);

// ---------- API ----------
async function fetchVideoInfo(bvid) {
  const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: { 'User-Agent': UA } });
  const j = await res.json();
  if (j.code !== 0) { console.error(`获取视频信息失败：${j.code} ${j.message}`); process.exit(1); }
  return j.data; // { aid, title, stat: { reply } }
}

async function fetchCommentPage({ oid, mixinKey, mode, offset, referer }) {
  const params = {
    oid, type: 1, mode, plat: 1, web_location: 1315875,
    pagination_str: JSON.stringify({ offset }),
  };
  const res = await fetch('https://api.bilibili.com/x/v2/reply/wbi/main?' + wbiSign(params, mixinKey),
    { headers: { 'User-Agent': UA, 'Referer': referer } });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`评论接口错误：${j.code} ${j.message}`);
  return j.data;
}

async function fetchSubReplies({ oid, rootId, referer }) {
  // 楼中楼接口（旧版，匿名对子评论分页可用）
  const out = [];
  for (let pn = 1; pn <= 10; pn++) {
    const url = `https://api.bilibili.com/x/v2/reply/reply?oid=${oid}&type=1&root=${rootId}&ps=10&pn=${pn}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': referer } });
    const j = await res.json();
    if (j.code !== 0 || !j.data?.replies?.length) break;
    out.push(...j.data.replies);
    if (j.data.replies.length < 10) break;
    await sleep(PAGE_DELAY_MS);
  }
  return out;
}

// ---------- 主流程 ----------
function parseArgs(argv) {
  const args = { input: null, sort: 'hot', count: 50, out: '.', replies: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sort') args.sort = argv[++i];
    else if (a === '--count') args.count = parseInt(argv[++i], 10);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--replies') args.replies = true;
    else if (!a.startsWith('--') && !args.input) args.input = a;
  }
  if (!args.input) { console.error('缺少 BV 号或视频 URL。用 --help 查看用法。'); process.exit(1); }
  if (!['hot', 'time'].includes(args.sort)) { console.error('--sort 只能是 hot 或 time'); process.exit(1); }
  if (!Number.isFinite(args.count) || args.count <= 0) { console.error('--count 必须是正整数'); process.exit(1); }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bvid = parseBV(args.input);
  const referer = `https://www.bilibili.com/video/${bvid}/`;

  console.error(`[1/3] 获取视频信息 ${bvid} ...`);
  const info = await fetchVideoInfo(bvid);
  const total = info.stat.reply;
  const target = Math.min(args.count, total);
  if (args.count > total) console.error(`提示：视频评论总数为 ${total}，已自动调整为抓 ${total} 条`);
  console.error(`      标题：${info.title} | UP主：${info.owner?.name ?? ''}（UID:${info.owner?.mid ?? ''}） | 评论总数：${total} | 本次抓取：${target} 条（${args.sort === 'hot' ? '按热度' : '按时间'}）`);

  console.error('[2/3] 抓取评论 ...');
  const mixinKey = await getMixinKey();
  const mode = args.sort === 'hot' ? 3 : 2;
  const comments = [];
  let offset = '', page = 0, isEnd = false;

  while (comments.length < target && !isEnd) {
    page++;
    let data;
    try {
      data = await fetchCommentPage({ oid: info.aid, mixinKey, mode, offset, referer });
    } catch (e) { console.error(`第 ${page} 页失败：${e.message}，停止。`); break; }
    const replies = data?.replies || [];
    isEnd = data?.cursor?.is_end === true;
    console.error(`      第 ${page} 页 +${replies.length} 条（累计 ${Math.min(comments.length + replies.length, target)}/${target}）`);
    for (const r of replies) {
      comments.push({
        no: comments.length + 1, type: '主评论', user: r.member?.uname ?? '',
        like: r.like ?? 0, time: fmtTime(r.ctime),
        content: (r.content?.message ?? '').replace(/\s+/g, ' ').trim(),
      });
      if (args.replies && r.rcount > 0) {
        const subs = await fetchSubReplies({ oid: info.aid, rootId: r.rpid, referer });
        for (const s of subs) {
          comments.push({
            no: comments.length + 1, type: `回复#${comments.length}`, user: s.member?.uname ?? '',
            like: s.like ?? 0, time: fmtTime(s.ctime),
            content: (s.content?.message ?? '').replace(/\s+/g, ' ').trim(),
          });
        }
      }
      if (comments.length >= target) break;
    }
    const next = data?.cursor?.pagination_reply?.next_offset;
    if (!next || !replies.length) break;
    offset = next;
    if (comments.length < target) await sleep(PAGE_DELAY_MS);
  }

  console.error('[3/3] 写出文件 ...');
  const base = sanitizeFilename(`${info.title}_评论${comments.length}条_${args.sort}`);
  fs.mkdirSync(args.out, { recursive: true });
  const csvPath = path.join(args.out, base + '.csv');
  const mdPath = path.join(args.out, base + '.md');

  const csv = ['\uFEFF序号,类型,用户,点赞数,时间,评论内容',
    ...comments.map(c => [c.no, csvEscape(c.type), csvEscape(c.user), c.like, csvEscape(c.time), csvEscape(c.content)].join(',')),
  ].join('\n');
  fs.writeFileSync(csvPath, csv);

  const md = [
    `# ${info.title} — B站评论 ${comments.length} 条`, '',
    `- 视频：https://www.bilibili.com/video/${bvid}/`,
    `- 排序：${args.sort === 'hot' ? '按热度' : '按时间'} | 抓取时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `- 范围：${args.replies ? '主评论 + 楼中楼回复' : '仅楼层主评论'}（评论总数 ${total}）`, '',
    '| 序号 | 类型 | 用户 | 点赞 | 时间 | 评论内容 |', '|---|---|---|---|---|---|',
    ...comments.map(c => `| ${c.no} | ${c.type} | ${c.user.replace(/\|/g, '\\|')} | ${c.like} | ${c.time} | ${c.content.replace(/\|/g, '\\|')} |`),
  ].join('\n');
  fs.writeFileSync(mdPath, md);

  console.log(JSON.stringify({ title: info.title, bvid, upName: info.owner?.name ?? '', upMid: info.owner?.mid ?? '', total, fetched: comments.length, csv: csvPath, md: mdPath }, null, 2));
}

main().catch(e => { console.error('失败：', e.message); process.exit(1); });
