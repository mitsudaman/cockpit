// INBOX の見本に「選んで決定」を足す共通部品。<script src="/inbox-kit.js"></script> で読み込む
// 選べるものに data-pick="H1"（と、案の種類が複数あるときは data-group="ヘッダー"）を付ける。グループごとに1つ選べる
// 決定すると /api/answers に送られ、`board wait <ファイル名>` で待っている Claude に届く。送れたら横に「タブを閉じる」が出る
(() => {
  const name = decodeURIComponent(location.pathname.split('/').pop());
  const picks = {};

  const css = document.createElement('style');
  css.textContent = `
    [data-pick]{cursor:pointer;transition:box-shadow .15s,outline-color .15s;outline:3px solid transparent;outline-offset:4px}
    [data-pick]:hover{outline-color:rgb(95 208 245 / .35)}
    [data-pick].ik-on{outline-color:#5fd0f5;box-shadow:0 0 0 8px rgb(95 208 245 / .12),0 0 28px rgb(95 208 245 / .35)}
    [data-pick] .ik-tag{position:absolute;top:10px;right:10px;z-index:3;font:700 11px/1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.14em;color:#0d1a20;background:#5fd0f5;padding:5px 8px;border-radius:6px;display:none}
    [data-pick].ik-on .ik-tag{display:block}
    .ik-bar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:999;display:flex;align-items:center;gap:14px;width:min(860px,calc(100vw - 32px));padding:12px 14px 12px 18px;border-radius:14px;background:#0d1a20;color:#d7e3e9;box-shadow:0 12px 40px rgb(0 0 0 / .35),inset 0 0 0 1px #1f3540;font:13px/1.5 "BIZ UDPGothic","Hiragino Sans",system-ui,sans-serif}
    .ik-bar small{font:600 10px/1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.22em;color:#5f7b88}
    .ik-sel{display:flex;gap:8px;flex-wrap:wrap;min-width:0}
    .ik-sel b{font:700 12px/1 "JetBrains Mono",ui-monospace,monospace;color:#5fd0f5;background:#13262e;border:1px solid #22404d;border-radius:6px;padding:5px 8px}
    .ik-sel i{font-style:normal;color:#5f7b88}
    .ik-bar input{flex:1;min-width:120px;background:#13262e;border:1px solid #22404d;border-radius:8px;color:#e4eef2;padding:8px 10px;font:inherit}
    .ik-bar input::placeholder{color:#5f7b88}
    .ik-bar button{border:0;border-radius:9px;padding:9px 18px;font-weight:700;font-size:13px;line-height:1;font-family:inherit;letter-spacing:.06em;background:#5fd0f5;color:#06212d;cursor:pointer;box-shadow:0 0 16px rgb(95 208 245 / .45)}
    .ik-bar button:disabled{background:#22404d;color:#5f7b88;box-shadow:none;cursor:default}
    .ik-bar.ik-done button{background:#4fd18b;box-shadow:0 0 16px rgb(79 209 139 / .45)}
    .ik-bar button.ik-close{display:none;background:#13262e;color:#d7e3e9;box-shadow:inset 0 0 0 1px #22404d}
    .ik-bar.ik-done button.ik-close{display:block;background:#13262e;box-shadow:inset 0 0 0 1px #22404d}
    body{padding-bottom:110px !important}
  `;
  document.head.append(css);

  const items = [...document.querySelectorAll('[data-pick]')];
  const groupOf = (el) => el.dataset.group || '選択';
  const groups = [...new Set(items.map(groupOf))];
  for (const el of items) {
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const tag = document.createElement('span');
    tag.className = 'ik-tag';
    tag.textContent = `✓ ${el.dataset.pick}`;
    el.append(tag);
    el.addEventListener('click', () => {
      const g = groupOf(el);
      picks[g] = picks[g] === el.dataset.pick ? undefined : el.dataset.pick;
      if (!picks[g]) delete picks[g];
      render();
    });
  }

  const bar = document.createElement('div');
  bar.className = 'ik-bar';
  bar.innerHTML = '<small>DECIDE</small><div class="ik-sel"></div><input type="text" placeholder="ひとこと（任意）"><button disabled>決定</button><button class="ik-close" type="button">タブを閉じる</button>';
  document.body.append(bar);
  const [sel, note, btn, close] = [bar.querySelector('.ik-sel'), bar.querySelector('input'), bar.querySelector('button'), bar.querySelector('.ik-close')];

  function render() {
    for (const el of items) el.classList.toggle('ik-on', picks[groupOf(el)] === el.dataset.pick);
    sel.innerHTML = groups.map((g) => (picks[g] ? `<b>${groups.length > 1 ? `${g}: ` : ''}${picks[g]}</b>` : `<i>${groups.length > 1 ? `${g}: ` : ''}未選択</i>`)).join('');
    btn.disabled = !Object.keys(picks).length;
    bar.classList.remove('ik-done');
    btn.textContent = '決定';
    close.textContent = 'タブを閉じる';
  }

  // ボードから新しいタブで開いたページなら閉じられる。閉じられないときは手で閉じてもらう
  close.addEventListener('click', () => {
    window.close();
    setTimeout(() => { if (!window.closed) close.textContent = '⌘W で閉じてね'; }, 200);
  });

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '送信中…';
    try {
      const r = await fetch('/api/answers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, picks, note: note.value }) });
      if (!r.ok) throw new Error((await r.json()).error);
      bar.classList.add('ik-done');
      btn.textContent = '✓ Claudeに送りました';
    } catch (e) {
      btn.disabled = false;
      btn.textContent = `送れませんでした（${e.message}）`;
    }
  });
  render();
})();
