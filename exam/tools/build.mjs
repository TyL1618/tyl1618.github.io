// 驗證 exam/exams/*.json，加密答案欄位，並重新產生 exam/exams/index.json
// 用法：node exam/tools/build.mjs               驗證 + 加密新考卷 + 產生 index.json
//       node exam/tools/build.mjs --check       只驗證，不寫任何檔案
//       node exam/tools/build.mjs --decode 0915 把已加密的考卷還原成明文，輸出到 exam/exams-plain/（不會被 git 提交）
//       node exam/tools/build.mjs --unlock 1117 把「鎖住」的考卷（exam/exams-locked/，只在本機）開放：搬進 exams/ 並加密，接著照常 build
//
// 鎖住的考卷：明文放在 exam/exams-locked/<id>.json（被 .gitignore 擋住，不會進 git、也不會上線）。
// 首頁清單仍會出現一張「尚未開放」的卡片（index.json 裡 locked: true、沒有 file），學生點不了，
// 也猜不到網址，因為檔案根本沒有發布。

// 加密只是輕度混淆（base64）：目的是讓學生打開 JSON 時不會直接看到明文答案，
// 不是真正的安全機制。答案、中譯、解析三個欄位會被收進一個 "secret" 欄位。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const examRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const examsDir = join(examRoot, 'exams');
const plainDir = join(examRoot, 'exams-plain');
const lockedDir = join(examRoot, 'exams-locked');
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');

const CATEGORIES = ['單字', '片語', '文法'];
const EXAM_KEYS = ['id', 'title', 'scope', 'questionCount', 'shuffleQuestions', 'shuffleOptions', 'questions', 'sections', 'secret'];
const Q_KEYS = ['id', 'category', 'sentence', 'stem', 'options', 'answer', 'hint', 'accept', 'zh', 'note'];
// sections 格式（仿段考多題型）：每個 section 一種題型
//   single  單一（或兩個）___ 的四選一；sentence 可含換行（對話）；兩空時每個選項要用 " / " 分成兩段
//   cloze   一篇短文 passage 內有多個 ___，questions 依序對應各空格，每題四選一
//   reading 一篇 passage 加多題，每題有 stem（題幹）與四個選項
//   spell   文意字彙：sentence 有一個 ___，answer 是要拼出來的英文單字（自動產生首尾字母提示 hint）
const SECTION_KEYS = ['id', 'title', 'type', 'points', 'intro', 'passage', 'shuffle', 'questions'];
const SECTION_TYPES = ['single', 'cloze', 'reading', 'spell'];
const SECRET_KEYS = ['answer', 'zh', 'note', 'accept'];

const spellHint = (word) => {
  const cs = [...word];
  return cs.map((c, i) => (i === 0 || i === cs.length - 1 || !/[A-Za-z]/.test(c) ? c : '_')).join(' ');
};

/* ---------- 加密／解密 ---------- */

const b64encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const b64decode = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

function encodeExam(exam) {
  const out = { id: exam.id, title: exam.title, scope: exam.scope, questionCount: exam.questionCount };
  for (const k of ['shuffleQuestions', 'shuffleOptions']) if (k in exam) out[k] = exam[k];
  if (Array.isArray(exam.sections)) {
    // sections 格式：公開欄位照原樣保留，只把 SECRET_KEYS 收進 secret（依序攤平所有題目）
    const secret = [];
    out.sections = exam.sections.map((sec) => {
      const o = {};
      for (const [k, v] of Object.entries(sec)) {
        if (k !== 'questions') o[k] = v;
      }
      o.questions = sec.questions.map((q) => {
        const pub = {};
        const sec1 = {};
        for (const [k, v] of Object.entries(q)) {
          if (SECRET_KEYS.includes(k)) sec1[k] = v;
          else pub[k] = v;
        }
        if (sec.type === 'spell' && !pub.hint) pub.hint = spellHint(String(q.answer));
        secret.push(sec1);
        return pub;
      });
      return o;
    });
    out.secret = b64encode(secret);
    return out;
  }
  out.questions = exam.questions.map((q) => {
    const o = { id: q.id };
    if ('category' in q) o.category = q.category;
    o.sentence = q.sentence;
    o.options = q.options;
    return o;
  });
  out.secret = b64encode(exam.questions.map((q) => ({ answer: q.answer, zh: q.zh, note: q.note })));
  return out;
}

