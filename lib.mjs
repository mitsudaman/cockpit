import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const CASES_DIR = process.env.COCKPIT_DATA || path.join(ROOT, 'data', 'cases');
// 案件の memory は ~/.claude/projects/<project>/memory/<file>.md を相対パスで持つ
export const MEMORY_ROOT = path.join(os.homedir(), '.claude', 'projects');
// ディレクトリの表示名（任意）。{"~/work/sample-app": "SAMPLE APP"} の形
export const DIRS_FILE = path.join(path.dirname(CASES_DIR), 'dirs.json');
// ディレクトリの決まった色（任意。ブランド色など）。{"~/work/sample-app": "#a67c5b"} の形
export const DIR_COLORS_FILE = path.join(path.dirname(CASES_DIR), 'dir-colors.json');
// このMacだけの設定（任意）。{"safe": true} で、外への通信・ホームのファイルの配信・コマンドの起動をする機能を止める
export const CONFIG_FILE = path.join(path.dirname(CASES_DIR), 'config.json');

export function tildify(p) {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

// worktree から呼ばれても本体リポジトリのディレクトリにまとめる
export function detectDir(cwd = process.cwd()) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (common.endsWith(`${path.sep}.git`)) return tildify(path.dirname(common));
  } catch {}
  return tildify(cwd);
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
export const readDirLabels = () => readJson(DIRS_FILE, {});
export const readDirColors = () => readJson(DIR_COLORS_FILE, {});
export const readConfig = () => readJson(CONFIG_FILE, {});

export const STATUSES = [
  { id: 'investigating', label: '調査' },
  { id: 'implementing', label: '実装' },
  { id: 'review', label: 'レビュー' },
  { id: 'verify', label: '検証' },
  { id: 'release', label: 'マージ・リリース' },
  { id: 'report', label: '報告' },
  { id: 'hold', label: '保留' },
  { id: 'done', label: '完了' },
];
export const STATUS_IDS = STATUSES.map((s) => s.id);
export const BALLS = ['me', 'other'];
export const STEP_STATES = ['todo', 'next', 'done'];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

export function assertId(id) {
  if (!ID_RE.test(id || '')) throw new Error(`id は英小文字・数字・ハイフンで指定してください: ${id}`);
}

export function casePath(id) {
  assertId(id);
  return path.join(CASES_DIR, `${id}.json`);
}

export function listCases() {
  fs.mkdirSync(CASES_DIR, { recursive: true });
  return fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8'));
      } catch {
        return null; // 書き込み途中などで壊れていても一覧は止めない
      }
    })
    .filter(Boolean);
}

export function readCase(id) {
  const p = casePath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function validate(c) {
  assertId(c.id);
  if (!c.title) throw new Error('title は必須です');
  if (!STATUS_IDS.includes(c.status)) throw new Error(`status は ${STATUS_IDS.join(' / ')} のどれか: ${c.status}`);
  if (!BALLS.includes(c.ball)) throw new Error(`ball は me / other のどちらか: ${c.ball}`);
  for (const s of c.steps || []) {
    if (!STEP_STATES.includes(s.state)) throw new Error(`step.state は ${STEP_STATES.join(' / ')} のどれか: ${s.state}`);
  }
}

export function normalize(c) {
  const now = new Date().toISOString();
  return {
    id: c.id,
    title: c.title,
    dir: c.dir || '',
    project: c.project || '',
    client: c.client || '',
    status: c.status || 'investigating',
    ball: c.ball || 'me',
    waiting_on: c.waiting_on || '',
    next: c.next || '',
    summary: c.summary || '',
    branch: c.branch || '',
    links: c.links || [],
    steps: c.steps || [],
    log: c.log || [],
    memory: c.memory || '',
    report: c.report || '',
    created_at: c.created_at || now,
    updated_at: c.updated_at || now,
  };
}

// tmp に書いてから rename するので、監視側が書きかけの JSON を読むことはない
export function writeCase(c, { touch = true } = {}) {
  const data = normalize(c);
  if (touch) data.updated_at = new Date().toISOString();
  validate(data);
  fs.mkdirSync(CASES_DIR, { recursive: true });
  const p = casePath(data.id);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, p);
  return data;
}

export function addLog(c, text) {
  c.log = [{ at: new Date().toISOString(), text }, ...(c.log || [])];
  return c;
}

const EDITABLE = ['title', 'dir', 'project', 'client', 'status', 'ball', 'waiting_on', 'next', 'summary', 'branch', 'links', 'steps', 'memory', 'report'];
const statusLabel = (id) => STATUSES.find((s) => s.id === id)?.label || id;
const ballLabel = (c) => (c.ball === 'me' ? '自分' : c.waiting_on || '相手');

// 画面と CLI のどちらから更新しても、ステータスとボールの移動は履歴に残す
export function applyPatch(c, patch) {
  const before = { status: c.status, ball: c.ball, waiting_on: c.waiting_on };
  for (const k of EDITABLE) if (k in patch) c[k] = patch[k];
  if (c.status !== before.status) addLog(c, `ステータス: ${statusLabel(before.status)} → ${statusLabel(c.status)}`);
  if (c.ball !== before.ball || (c.ball === 'other' && c.waiting_on !== before.waiting_on)) {
    addLog(c, `ボール: ${ballLabel(before)} → ${ballLabel(c)}`);
  }
  if (patch.log_text) addLog(c, String(patch.log_text));
  return c;
}

