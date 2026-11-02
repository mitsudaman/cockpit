#!/usr/bin/env node
// 案件ボードの CLI。Claude はどのチャットからでもこれで更新する（サーバーが止まっていても書ける）
import {
  STATUSES, STATUS_IDS, STEP_STATES, listCases, readCase, writeCase, normalize, applyPatch, addLog, detectDir, readDirLabels, readAnswers,
} from './lib.mjs';

const USAGE = `使い方:
  board list [--all] [--here]                一覧（--all で完了も、--here で今いるディレクトリだけ）
  board show <id>                            1件の中身を JSON で表示
  board new <id> title=... [project=...] [key=value ...]
                                             dir は今いるディレクトリ（worktree なら本体）が入る
  board set <id> key=value [key=value ...]  更新（log="..." で履歴も追記）
  board log <id> <テキスト>                  履歴だけ追記
  board step <id> add <工程名> [who=担当]    工程を追加
  board step <id> <番号> <todo|next|done>    工程の状態を変更（番号は1始まり）
  board link <id> <ラベル> [URL]             リンクを追加
  board wait <INBOXのファイル名> [timeout=秒]  見本で「決定」が押されるまで待ち、選択を JSON で出す
                                             （Claude は run_in_background で動かし、終わったら続きをやる）

key: title dir project client status ball waiting_on next summary branch memory
status: ${STATUS_IDS.join(' / ')}
ball: me（自分が動く） / other（相手待ち。waiting_on=誰か）`;

const statusLabel = (id) => STATUSES.find((s) => s.id === id)?.label || id;

function parseKV(args) {
  const out = {};
  for (const a of args) {
    const i = a.indexOf('=');
    if (i < 1) throw new Error(`key=value の形で指定してください: ${a}`);
    out[a.slice(0, i)] = a.slice(i + 1);
  }
  return out;
}

function mustRead(id) {
  const c = readCase(id);
  if (!c) throw new Error(`${id} はありません（board list で確認）`);
  return c;
}

function printList(cases) {
  const labels = readDirLabels();
  const order = (c) => [c.ball === 'me' ? 0 : 1, STATUS_IDS.indexOf(c.status)];
  cases.sort((a, b) => {
    const [x1, y1] = order(a), [x2, y2] = order(b);
    return a.dir.localeCompare(b.dir) || a.project.localeCompare(b.project) || x1 - x2 || y1 - y2;
  });
  let group = null;
  for (const c of cases) {
    const g = `${c.dir}\t${c.project}`;
    if (g !== group) {
      if (group === null || c.dir !== group.split('\t')[0]) console.log(`\n■ ${labels[c.dir] || c.dir || '（ディレクトリ未設定）'}  ${c.dir}`);
      if (c.project) console.log(`  ▸ ${c.project}`);
      group = g;
    }
    const ball = c.ball === 'me' ? '自分' : `待ち:${c.waiting_on || '相手'}`;
    console.log(`  ${c.project ? '  ' : ''}${c.id.padEnd(34)} [${statusLabel(c.status)}][${ball}] ${c.next}`);
  }
}

function main(argv) {
  const [cmd, id, ...rest] = argv;
  switch (cmd) {
    case 'list': {
      const flags = parseKV([id, ...rest].filter(Boolean).map((a) => a.replace(/^--/, '')).map((a) => (a.includes('=') ? a : `${a}=1`)));
      let cases = listCases();
      if (!flags.all) cases = cases.filter((c) => c.status !== 'done');
      if (flags.here) cases = cases.filter((c) => c.dir === detectDir());
      return printList(cases);
    }
    case 'show':
      return console.log(JSON.stringify(mustRead(id), null, 2));
    case 'new': {
      if (readCase(id)) throw new Error(`${id} は既にあります`);
      const kv = parseKV(rest);
      const c = addLog(normalize({ id, dir: detectDir(), ...kv }), kv.log || '案件を登録');
      writeCase(c);
      return console.log(`登録: ${id}`);
    }
    case 'set': {
      const kv = parseKV(rest);
      if ('log' in kv) { kv.log_text = kv.log; delete kv.log; }
      writeCase(applyPatch(mustRead(id), kv));
      return console.log(`更新: ${id}`);
    }
    case 'log': {
      const text = rest.join(' ');
      if (!text) throw new Error('テキストを指定してください');
      writeCase(addLog(mustRead(id), text));
      return console.log(`履歴追加: ${id}`);
    }
    case 'step': {
      const c = mustRead(id);
      const [sub, ...args] = rest;
      if (sub === 'add') {
        const who = args.find((a) => a.startsWith('who='));
        const title = args.filter((a) => a !== who).join(' ');
        c.steps.push({ title, who: who ? who.slice(4) : '', state: 'todo' });
      } else {
        const n = Number(sub);
        const state = args[0];
        if (!c.steps[n - 1]) throw new Error(`工程 ${sub} はありません（1〜${c.steps.length}）`);
        if (!STEP_STATES.includes(state)) throw new Error(`状態は ${STEP_STATES.join(' / ')}`);
        c.steps[n - 1].state = state;
        if (state === 'done') addLog(c, `工程完了: ${c.steps[n - 1].title}`);
      }
      writeCase(c);
      return console.log(`工程更新: ${id}`);
    }
    case 'link': {
      const c = mustRead(id);
      const [label, url = ''] = rest;
      if (!label) throw new Error('ラベルを指定してください');
      c.links.push({ label, url });
      writeCase(c);
      return console.log(`リンク追加: ${id}`);
    }
    default:
      console.log(USAGE);
  }
}

// 決定が届くまで待つ（実行した時刻より後の決定だけを拾う）
async function wait(name, args) {
  if (!name) throw new Error('INBOX のファイル名を指定してください');
  const { timeout = 6 * 3600 } = parseKV(args);
  const since = new Date().toISOString();
  const end = Date.now() + Number(timeout) * 1000;
  while (Date.now() < end) {
    const a = readAnswers().find((x) => x.name === name && x.at > since);
    if (a) return console.log(JSON.stringify(a, null, 2));
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${timeout}秒待ちましたが決定はありませんでした`);
}

try {
  const argv = process.argv.slice(2);
  if (argv[0] === 'wait') await wait(argv[1], argv.slice(2));
  else main(argv);
} catch (e) {
  console.error(`エラー: ${e.message}`);
  process.exit(1);
}