// 把有 secret 的考卷還原成完整明文結構；失敗時丟出 Error
function decodeExam(exam) {
  const sec = b64decode(exam.secret);
  if (Array.isArray(exam.sections)) {
    const total = exam.sections.reduce((n, s) => n + (Array.isArray(s.questions) ? s.questions.length : 0), 0);
    if (!Array.isArray(sec) || sec.length !== total) throw new Error('secret 內的題數與 sections 不符');
    let i = 0;
    const out = { ...exam };
    delete out.secret;
    out.sections = exam.sections.map((s) => ({
      ...s,
      questions: s.questions.map((q) => ({ ...q, ...sec[i++] }))
    }));
    return out;
  }
  if (!Array.isArray(sec) || !Array.isArray(exam.questions) || sec.length !== exam.questions.length) {
    throw new Error('secret 內的題數與 questions 不符');
  }
  const out = { ...exam };
  delete out.secret;
  out.questions = exam.questions.map((q, i) => {
    const o = { id: q.id };
    if ('category' in q) o.category = q.category;
    o.sentence = q.sentence;
    o.options = q.options;
    o.answer = sec[i].answer;
    o.zh = sec[i].zh;
    o.note = sec[i].note;
    return o;
  });
  return out;
}

/* ---------- --decode <id> ---------- */

const di = argv.indexOf('--decode');
if (di !== -1) {
  const id = argv[di + 1];
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    console.error('用法：node exam/tools/build.mjs --decode <考卷id>');
    process.exit(1);
  }
  const src = join(examsDir, `${id}.json`);
  if (!existsSync(src)) {
    console.error(`找不到 ${src}`);
    process.exit(1);
  }
  const exam = JSON.parse(readFileSync(src, 'utf8'));
  const plain = 'secret' in exam ? decodeExam(exam) : exam;
  mkdirSync(plainDir, { recursive: true });
  const dest = join(plainDir, `${id}.json`);
  writeFileSync(dest, JSON.stringify(plain, null, 2) + '\n', 'utf8');
  console.log(`✓ 已還原成明文：${dest}`);
  console.log('  修改後把檔案複製回 exam/exams/ 覆蓋，再執行一次 build.mjs 即可重新加密。');
  process.exit(0);
}

/* ---------- --unlock <id> ---------- */

const ui = argv.indexOf('--unlock');
if (ui !== -1) {
  const id = argv[ui + 1];
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    console.error('用法：node exam/tools/build.mjs --unlock <考卷id>');
    process.exit(1);
  }
  const src = join(lockedDir, `${id}.json`);
  const dest = join(examsDir, `${id}.json`);
  if (!existsSync(src)) {
    console.error(`找不到鎖住的考卷 ${src}`);
    process.exit(1);
  }
  if (existsSync(dest)) {
    console.error(`exams/ 已經有 ${id}.json，請先處理重複的 id`);
    process.exit(1);
  }
  renameSync(src, dest);
  console.log(`🔓 已開放 ${id}：exams-locked/ → exams/（以下照常驗證並加密）`);
}

/* ---------- 驗證 ---------- */

const errors = [];
const warnings = [];
const err = (file, where, msg) => errors.push(`${file}${where ? ` ${where}` : ''}：${msg}`);
const warn = (file, where, msg) => warnings.push(`${file}${where ? ` ${where}` : ''}：${msg}`);

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isInt = (v) => Number.isInteger(v);

function validDate(title) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(title);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const listJson = (dir) => (existsSync(dir) ? readdirSync(dir) : [])
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .sort();