export function readMemory(rel) {
  if (!rel) return null;
  const p = path.resolve(MEMORY_ROOT, rel);
  if (!p.startsWith(MEMORY_ROOT + path.sep) || !p.endsWith('.md')) return null;
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

// 案件の report は現在地をまとめたローカルの HTML（~ 始まりか絶対パス）。ホーム配下の .html だけ読む
// サイドバーのリンク（任意）。[{"title": "ダッシュボード", "path": "~/notes/dashboard/index.html"}] の形
export const LINKS_FILE = path.join(path.dirname(CASES_DIR), 'links.json');
export function readLinks() {
  try {
    return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

// リンク先の HTML と、同じフォルダの中の相対参照（data.js・lib/ など）だけを返す
const LINK_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
export function readLinkFile(i, rest) {
  const link = readLinks()[i];
  if (!link?.path) return null;
  const home = os.homedir();
  const entry = path.resolve(link.path.startsWith('~/') ? path.join(home, link.path.slice(2)) : link.path);
  const dir = path.dirname(entry);
  const abs = rest ? path.resolve(dir, rest) : entry;
  const type = LINK_TYPES[path.extname(abs)];
  if (!abs.startsWith(dir + path.sep) || !abs.startsWith(home + path.sep) || !type || !fs.existsSync(abs)) return null;
  return { body: fs.readFileSync(abs), type };
}

// INBOX: Claude が見せたいもの（見本・レポート・スクショ・PDF）を置く場所。新しい順にサイドバーへ並ぶ
// ほかの場所のファイルはシンボリックリンクで置いてよい（実体はホーム配下に限る）
export const INBOX_DIR = path.join(path.dirname(CASES_DIR), 'inbox');
const INBOX_TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' };
function inboxPath(name) {
  if (!name || path.basename(name) !== name || !INBOX_TYPES[path.extname(name).toLowerCase()]) return null;
  try {
    const real = fs.realpathSync(path.join(INBOX_DIR, name));
    return real.startsWith(os.homedir() + path.sep) && fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}
export function listInbox() {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const answered = new Set(readAnswers().map((a) => a.name));
  return fs.readdirSync(INBOX_DIR).flatMap((name) => {
    const real = inboxPath(name);
    if (!real) return [];
    const ext = path.extname(name).toLowerCase();
    let title = '';
    if (ext === '.html') title = (fs.readFileSync(real, 'utf8').match(/<title>([^<]*)<\/title>/i)?.[1] || '').trim();
    return [{ name, title: title || name.replace(/\.[^.]+$/, ''), kind: ext.slice(1), at: fs.lstatSync(path.join(INBOX_DIR, name)).mtime.toISOString(), answered: answered.has(name) }];
  }).sort((a, b) => b.at.localeCompare(a.at));
}
export function readInbox(name) {
  const real = inboxPath(name);
  return real ? { body: fs.readFileSync(real), type: INBOX_TYPES[path.extname(name).toLowerCase()] } : null;
}

// INBOX の見本で「決定」された選択。1行1件の JSON（{name, picks, note, at}）
export const ANSWERS_FILE = path.join(INBOX_DIR, '.answers.jsonl');
export function readAnswers() {
  try {
    return fs.readFileSync(ANSWERS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
export function addAnswer({ name, picks = {}, note = '' }) {
  if (!inboxPath(name)) throw new Error(`${name} は INBOX にありません`);
  const a = { name, picks, note: String(note).slice(0, 4000), at: new Date().toISOString() };
  fs.appendFileSync(ANSWERS_FILE, JSON.stringify(a) + '\n');
  return a;
}

function reportFile(p) {
  if (!p) return null;
  const home = os.homedir();
  const abs = path.resolve(p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  if (!abs.startsWith(home + path.sep) || !abs.endsWith('.html')) return null;
  return fs.existsSync(abs) ? abs : null;
}

export function readReport(p) {
  const abs = reportFile(p);
  return abs ? fs.readFileSync(abs, 'utf8') : null;
}

// レポートと同じフォルダの直下にあるファイル（レポートからリンクした資料）。サブフォルダ・INBOX と同じ種類以外のファイルは出さない
export function readReportSibling(p, name) {
  const abs = reportFile(p);
  if (!abs || !name || path.basename(name) !== name || name.startsWith('.') || !INBOX_TYPES[path.extname(name).toLowerCase()]) return null;
  try {
    const dir = fs.realpathSync(path.dirname(abs));
    const real = fs.realpathSync(path.join(path.dirname(abs), name));
    if (path.dirname(real) !== dir || !fs.statSync(real).isFile()) return null;
    return { body: fs.readFileSync(real), type: INBOX_TYPES[path.extname(name).toLowerCase()] };
  } catch {
    return null;
  }
}

// レポートの更新時刻（ms）。画面はこれが変わったらレポートを読み直す
export function reportMtime(p) {
  const abs = reportFile(p);
  try { return abs ? fs.statSync(abs).mtimeMs : 0; } catch { return 0; }
}
