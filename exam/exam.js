(() => {
  'use strict';

  const app = document.getElementById('app');
  const LETTERS = ['A', 'B', 'C', 'D'];
  const CATEGORIES = ['單字', '片語', '文法'];
  const BASE_TITLE = '線上考卷';
  let routeToken = 0;

  /* ---------- 小工具 ---------- */

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
  }

  // 考卷檔把 answer / zh / note（拼字題另有 accept）收進 base64 的 secret 欄位；載入後在這裡還原
  function unlock(exam) {
    if (typeof exam.secret !== 'string') return exam;
    const bytes = Uint8Array.from(atob(exam.secret), (c) => c.charCodeAt(0));
    const sec = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    if (Array.isArray(exam.sections)) {
      const total = exam.sections.reduce((n, s) => n + s.questions.length, 0);
      if (!Array.isArray(sec) || sec.length !== total) throw new Error('secret 與題數不符');
      let i = 0;
      exam.sections = exam.sections.map((s) => ({ ...s, questions: s.questions.map((q) => ({ ...q, ...sec[i++] })) }));
    } else {
      if (!Array.isArray(sec) || sec.length !== exam.questions.length) throw new Error('secret 與題數不符');
      exam.questions = exam.questions.map((q, i) => ({ ...q, ...sec[i] }));
    }
    delete exam.secret;
    return exam;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /* ---------- 基本防複製（純前端，只擋一般操作） ---------- */

  const stop = (e) => e.preventDefault();
  ['contextmenu', 'copy', 'cut', 'dragstart'].forEach((t) => document.addEventListener(t, stop));
  // 拼字題的輸入框要能正常打字與游標選取，其餘文字仍不可選
  document.addEventListener('selectstart', (e) => {
    if (!(e.target instanceof Element && e.target.closest('input'))) e.preventDefault();
  });
  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const devtools = e.key === 'F12' || (mod && (e.shiftKey || e.altKey) && ['i', 'j', 'c'].includes(k));
    const copyLike = mod && !e.shiftKey && !e.altKey && ['c', 'x', 'a', 's', 'p', 'u'].includes(k);
    const inInput = e.target instanceof Element && e.target.closest('input');
    if (devtools || (copyLike && !(inInput && (k === 'a' || k === 'x')))) e.preventDefault();
  });

  /* ---------- 作答中不能隨便離開 ---------- */

  // 正在作答、還沒交卷的考卷狀態；沒有就是 null。離開會丟掉進度（題序也會重新打亂），所以要先確認。
  let live = null;
  const LEAVE_MSG = '考卷還沒交卷，離開會失去目前的作答進度。確定要離開嗎？';
  const leaving = () => live != null && !live.submitted;
  let currentHash = location.hash;

  // 自己跳出的 confirm 會讓視窗短暫失焦，不能算成「離開頁面」
  let dialogOpen = false;
  const ask = (msg) => { dialogOpen = true; try { return confirm(msg); } finally { dialogOpen = false; } };

  // 偵測離開頁面：分頁被切走、App 被切到背景、視窗失去焦點（例如並排開別的視窗查資料）都算。
  // 一次「離開」從離開那刻算到回來；少於 1 秒當作誤觸不計。只在作答中記錄。
  const AWAY_MIN_MS = 1000;
  let awaySince = null;
  let onAwayChange = () => {};
  const isAway = () => document.hidden || !document.hasFocus();
  function trackAway() {
    if (!leaving() || dialogOpen) return;
    if (isAway()) {
      if (awaySince == null) awaySince = Date.now();
    } else if (awaySince != null) {
      const ms = Date.now() - awaySince;
      awaySince = null;
      if (ms >= AWAY_MIN_MS) {
        live.stats.leaves++;
        live.stats.awayMs += ms;
        onAwayChange();
      }
    }
  }
  document.addEventListener('visibilitychange', trackAway);
  window.addEventListener('blur', trackAway);
  window.addEventListener('focus', trackAway);

  // 關閉分頁／重新整理／網址列換頁：瀏覽器只允許跳出它自己的確認視窗，文字無法自訂
  window.addEventListener('beforeunload', (e) => {
    if (!leaving()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // 站內連結（考卷列表等）：作答中先問，按取消就留在原處
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element && e.target.closest('a[href^="#/"]');
    if (!a || !leaving() || a.getAttribute('href') === currentHash) return;
    if (ask(LEAVE_MSG)) live = null; // 已經同意離開，接著的 hashchange 不再重複詢問
    else e.preventDefault();
  });

  // 瀏覽器的上一頁／手動改網址：事後才知道，按取消就把網址推回原本的考卷
  window.addEventListener('hashchange', () => {
    if (leaving() && !ask(LEAVE_MSG)) {
      history.pushState(null, '', currentHash || '#/');
      return;
    }
    currentHash = location.hash;
    route();
  });

  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return (h ? `${h}:${pad2(m)}` : String(m)) + `:${pad2(s % 60)}`;
  }
  function fmtStamp(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  const awayText = (st) => `離開頁面 ${st.leaves} 次` + (st.leaves ? `（共 ${fmtDur(st.awayMs)}）` : '');

  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function jumpTo(n) {
    const el = document.getElementById('q-' + n);
    if (!el) return;
    el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
    el.focus({ preventScroll: true });
  }

  function showMessage(text) {
    app.replaceChildren(
      h('p', { class: 'status', text }),
      h('p', { class: 'status' }, h('a', { href: '#/', text: '回到考卷列表' }))
    );
  }

  /* ---------- 首頁 ---------- */

  // 段考日期（schedule.json，手動維護；讀不到就不顯示，不影響考卷列表）
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  const ymd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const mdw = (s) => { const d = ymd(s); return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`; };

  function scheduleEl(events) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const upcoming = events.filter((ev) => ymd(ev.end) >= today); // 考完的就不顯示
    if (!upcoming.length) return null;
    return h('section', { class: 'schedule' },
      h('strong', { text: '段考日期' }),
      h('ul', null, upcoming.map((ev, i) => {
        const days = Math.round((ymd(ev.start) - today) / 86400000);
        const when = ev.start === ev.end ? mdw(ev.start) : `${mdw(ev.start)} – ${mdw(ev.end)}`;
        const left = i > 0 ? '' : days > 0 ? `還有 ${days} 天` : '考試中';
        return h('li', null,
          h('span', { class: 'sch-name', text: ev.name }),
          h('span', { class: 'sch-when', text: when }),
          left && h('span', { class: 'sch-left', text: left }),
          ev.scope && h('span', { class: 'sch-scope', text: `範圍：${ev.scope}` })
        );
      }))
    );
  }

  async function showHome(token) {
    document.title = BASE_TITLE;
    let data, schedule = null;
    try {
      data = await fetchJSON('exams/index.json');
    } catch (e) {
      if (token !== routeToken) return;
      showMessage('讀不到考卷清單。請透過網址開啟本頁（不能直接雙擊 index.html）。');
      return;
    }
    try { schedule = scheduleEl((await fetchJSON('schedule.json')).events || []); } catch (e) { /* 沒有就不顯示 */ }
    if (token !== routeToken) return;

    const exams = data.exams || [];
    const list = exams.length
      ? h('ul', { class: 'exam-list' }, exams.map((ex) =>
          h('li', null,
            ex.locked
              // 鎖住的考卷：只顯示卡片，沒有連結（檔案本身也沒有發布）
              ? h('div', { class: 'exam-card is-locked', 'aria-disabled': 'true' },
                  h('span', { class: 'exam-date', text: ex.title }),
                  h('span', { class: 'exam-count', text: `${ex.questionCount} 題` }),
                  h('span', { class: 'exam-scope', text: ex.scope }),
                  h('span', { class: 'exam-go', text: '🔒 尚未開放' })
                )
              : h('a', { class: 'exam-card', href: '#/exam/' + encodeURIComponent(ex.id) },
                  h('span', { class: 'exam-date', text: ex.title }),
                  h('span', { class: 'exam-count', text: `${ex.questionCount} 題` }),
                  h('span', { class: 'exam-scope', text: ex.scope }),
                  h('span', { class: 'exam-go', 'aria-hidden': 'true', text: '開始作答 ›' })
                )
          )))
      : h('p', { class: 'status', text: '目前還沒有考卷。' });

    app.replaceChildren(
      h('header', { class: 'home-head' },
        h('h1', { text: '線上考卷' }),
        h('p', { text: '選一份考卷開始作答。交卷後會馬上看到分數、錯題與每題解析。' })
      ),
      list,
      schedule,
      h('section', { class: 'handout' },
        h('strong', { text: '文法講義' }),
        h('a', { href: 'assets/grammar-summary.pdf', target: '_blank', rel: 'noopener', text: '開啟 PDF' }),
        h('a', { href: 'assets/grammar-summary.pdf', download: '高職英文文法總整理.pdf', text: '下載' })
      )
    );
    window.scrollTo(0, 0);
  }

  /* ---------- 考卷：狀態 ---------- */

  // 題型：single 一般選擇（可含兩個空格、對話）／cloze 短文多空／reading 閱讀題組／spell 拼字
  // 預設是否打亂題序：只有 single 與 spell 會打亂；cloze 的空格與題號綁定、reading 依文章順序，不打亂
  const SHUFFLE_DEFAULT = { single: true, spell: true, cloze: false, reading: false };

  // 舊格式（只有 questions）視為單一區、不顯示區標題、每題 1 分
  function normalize(exam) {
    if (Array.isArray(exam.sections)) return { sections: exam.sections, legacy: false };
    return { sections: [{ title: null, type: 'single', points: 1, shuffle: true, questions: exam.questions }], legacy: true };
  }

  function buildState(exam) {
    const { sections, legacy } = normalize(exam);
    const items = [];
    const secs = sections.map((sec) => {
      const type = sec.type;
      const points = sec.points || 1;
      const order = sec.questions.map((_, i) => i);
      if (type !== 'cloze' && (sec.shuffle ?? SHUFFLE_DEFAULT[type])) shuffle(order);
      const secObj = { sec, type, points, items: [] };
      for (const qi of order) {
        const q = sec.questions[qi];
        const it = { n: items.length + 1, q, secObj, type, points, blanks: [] };
        if (type === 'spell') {
          it.typed = '';
        } else {
          const optOrder = [0, 1, 2, 3];
          if (exam.shuffleOptions) shuffle(optOrder);
          it.optOrder = optOrder;
          it.correct = optOrder.indexOf(q.answer);
          it.picked = null;
        }
        items.push(it);
        secObj.items.push(it);
      }
      return secObj;
    });
    // stats：作答時間與「離開頁面」紀錄，交卷後顯示在成績單上
    return { exam, legacy, secs, items, submitted: false, stats: { start: Date.now(), end: null, leaves: 0, awayMs: 0 } };
  }

  const normSpell = (t) => String(t).trim().toLowerCase().replace(/\s+/g, ' ');
  const answered = (it) => (it.type === 'spell' ? it.typed.trim() !== '' : it.picked != null);
  const isRight = (it) => (it.type === 'spell'
    ? [it.q.answer, ...(it.q.accept || [])].map(normSpell).includes(normSpell(it.typed))
    : it.picked === it.correct);
  const optText = (it, k) => it.q.options[it.optOrder[k]];
  const optParts = (text) => text.split(' / '); // 兩個空格的題目，選項以 " / " 分成兩段
  const spellHint = (word) => [...word].map((c, i, a) => (i === 0 || i === a.length - 1 || !/[A-Za-z]/.test(c) ? c : '_')).join(' ');

  /* ---------- 考卷：畫面 ---------- */

  function newBlank(it) {
    const el = h('span', { class: 'blank' + (it.type === 'cloze' ? ' cloze' : ''), 'data-n': it.n });
    it.blanks.push(el);
    return el;
  }

  // 依目前選擇（或交卷後的正解）填入空格；兩個空格的選項依序拆開填
  function fillBlanks(it, submitted) {
    const idx = submitted ? it.correct : it.picked;
    const parts = idx == null ? [] : optParts(optText(it, idx));
    it.blanks.forEach((el, i) => {
      el.replaceChildren();
      el.classList.toggle('done', submitted);
      if (idx != null) el.textContent = parts[i] ?? parts[0];
      else if (it.type !== 'cloze') el.append(h('span', { class: 'sr-only', text: '空格' }));
    });
  }

  function questionEl(state, it, hooks) {
    const { q, n } = it;
    const sub = state.submitted;
    const right = sub && isRight(it);
    let card = null;

    const head = h('div', { class: 'q-head' },
      h('span', { class: 'qnum', text: `第 ${n} 題` }),
      q.category ? h('span', { class: 'tag', text: q.category }) : null,
      !state.legacy && it.points > 1 ? h('span', { class: 'tag', text: `${it.points} 分` }) : null,
      sub ? h('span', { class: right ? 'badge ok' : 'badge bad', text: right ? '✓ 答對' : '✗ 答錯' }) : null
    );

    let stem = null;
    let opts = null;
    let spellInput = null;

    if (it.type === 'spell') {
      const [pre, post] = q.sentence.split('___');
      spellInput = h('input', {
        type: 'text', class: 'spell-input', id: `q${n}-in`, maxlength: '40',
        autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
        'aria-label': `第 ${n} 題：拼出單字`, disabled: sub
      });
      spellInput.size = Math.max(7, Math.ceil((q.hint || spellHint(q.answer)).length / 2) + 1);
      spellInput.value = it.typed;
      if (sub) spellInput.classList.add(right ? 'is-ok' : 'is-no');
      else {
        spellInput.addEventListener('input', () => {
          it.typed = spellInput.value;
          card.classList.toggle('answered', answered(it));
          hooks.onPick();
        });
      }
      stem = [
        h('p', { class: 'sentence', id: `qs-${n}` }, pre, spellInput, post),
        h('p', { class: 'spell-hint' }, '提示：', h('code', { text: q.hint || spellHint(q.answer) }), '（首、尾字母已給，其餘每個底線代表一個字母）')
      ];
    } else {
      if (it.type === 'single') {
        const segs = q.sentence.split('___');
        const kids = [segs[0]];
        for (let i = 1; i < segs.length; i++) kids.push(newBlank(it), segs[i]);
        stem = h('p', { class: 'sentence', id: `qs-${n}` }, kids);
      } else if (it.type === 'reading') {
        stem = h('p', { class: 'sentence', id: `qs-${n}`, text: q.stem });
      }
      fillBlanks(it, sub);

      opts = h('div', { class: 'opts', role: 'radiogroup', 'aria-labelledby': stem ? `qs-${n}` : `q-${n}` },
        it.optOrder.map((_, k) => {
          const id = `q${n}-o${k}`;
          let cls = 'opt';
          let mark = null;
          if (sub) {
            if (k === it.correct) {
              cls += ' is-answer';
              mark = it.picked === k ? '✓ 你的答案（正確）' : '✓ 正確答案';
            } else if (k === it.picked) {
              cls += ' is-miss';
              mark = '✗ 你的答案';
            }
          }
          const input = h('input', { type: 'radio', name: `q${n}`, id, value: k, disabled: sub });
          input.checked = it.picked === k;
          if (!sub) {
            input.addEventListener('change', () => {
              it.picked = k;
              fillBlanks(it, false);
              card.classList.add('answered');
              hooks.onPick();
            });
          }
          return h('div', { class: cls },
            input,
            h('label', { for: id },
              h('span', { class: 'letter', text: LETTERS[k] }),
              h('span', { class: 'opt-body' },
                h('span', { class: 'opt-text', text: optText(it, k) }),
                mark ? h('span', { class: 'mark', text: mark }) : null
              )
            )
          );
        })
      );
    }

    const explain = sub
      ? h('div', { class: 'explain' },
          h('dl', null,
            it.type === 'spell'
              ? [
                  h('div', null, h('dt', { text: '正確答案' }), h('dd', { text: q.answer })),
                  h('div', null, h('dt', { text: '你的答案' }), h('dd', { text: it.typed.trim() || '（沒有作答）' }))
                ]
              : h('div', null, h('dt', { text: '正確答案' }),
                  h('dd', { text: `${LETTERS[it.correct]}. ${optText(it, it.correct)}` })),
            h('div', null, h('dt', { text: '中文翻譯' }), h('dd', { text: q.zh })),
            h('div', null, h('dt', { text: '重點解析' }), h('dd', { text: q.note }))
          ))
      : null;

    card = h('article', {
      class: 'q t-' + it.type + (sub ? (right ? ' is-right' : ' is-wrong') : '') + (answered(it) && !sub ? ' answered' : ''),
      id: `q-${n}`,
      tabindex: '-1'
    }, head, stem, opts, explain);
    return card;
  }

  // 區標題（有 title 才顯示）、短文（cloze／reading）
  function sectionHeadEl(state, secObj) {
    const { sec, items, points } = secObj;
    return h('header', { class: 'sec-head' },
      h('h2', { text: sec.title }),
      h('p', { class: 'sec-meta', text: `共 ${items.length} 題・每題 ${points} 分` }),
      sec.intro ? h('p', { class: 'sec-intro', text: sec.intro }) : null
    );
  }

  function passageEl(state, secObj) {
    const { sec, items, type } = secObj;
    const box = h('div', { class: 'passage-body' });
    if (type === 'cloze') {
      // 空格依序對應各題；點空格可跳到該題
      const segs = sec.passage.split('___');
      const kids = [segs[0]];
      for (let i = 1; i < segs.length; i++) {
        const it = items[i - 1];
        const blank = newBlank(it);
        blank.setAttribute('role', 'button');
        blank.setAttribute('tabindex', '0');
        blank.setAttribute('aria-label', `跳到第 ${it.n} 題`);
        blank.addEventListener('click', () => jumpTo(it.n));
        blank.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpTo(it.n); } });
        fillBlanks(it, state.submitted);
        kids.push(blank, segs[i]);
      }
      box.append(...kids.map((k) => (typeof k === 'string' ? document.createTextNode(k) : k)));
    } else {
      box.textContent = sec.passage;
    }
    return h('article', { class: 'passage', 'aria-label': '短文' }, box);
  }

  function summaryEl(state, actions) {
    const { items, secs, legacy } = state;
    const total = items.length;
    const rightItems = items.filter(isRight);
    const wrong = items.filter((it) => !isRight(it));
    const totalPts = items.reduce((n, it) => n + it.points, 0);
    const score = rightItems.reduce((n, it) => n + it.points, 0);
    const pct = Math.round((score / totalPts) * 100);

    let cats;
    if (legacy) {
      cats = CATEGORIES
        .map((c) => {
          const group = items.filter((it) => it.q.category === c);
          if (!group.length) return null;
          const ok = group.filter(isRight).length;
          return h('li', { text: `${c} ${ok} / ${group.length}（${Math.round((ok / group.length) * 100)}%）` });
        })
        .filter(Boolean);
    } else {
      cats = secs.map((s) => {
        const sp = s.items.reduce((n, it) => n + it.points, 0);
        const ok = s.items.filter(isRight).reduce((n, it) => n + it.points, 0);
        return h('li', { text: `${s.sec.title} ${ok} / ${sp} 分` });
      });
    }

    const wrongBox = h('div', { class: 'wrong-box' },
      h('h2', { text: wrong.length ? `答錯的題號（共 ${wrong.length} 題）` : '錯誤題號' }),
      wrong.length
        ? h('div', { class: 'chips' }, wrong.map((it) =>
            h('button', {
              type: 'button', class: 'chip', 'aria-label': `跳到第 ${it.n} 題`,
              onclick: () => jumpTo(it.n), text: String(it.n)
            })))
        : h('p', { class: 'all-right', text: '全部答對！' })
    );

    return h('section', { class: 'summary', id: 'summary', tabindex: '-1', 'aria-label': '成績' },
      h('div', { class: 'score' },
        h('span', { class: 'big', text: String(legacy ? rightItems.length : score) }),
        h('span', { class: 'of', text: legacy ? `/ ${total} 題` : `/ ${totalPts} 分` }),
        h('span', { class: 'pct', text: `${pct}%` }),
        legacy ? null : h('span', { class: 'of', text: `（答對 ${rightItems.length} / ${total} 題）` })
      ),
      cats.length ? h('ul', { class: 'cats', 'aria-label': legacy ? '各題型答對率' : '各大題得分' }, cats) : null,
      h('ul', { class: 'cats run-stats', 'aria-label': '作答紀錄' },
        h('li', { text: `交卷時間 ${fmtStamp(state.stats.end)}` }),
        h('li', { text: `作答時間 ${fmtDur(state.stats.end - state.stats.start)}` }),
        h('li', { class: state.stats.leaves ? 'warn' : '', text: awayText(state.stats) })
      ),
      wrongBox,
      h('div', { class: 'summary-actions' },
        wrong.length
          ? h('label', { class: 'switch' },
              h('input', { type: 'checkbox', onchange: (e) => actions.onlyWrong(e.target.checked) }),
              '只看錯題')
          : null,
        h('button', { type: 'button', class: 'btn primary', onclick: actions.redo, text: '重做一次' }),
        h('a', { class: 'btn', href: '#/', text: '考卷列表' })
      )
    );
  }

  let timerId = 0;

  function renderExam(state, { focusSummary = false } = {}) {
    const { exam, items, secs, legacy } = state;
    live = state.submitted ? null : state;
    awaySince = null;
    onAwayChange = () => {};
    clearInterval(timerId);
    document.title = `${exam.title}｜${BASE_TITLE}`;
    const total = items.length;
    const totalPts = items.reduce((n, it) => n + it.points, 0);

    const list = h('div', { class: 'questions', id: 'questions' });
    const redo = () => { renderExam(buildState(exam)); window.scrollTo(0, 0); };

    // 作答中：底部進度列與「尚未作答」清單
    let bar = null, todoBox = null, submitBtn = null, progText = null, progSub = null, meter = null;
    const refresh = () => {
      const missing = items.filter((it) => !answered(it));
      const done = total - missing.length;
      progText.textContent = `已作答 ${done} / ${total}`;
      progSub.textContent = missing.length ? `還有 ${missing.length} 題沒寫` : '全部寫完了，可以交卷';
      meter.firstChild.style.width = `${(done / total) * 100}%`;
      submitBtn.disabled = missing.length > 0;
      todoBox.hidden = missing.length === 0 || done === 0;
      todoBox.querySelector('.chips').replaceChildren(
        ...missing.map((it) => h('button', {
          type: 'button', class: 'chip todo', 'aria-label': `跳到第 ${it.n} 題`,
          onclick: () => jumpTo(it.n), text: String(it.n)
        }))
      );
    };

    for (const s of secs) {
      if (s.sec.title) list.append(sectionHeadEl(state, s));
      if (s.type === 'cloze' || s.type === 'reading') list.append(passageEl(state, s));
      for (const it of s.items) list.append(questionEl(state, it, { onPick: () => refresh() }));
    }

    const head = h('header', { class: 'exam-head' },
      h('h1', { text: exam.title }),
      h('p', { text: `${exam.scope}・共 ${total} 題` + (legacy ? '' : `・滿分 ${totalPts} 分`) })
    );
    const back = h('a', { class: 'back', href: '#/', text: '‹ 考卷列表' });

    if (!state.submitted) {
      progText = h('div', { class: 'bar-text' });
      progSub = h('div', { class: 'bar-sub' });
      meter = h('div', { class: 'meter', 'aria-hidden': 'true' }, h('div'));
      submitBtn = h('button', { type: 'button', class: 'btn primary', disabled: true, text: '交卷' });
      submitBtn.addEventListener('click', () => {
        if (items.some((it) => !answered(it))) return;
        state.submitted = true;
        state.stats.end = Date.now();
        renderExam(state, { focusSummary: true });
      });
      todoBox = h('section', { class: 'todo-box', hidden: true },
        h('h2', { text: '還沒寫的題號' }),
        h('div', { class: 'chips' })
      );
      const timeEl = h('div', { class: 'bar-time', 'aria-hidden': 'true', text: '0:00' });
      const warnEl = h('div', { class: 'bar-warn', role: 'alert', hidden: true });
      onAwayChange = () => {
        warnEl.hidden = false;
        warnEl.textContent = `⚠ ${awayText(state.stats)}，會記錄在成績單上`;
      };
      timerId = setInterval(() => { timeEl.textContent = fmtDur(Date.now() - state.stats.start); }, 1000);
      bar = h('div', { class: 'bar' },
        h('div', { class: 'bar-inner' },
          h('div', { class: 'bar-info' },
            h('div', { 'aria-live': 'polite' }, progText, progSub),
            meter, warnEl),
          timeEl,
          submitBtn
        )
      );
      app.replaceChildren(back, head, list, todoBox, bar);
      refresh();
    } else {
      const summary = summaryEl(state, {
        redo,
        onlyWrong: (on) => list.classList.toggle('only-wrong', on)
      });
      app.replaceChildren(back, head, summary, list,
        h('div', { class: 'end-actions' },
          h('button', { type: 'button', class: 'btn primary', onclick: redo, text: '重做一次' }),
          h('a', { class: 'btn', href: '#/', text: '考卷列表' })
        ));
      if (focusSummary) {
        window.scrollTo(0, 0);
        summary.focus({ preventScroll: true });
      }
    }
  }

  async function showExam(id, token) {
    if (!/^[\w-]+$/.test(id)) { showMessage('找不到這份考卷。'); return; }
    let exam;
    try {
      exam = unlock(await fetchJSON(`exams/${id}.json`));
    } catch (e) {
      if (token !== routeToken) return;
      showMessage('找不到這份考卷。');
      return;
    }
    if (token !== routeToken) return;
    renderExam(buildState(exam));
    window.scrollTo(0, 0);
  }

  /* ---------- 路由 ---------- */

  function route() {
    const token = ++routeToken;
    live = null;
    clearInterval(timerId);
    const m = location.hash.match(/^#\/exam\/([^/?#]+)/);
    if (m) showExam(decodeURIComponent(m[1]), token);
    else showHome(token);
  }

  route();
})();