// 驗證單一題目。legacy = 舊格式（整份只有 questions、單一空格）
function validateQ(file, where, q, type, seenQ, legacy = false) {
  if (q === null || typeof q !== 'object' || Array.isArray(q)) { err(file, where, '必須是物件'); return; }
  for (const k of Object.keys(q)) {
    if (!Q_KEYS.includes(k)) warn(file, where, `未知欄位 "${k}"`);
  }
  if (!isInt(q.id)) err(file, where, 'id 缺少或不是整數');
  else if (seenQ.has(q.id)) err(file, where, `題目 id ${q.id} 重複`);
  else seenQ.add(q.id);

  if ('category' in q && !CATEGORIES.includes(q.category)) {
    err(file, where, `category 只能是 ${CATEGORIES.join('、')}（目前是 ${JSON.stringify(q.category)}）`);
  }

  // 題幹：single / spell 用 sentence（含 ___）；reading 用 stem；cloze 沒有題幹（空格在 passage 裡）
  let blanks = 0;
  if (type === 'single' || type === 'spell') {
    if (!isStr(q.sentence)) err(file, where, 'sentence 缺少或不是字串');
    else {
      const runs = q.sentence.match(/_+/g) || [];
      blanks = q.sentence.split('___').length - 1;
      const maxBlanks = type === 'single' && !legacy ? 2 : 1;
      if (runs.some((r) => r !== '___') || blanks < 1 || blanks > maxBlanks) {
        err(file, where, `sentence 必須有${maxBlanks === 2 ? ' 1 或 2 個' : '恰好一個'} "___"（目前底線片段：${runs.length ? runs.map((r) => `"${r}"`).join('、') : '無'}）`);
      }
    }
  } else if (type === 'reading') {
    if (!isStr(q.stem)) err(file, where, 'reading 題需要 stem（題幹）');
  } else if (type === 'cloze' && 'sentence' in q) {
    warn(file, where, 'cloze 題不需要 sentence');
  }

  if (type === 'spell') {
    if (!isStr(q.answer) || !/^[A-Za-z][A-Za-z' -]*[A-Za-z]$/.test(q.answer.trim())) {
      err(file, where, `spell 題的 answer 必須是英文單字字串（目前是 ${JSON.stringify(q.answer)}）`);
    }
    if ('accept' in q && !(Array.isArray(q.accept) && q.accept.every(isStr))) err(file, where, 'accept 必須是字串陣列');
    if ('hint' in q && !isStr(q.hint)) err(file, where, 'hint 必須是非空字串');
    if ('options' in q) warn(file, where, 'spell 題不需要 options');
  } else {
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      err(file, where, `options 必須恰好 4 個（目前是 ${Array.isArray(q.options) ? q.options.length : '非陣列'} 個）`);
    } else {
      if (!q.options.every(isStr)) err(file, where, 'options 每一項都必須是非空字串');
      else if (new Set(q.options.map((o) => o.trim().toLowerCase())).size !== 4) err(file, where, 'options 有重複的選項');
      else if (blanks === 2 && !q.options.every((o) => o.split(' / ').length === 2)) {
        err(file, where, '兩個空格的題目，每個選項都要用 " / " 分成恰好兩段（例如 "which / lives"）');
      }
    }
    if (!isInt(q.answer) || q.answer < 0 || q.answer > 3) {
      err(file, where, `answer 必須是 0~3 的整數（目前是 ${JSON.stringify(q.answer)}）`);
    }
  }
  if (!isStr(q.zh)) err(file, where, 'zh（中文翻譯）缺少或是空的');
  if (!isStr(q.note)) err(file, where, 'note（重點解析）缺少或是空的');
}

const sources = [
  ...listJson(examsDir).map((f) => ({ f, dir: examsDir, locked: false })),
  ...listJson(lockedDir).map((f) => ({ f, dir: lockedDir, locked: true }))
];

if (sources.length === 0) err('exams/', '', '沒有找到任何考卷 JSON');

const entries = [];
const toEncrypt = []; // 目前還是明文的檔案
const seenIds = new Map();

