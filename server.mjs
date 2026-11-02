import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  ROOT, CASES_DIR, STATUSES, listCases, readCase, writeCase, normalize, applyPatch, addLog, readMemory, readReport, readReportSibling, reportMtime, readDirLabels, readDirColors, readConfig, readLinks, readLinkFile, INBOX_DIR, listInbox, readInbox, addAnswer,
} from './lib.mjs';

const PORT = Number(process.env.PORT || 4747);
const HOST = '127.0.0.1'; // 案件名・顧客名が載るので LAN には出さない
const clients = new Set();
// 安全モード（data/config.json の {"safe": true}）。VS Code のドック・INBOX・LINKS・メモリ表示・Google Fonts を止める
const SAFE = readConfig().safe === true;

// 他のサイトから読まれたり（DNS リバインディング）書き換えられたり（CSRF）しないよう、自分の画面からの要求だけ受ける
const ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
function allowed(req) {
  if (!ORIGINS.includes(`http://${req.headers.host}`)) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  return (!origin || ORIGINS.includes(origin)) && /^application\/json/.test(req.headers['content-type'] || '');
}
const FONT_LINKS = /<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>\n?/g;

// Artifact 向けに書いた HTML は、表示側が足す基本スタイル（画像を幅に収める）を前提にしている。
// 同じものを head の先頭に入れて、レポート自身の CSS で上書きできるようにする
const REPORT_BASE = '<style>img,video{max-width:100%;height:auto}</style>';
const withReportBase = (html, extra = '') => (/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + REPORT_BASE + extra) : REPORT_BASE + extra + html);
// 別タブで全画面表示したレポートは、自分で更新を待って読み直す（ボードの中の iframe はボード側が読み直す）
const reportLive = (id, at) => `<script>if(top===self)new EventSource('/api/events').addEventListener('cases',(e)=>{const c=JSON.parse(e.data).cases.find((x)=>x.id===${JSON.stringify(id)});if(c&&c.report_at!==${at})location.reload()})</script>`;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function snapshot() {
  const links = SAFE ? [] : readLinks().map((l, i) => ({ title: l.title, url: /^https?:\/\//.test(l.url || '') ? l.url : `/link/${i}/` }));
  const inbox = SAFE ? [] : listInbox().map((f) => ({ ...f, url: `/inbox/${encodeURIComponent(f.name)}` }));
  return { safe: SAFE, statuses: STATUSES, dirLabels: readDirLabels(), dirColors: readDirColors(), links, inbox, cases: listCases().map((c) => ({ ...c, report_at: reportMtime(c.report) })), at: new Date().toISOString() };
}

// VS CODE ボタンの行き先。いま開いているウィンドウ（VS Code の storage.json の記録）に合わせる
const VSCODE_APP = '/Applications/Visual Studio Code.app';
const VSCODE_STATE = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'storage.json');
const fromUri = (u) => decodeURIComponent(new URL(u).pathname);
function workspaceFolders(config) {
  const text = fs.readFileSync(config, 'utf8');
  let folders;
  try { folders = JSON.parse(text).folders.map((f) => f.path); } catch { folders = [...text.matchAll(/"path"\s*:\s*"([^"]+)"/g)].map((m) => m[1]); }
  return folders.map((p) => path.resolve(path.dirname(config), p));
}
function vscodeCommand(abs) {
  let windows = [];
  try { windows = JSON.parse(fs.readFileSync(VSCODE_STATE, 'utf8')).windowsState?.openedWindows || []; } catch {}
  // フォルダ1つで開いているウィンドウ → フォルダを開けばそのウィンドウが前に出る
  if (windows.some((w) => w.folder && fromUri(w.folder) === abs)) return ['open', ['-a', VSCODE_APP, abs]];
  // 複数フォルダをまとめたワークスペースの中にあるとき
  for (const w of windows) {
    const conf = w.workspaceIdentifier?.configURIPath;
    if (!conf) continue;
    const config = fromUri(conf);
    try { if (!workspaceFolders(config).includes(abs)) continue; } catch { continue; }
    // 保存済みの .code-workspace ならそれを開く
    if (config.endsWith('.code-workspace')) return ['open', ['-a', VSCODE_APP, config]];
    // 名前のないワークスペースは開き直せないので、中のファイルを1つ開いてそのウィンドウに着地させる
    // （vscode:// のリンクはファイルを含むフォルダを開いているウィンドウを選ぶ。open -a だと新しいウィンドウになる。code コマンドより速い）
    const file = ['CLAUDE.md', 'README.md'].map((n) => path.join(abs, n)).find((f) => fs.existsSync(f));
    if (file) return ['open', [`vscode://file${encodeURI(file)}`]];
  }
  // どこにも開いていなければ、新しいウィンドウで開く
  return ['open', ['-a', VSCODE_APP, abs]];
}

function broadcast() {
  const payload = `event: cases\ndata: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(payload);
}

// CLI や別チャットの Claude がファイルを直接書き換えても画面へ流す
fs.mkdirSync(CASES_DIR, { recursive: true });
let timer = null;
const changed = () => {
  clearTimeout(timer);
  timer = setTimeout(broadcast, 150);
};
fs.watch(CASES_DIR, changed);
fs.mkdirSync(INBOX_DIR, { recursive: true });
fs.watch(INBOX_DIR, changed);
// 現在地レポートは案件フォルダの外にあり、書き方によって fs.watch が取りこぼすので更新時刻を見回る
let reportSig = '';
setInterval(() => {
  const sig = listCases().map((c) => `${c.id}:${reportMtime(c.report)}`).join('|');
  if (reportSig && sig !== reportSig) changed();
  reportSig = sig;
}, 1500);

const server = http.createServer(async (req, res) => {
  // 他のサイトの iframe に埋め込ませない（クリックをだまし取られないように）。種類の推測もさせない
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  // 安全モードでは、コマンドの起動とホームのファイルを配信する経路を閉じる
  if (SAFE && (/^\/(inbox|link)\//.test(url.pathname) || ['/api/vscode', '/api/answers', '/api/memory'].includes(url.pathname))) return send(res, 404, { error: 'not found' });
  const m = url.pathname.match(/^\/api\/cases\/([^/]+)$/);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
      return send(res, 200, SAFE ? html.replace(FONT_LINKS, '') : html, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/cases') return send(res, 200, snapshot());
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: cases\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/cases') {
      const body = await readBody(req);
      if (readCase(body.id)) return send(res, 409, { error: `${body.id} は既にあります` });
      const c = addLog(normalize(body), '案件を登録');
      return send(res, 201, writeCase(c));
    }
    if (m && req.method === 'GET') {
      const c = readCase(m[1]);
      return c ? send(res, 200, c) : send(res, 404, { error: 'not found' });
    }
    if (m && req.method === 'PATCH') {
      const c = readCase(m[1]);
      if (!c) return send(res, 404, { error: 'not found' });
      return send(res, 200, writeCase(applyPatch(c, await readBody(req))));
    }
    const rm = url.pathname.match(/^\/report\/([^/]+)$/);
    if (rm && req.method === 'GET') {
      const report = readCase(rm[1])?.report;
      const html = readReport(report);
      return html == null ? send(res, 404, 'レポートが見つかりません', 'text/plain; charset=utf-8') : send(res, 200, withReportBase(html, reportLive(rm[1], reportMtime(report))), 'text/html; charset=utf-8');
    }
    // レポートからリンクした、同じフォルダの資料
    const rf = url.pathname.match(/^\/report\/([^/]+)\/([^/]+)$/);
    if (rf && req.method === 'GET') {
      const f = readReportSibling(readCase(rf[1])?.report, decodeURIComponent(rf[2]));
      if (!f) return send(res, 404, '見つかりません', 'text/plain; charset=utf-8');
      res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'no-store' });
      return res.end(f.body);
    }
    // ロゴ・ファビコン（public/assets の PNG だけ）
    const am = url.pathname.match(/^\/assets\/([\w-]+\.png)$/);
    if (am && req.method === 'GET') {
      const f = path.join(ROOT, 'public', 'assets', am[1]);
      if (!fs.existsSync(f)) return send(res, 404, '見つかりません', 'text/plain; charset=utf-8');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      return res.end(fs.readFileSync(f));
    }
    // 見本のページに「選んで決定」を足す共通部品
    if (req.method === 'GET' && url.pathname === '/inbox-kit.js') {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'inbox-kit.js'), 'utf8'), 'text/javascript; charset=utf-8');
    }
    // サイドバーの「VS CODE」。dirs.json に書いたフォルダだけを、開いている VS Code のウィンドウごと前に出す
    if (req.method === 'POST' && url.pathname === '/api/vscode') {
      // 他のサイトから勝手に叩かれないよう、JSON で送られたものだけ受ける
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON で送ってください' });
      const { dir } = await readBody(req);
      if (!Object.hasOwn(readDirLabels(), dir)) return send(res, 400, { error: 'dirs.json にないフォルダです' });
      const abs = dir.replace(/^~(?=$|\/)/, os.homedir());
      if (!fs.existsSync(abs)) return send(res, 404, { error: `${dir} が見つかりません` });
      const [cmd, args] = vscodeCommand(abs);
      execFile(cmd, args, (err) => (err ? send(res, 500, { error: err.message }) : send(res, 200, { ok: true })));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/answers') {
      const a = addAnswer(await readBody(req));
      broadcast();
      return send(res, 201, a);
    }
    const im = url.pathname.match(/^\/inbox\/([^/]+)$/);
    if (im && req.method === 'GET') {
      const f = readInbox(decodeURIComponent(im[1]));
      if (!f) return send(res, 404, '見つかりません', 'text/plain; charset=utf-8');
      res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'no-store' });
      return res.end(f.body);
    }
    const lm = url.pathname.match(/^\/link\/(\d+)\/(.*)$/);
    if (lm && req.method === 'GET') {
      const f = readLinkFile(Number(lm[1]), decodeURIComponent(lm[2]));
      if (!f) return send(res, 404, '見つかりません', 'text/plain; charset=utf-8');
      res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'no-store' });
      return res.end(f.body);
    }
    if (req.method === 'GET' && url.pathname === '/api/memory') {
      const text = readMemory(url.searchParams.get('path'));
      return text == null ? send(res, 404, { error: 'not found' }) : send(res, 200, { text });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, HOST, () => console.log(`cockpit: http://localhost:${PORT}/  data: ${CASES_DIR}`));