for (const { f, dir, locked } of sources) {
  const file = locked ? `exams-locked/${f}` : f; // 錯誤訊息用的名稱
  let exam;
  try {
    exam = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  } catch (e) {
    err(file, '', `不是合法的 JSON（${e.message}）`);
    continue;
  }
  if (exam === null || typeof exam !== 'object' || Array.isArray(exam)) {
    err(file, '', '最外層必須是物件');
    continue;
  }

  let wasEncrypted = false;
  if ('secret' in exam) {
    try {
      exam = decodeExam(exam);
      wasEncrypted = true;
    } catch (e) {
      err(file, '', `secret 解碼失敗（${e.message}）`);
      continue;
    }
  }

  for (const k of Object.keys(exam)) {
    if (!EXAM_KEYS.includes(k)) warn(file, '', `未知欄位 "${k}"（是不是打錯了？）`);
  }

  if (!isStr(exam.id) || !/^[A-Za-z0-9_-]+$/.test(exam.id)) {
    err(file, '', 'id 必須是只含英數、底線、連字號的字串');
  } else {
    if (exam.id + '.json' !== f) err(file, '', `id "${exam.id}" 必須和檔名一致（應為 ${exam.id}.json）`);
    if (seenIds.has(exam.id)) err(file, '', `id "${exam.id}" 與 ${seenIds.get(exam.id)} 重複`);
    else seenIds.set(exam.id, file);
  }
  if (!isStr(exam.title)) err(file, '', 'title 缺少或不是字串');
  else if (!validDate(exam.title)) err(file, '', `title 必須是日期格式 YYYY/MM/DD（目前是 "${exam.title}"）`);
  if (!isStr(exam.scope)) err(file, '', 'scope 缺少或不是字串');
  for (const k of ['shuffleQuestions', 'shuffleOptions']) {
    if (k in exam && typeof exam[k] !== 'boolean') err(file, '', `${k} 必須是 true 或 false`);
  }

  const seenQ = new Set();
  let total = 0;
  let withCat = 0;

  if (Array.isArray(exam.sections)) {
    if ('questions' in exam) err(file, '', 'sections 與 questions 不能同時存在');
    if (exam.sections.length === 0) { err(file, '', 'sections 不能是空陣列'); continue; }
    exam.sections.forEach((sec, si) => {
      const sw = `第 ${si + 1} 區`;
      if (sec === null || typeof sec !== 'object' || Array.isArray(sec)) { err(file, sw, '必須是物件'); return; }
      for (const k of Object.keys(sec)) if (!SECTION_KEYS.includes(k)) warn(file, sw, `未知欄位 "${k}"`);
      if (!isStr(sec.title)) err(file, sw, 'title 缺少或不是字串');
      if (!SECTION_TYPES.includes(sec.type)) { err(file, sw, `type 只能是 ${SECTION_TYPES.join('、')}`); return; }
      if ('points' in sec && !(isInt(sec.points) && sec.points >= 1)) err(file, sw, 'points 必須是 >= 1 的整數');
      if ('intro' in sec && !isStr(sec.intro)) err(file, sw, 'intro 必須是非空字串');
      if ('shuffle' in sec && typeof sec.shuffle !== 'boolean') err(file, sw, 'shuffle 必須是 true 或 false');
      if (!Array.isArray(sec.questions) || sec.questions.length === 0) { err(file, sw, 'questions 必須是非空陣列'); return; }
      if (sec.type === 'cloze' || sec.type === 'reading') {
        if (!isStr(sec.passage)) err(file, sw, `${sec.type} 區需要 passage（短文）`);
        else if (sec.type === 'cloze') {
          const runs = sec.passage.match(/_+/g) || [];
          const blanks = sec.passage.split('___').length - 1;
          if (runs.some((r) => r !== '___')) err(file, sw, 'passage 的空格一律寫成三個底線 "___"');
          else if (blanks !== sec.questions.length) err(file, sw, `passage 有 ${blanks} 個空格，但 questions 有 ${sec.questions.length} 題`);
        }
      } else if ('passage' in sec) warn(file, sw, `${sec.type} 區不會顯示 passage`);
      sec.questions.forEach((q, i) => {
        total++;
        validateQ(file, `${sw}第 ${i + 1} 題（id ${q && q.id}）`, q, sec.type, seenQ);
        if (q && typeof q === 'object' && 'category' in q) withCat++;
      });
    });
  } else {
    if (!Array.isArray(exam.questions) || exam.questions.length === 0) {
      err(file, '', 'questions（或 sections）必須是非空陣列');
      continue;
    }
    exam.questions.forEach((q, i) => {
      total++;
      validateQ(file, `第 ${i + 1} 題`, q, 'single', seenQ, true);
      if (q && typeof q === 'object' && 'category' in q) withCat++;
    });
    if (withCat !== 0 && withCat !== exam.questions.length) {
      warn(file, '', `只有 ${withCat}/${exam.questions.length} 題有 category；沒標的題目不會計入題型統計`);
    }
  }
  if (!isInt(exam.questionCount)) err(file, '', 'questionCount 缺少或不是整數');
  else if (exam.questionCount !== total) {
    err(file, '', `questionCount 是 ${exam.questionCount}，但實際有 ${total} 題`);
  }

  if (isStr(exam.id) && isStr(exam.title) && isStr(exam.scope) && isInt(exam.questionCount)) {
    const entry = { id: exam.id, title: exam.title, scope: exam.scope, questionCount: exam.questionCount };
    if (locked) entry.locked = true; // 鎖住的不給 file，網站上只會是一張點不了的卡片
    else entry.file = `exams/${f}`;
    entries.push(entry);
  }
  if (!wasEncrypted && !locked) toEncrypt.push({ file: f, exam });
}

for (const w of warnings) console.warn(`⚠ ${w}`);

if (errors.length) {
  console.error(`\n✗ 發現 ${errors.length} 個問題，沒有更新 index.json、也沒有加密任何檔案：\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

// 日期由新到舊；同一天的以 id 由大到小
entries.sort((a, b) => b.title.localeCompare(a.title) || b.id.localeCompare(a.id));

if (checkOnly) {
  console.log(`✓ ${entries.length} 份考卷驗證通過（--check：未寫入任何檔案）`);
  if (toEncrypt.length) {
    console.warn(`⚠ 尚未加密：${toEncrypt.map((x) => x.file).join('、')}（不加 --check 執行時會自動加密）`);
  }
} else {
  for (const { file, exam } of toEncrypt) {
    writeFileSync(join(examsDir, file), JSON.stringify(encodeExam(exam), null, 2) + '\n', 'utf8');
    console.log(`🔒 已加密 ${file}`);
  }
  writeFileSync(join(examsDir, 'index.json'), JSON.stringify({ exams: entries }, null, 2) + '\n', 'utf8');
  console.log(`✓ ${entries.length} 份考卷驗證通過，已更新 exams/index.json`);
  for (const e of entries) console.log(`  ${e.title}  ${e.id}  ${e.questionCount} 題  ${e.locked ? '🔒鎖住  ' : ''}${e.scope}`);
}
