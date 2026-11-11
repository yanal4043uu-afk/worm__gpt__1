const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 4173;

const UPSTREAM = process.env.DS_URL || 'https://asmodeus.free.nf/deepseek.php?i=1';
const UPSTREAM_MODEL = process.env.DS_MODEL || 'DeepSeek-R1-0528';
const IS_CUSTOM_UPSTREAM = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(String(process.env.DS_URL || ''));
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-A155F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

const SEC_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), payment=()',
};

async function fetchUpstream(form, timeoutMs) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
    'Accept-Language': 'ar,en;q=0.8',
  };
  const init = { method: form ? 'POST' : 'GET', headers, redirect: 'follow' };
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  }
  const limit = Math.max(4000, Math.min(120000, Number(timeoutMs) || 75000));
  init.signal = AbortSignal.timeout ? AbortSignal.timeout(limit) : undefined;
  try {
    const r = await fetch(UPSTREAM, init);
    const text = await r.text();
    return { status: r.status, text };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError' || /abort|timeout/i.test(msg))) {
      return { status: 0, text: '', aborted: true };
    }
    return { status: 0, text: '', failed: msg };
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return decodeEntities(String(s)
    .replace(/[ \t]*\r?\n\s*<br\s*\/?>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''));
}

function looksLikeProviderError(text) {
  const t = String(text || '');
  if (/لم يتم العثور على رد|استجابة كاملة|AiError|neurons|Workers Paid|daily free allocation|"code"\s*:\s*4006|PayloadTooLargeError|request entity too large|payload too large|413 Request Entity/i.test(t)) return true;
  if (t.length > 400) return false;
  return /فشل الاتصال|انقطع الاتصال|cURL Error|Operation timed out|Connection timed out|HTTP Code:\s*0|Could not resolve host|Empty reply from server|502 Bad Gateway|503 Service/i.test(t);
}

function tidy(s) {
  let out = String(s)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  out = out.replace(/(```[^\n]*\n)([\s\S]*?)(```)/g, (all, open, body, close) =>
    open + body.replace(/\n{2,}/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '') + '\n' + close);
  return out.trim();
}

function splitThink(rawText) {
  let text = tidy(String(rawText || ''));
  let reasoning = '';
  const think = text.match(/<think[^>]*>([\s\S]*?)<\/think>/i);
  if (think) {
    reasoning = think[1].trim();
    text = tidy(text.replace(think[0], ''));
  }
  if (!text && reasoning) {
    text = reasoning;
    reasoning = '';
  }
  return { text, reasoning };
}

function parseReply(html) {
  const block = html.match(/<div[^>]*class="[^"]*response-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  let raw = block ? block[1] : '';
  if (!raw) {
    const area = html.match(/<div[^>]*class="[^"]*response-area[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    raw = area ? area[1] : '';
  }
  return splitThink(tidy(stripTags(raw)));
}

const ARABIC_RE = /[\u0600-\u06FF]/;

function lastUserText(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const last = msgs.filter((m) => m && m.role !== 'assistant' && typeof m.content === 'string' && m.content.trim()).pop();
  if (last) return last.content;
  return typeof body.question === 'string' ? body.question : '';
}

function languageRule(text) {
  if (ARABIC_RE.test(String(text))) {
    return '[قاعدة اللغة] اكتب الشرح والرد بالعربية الفصحى (ومع أي كود برمجي اكتب سطرًا عربيًا يوضّحه)، ولا تستخدم اللغة الصينية، ولا تبدأ الرد باسمك أو بعبارة مثل «مساعد ذكي:».';
  }
  return '[LANGUAGE RULE] Reply only in the language of the user last message. Do not start the reply with a name or a label such as "Assistant:".';
}

function stripEcho(text) {
  return String(text)
    .replace(/^\s*(?:مساعد ذكي|WORMGPT|Assistant|ASSISTANT|AI)\s*[::\-–]\s*/i, '')
    .replace(/^\s*USER\s*[::]\s*/i, '')
    .trim();
}

const MEMORY_TOKENS = 10000;
const CHARS_PER_TOKEN = 3;
const MAX_ENCODED = 97000;
const MAX_RECENT_CHARS = 24000;
const MAX_OLD_USER_CHARS = 900;
const MAX_OLD_ASSISTANT_CHARS = 600;
const RECENT_TURNS = 6;

function tokenCost(text) {
  return Math.ceil(String(text).length / CHARS_PER_TOKEN) + 4;
}

function encodedSize(text) {
  try { return encodeURIComponent(String(text)).length; } catch (e) { return String(text).length * 3; }
}

function buildQuestion(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const system = typeof body.system === 'string' ? body.system.trim() : '';
  const picked = [];
  let tokens = 0;
  let encoded = 0;
  for (let i = msgs.length - 1; i >= 0 && picked.length < 400; i--) {
    const m = msgs[i];
    if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
    const isUser = m.role !== 'assistant';
    const recent = picked.length < RECENT_TURNS;
    let txt = m.content.trim();
    const cap = recent ? MAX_RECENT_CHARS : (isUser ? MAX_OLD_USER_CHARS : MAX_OLD_ASSISTANT_CHARS);
    if (txt.length > cap) txt = txt.slice(0, cap) + ' …';
    const cost = tokenCost(txt);
    const size = encodedSize(txt) + 12;
    if (picked.length && (tokens + cost > MEMORY_TOKENS || encoded + size > MAX_ENCODED)) break;
    picked.push({ isUser: isUser, txt });
    tokens += cost;
    encoded += size;
  }
  picked.reverse();
  const lines = [];
  if (system) lines.push(system);
  let hasUser = false;
  for (const item of picked) {
    if (item.isUser) hasUser = true;
    lines.push((item.isUser ? 'USER' : 'ASSISTANT') + ': ' + item.txt);
  }
  if (!hasUser && typeof body.question === 'string' && body.question.trim()) {
    lines.push('USER: ' + body.question.trim());
    hasUser = true;
  }
  if (!hasUser) return '';
  lines.push('ASSISTANT:');
  let out = lines.join('\n\n');
  while (encodedSize(out) > MAX_ENCODED && lines.length > 3) {
    lines.splice(1, 1);
    out = lines.join('\n\n');
  }
  return out;
}

function applyGradioDiff(state, diff) {
  if (!Array.isArray(diff) || !diff.length || !Array.isArray(diff[0]) ||
      typeof diff[0][0] !== 'string' ||
      ['append', 'replace', 'add', 'delete'].indexOf(diff[0][0]) === -1) {
    return diff === undefined ? null : JSON.parse(JSON.stringify(diff));
  }
  let out = state === undefined || state === null ? null : JSON.parse(JSON.stringify(state));
  for (const op of diff) {
    if (!Array.isArray(op)) continue;
    const action = op[0];
    const p = op[1];
    const val = op[2];
    if (!Array.isArray(p) || p.length === 0) {
      if (action === 'append') {
        if (typeof out === 'string') out += String(val || '');
        else if (Array.isArray(out)) out.push(val);
      } else if (action === 'replace' || action === 'add') {
        out = val;
      }
      continue;
    }
    let cur = out;
    for (let i = 0; i < p.length - 1; i++) {
      if (cur == null) break;
      cur = cur[p[i]];
    }
    if (cur == null) continue;
    const k = p[p.length - 1];
    if (action === 'append') {
      if (typeof cur[k] === 'string') cur[k] += String(val || '');
      else if (Array.isArray(cur[k])) cur[k].push(val);
    } else if (action === 'replace' || action === 'add') {
      cur[k] = val;
    } else if (action === 'delete') {
      if (Array.isArray(cur)) cur.splice(k, 1);
      else delete cur[k];
    }
  }
  return out;
}

function dataUrlToBlob(dataUrl, fallbackMime) {
  const str = String(dataUrl || '');
  const comma = str.indexOf(',');
  const meta = comma >= 0 ? str.slice(0, comma) : '';
  const b64 = comma >= 0 ? str.slice(comma + 1) : str;
  const mimeMatch = meta.match(/data:([^;]+)/i);
  const mime = (mimeMatch && mimeMatch[1]) || fallbackMime || 'image/png';
  const buf = Buffer.from(b64, 'base64');
  return { blob: new Blob([buf], { type: mime }), mime };
}

async function uploadGradioImages(base, images, sig) {
  if (!Array.isArray(images) || !images.length) return [];
  const fd = new FormData();
  const metas = [];
  for (let i = 0; i < images.length && i < 5; i++) {
    const img = images[i];
    if (!img || !img.dataUrl) continue;
    const conv = dataUrlToBlob(img.dataUrl, img.mime);
    const name = img.name || ('image-' + (i + 1) + '.png');
    fd.append('files', conv.blob, name);
    metas.push({ name, mime: conv.mime });
  }
  if (!metas.length) return [];
  const res = await fetch(base + '/gradio_api/upload', {
    method: 'POST',
    headers: { 'User-Agent': UA },
    body: fd,
    signal: sig,
  });
  if (!res.ok) return [];
  const paths = await res.json();
  if (!Array.isArray(paths)) return [];
  return paths.map((p, i) => ({
    path: p,
    orig_name: (metas[i] && metas[i].name) || ('image-' + (i + 1) + '.png'),
    mime_type: (metas[i] && metas[i].mime) || 'image/png',
    meta: { _type: 'gradio.FileData' },
  }));
}

async function askGradioVision(question, images, wantThink, timeoutMs, onDelta) {
  const base = 'https://coherelabs-command-a-vision.hf.space';
  const sh = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const limit = Math.max(8000, Math.min(75000, Number(timeoutMs) || 45000));
  const sig = AbortSignal.timeout ? AbortSignal.timeout(limit) : undefined;
  try {
    const uploaded = await uploadGradioImages(base, images, sig);
    if (Array.isArray(images) && images.length && !uploaded.length) {
      return { ok: false, stage: 'network' };
    }
    const r1 = await fetch(base + '/gradio_api/queue/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        data: [{ text: question, files: uploaded }, [], 1800],
        fn_index: 7,
        session_hash: sh,
      }),
      signal: sig,
    });
    if (!r1.ok) return { ok: false, stage: 'network' };
    const r2 = await fetch(base + '/gradio_api/queue/data?session_hash=' + sh, {
      headers: { 'User-Agent': UA },
      signal: sig,
    });
    if (!r2.ok || !r2.body) return { ok: false, stage: 'network' };
    const reader = r2.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let state = null;
    let emittedText = '';
    let finalOut = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data: ')) continue;
        let o;
        try { o = JSON.parse(line.slice(6)); } catch (e) { continue; }
        if (o.msg === 'estimation' && o.rank >= 3 && (!images || !images.length)) {
          try { reader.cancel(); } catch (e) {}
          return { ok: false, stage: 'busy' };
        }
        if ((o.msg === 'process_generating' || o.msg === 'process_completed') && o.output && Array.isArray(o.output.data)) {
          state = o.msg === 'process_completed' ? o.output.data[0] : applyGradioDiff(state, o.output.data[0]);
          const cur = typeof state === 'string' ? state : '';
          if (onDelta && cur.length > emittedText.length && cur.startsWith(emittedText)) {
            onDelta(cur.slice(emittedText.length), '');
            emittedText = cur;
          }
          if (o.msg === 'process_completed') {
            finalOut = cur;
            break;
          }
        }
      }
      if (finalOut !== null) {
        try { reader.cancel(); } catch (e) {}
        break;
      }
    }
    const text = tidy(stripEcho(finalOut || emittedText || ''));
    if (text && !looksLikeProviderError(text)) {
      return { ok: true, text, reasoning: '' };
    }
    return { ok: false, stage: 'parse' };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError' || /abort|timeout/i.test(msg))) {
      return { ok: false, stage: 'timeout' };
    }
    return { ok: false, stage: 'network' };
  }
}

async function askGradioReasoning(question, wantThink, timeoutMs, onDelta) {
  const base = 'https://coherelabs-command-a-reasoning.hf.space';
  const sh = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const limit = Math.max(8000, Math.min(75000, Number(timeoutMs) || 45000));
  const sig = AbortSignal.timeout ? AbortSignal.timeout(limit) : undefined;
  try {
    const r1 = await fetch(base + '/gradio_api/queue/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        data: [question, [], wantThink ? 500 : 0],
        fn_index: 7,
        session_hash: sh,
      }),
      signal: sig,
    });
    if (!r1.ok) return { ok: false, stage: 'network' };
    const r2 = await fetch(base + '/gradio_api/queue/data?session_hash=' + sh, {
      headers: { 'User-Agent': UA },
      signal: sig,
    });
    if (!r2.ok || !r2.body) return { ok: false, stage: 'network' };
    const reader = r2.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let state = null;
    let emittedText = '';
    let emittedReason = '';
    let completed = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data: ')) continue;
        let o;
        try { o = JSON.parse(line.slice(6)); } catch (e) { continue; }
        if (o.msg === 'estimation' && o.rank >= 3) {
          try { reader.cancel(); } catch (e) {}
          return { ok: false, stage: 'busy' };
        }
        if ((o.msg === 'process_generating' || o.msg === 'process_completed') && o.output && Array.isArray(o.output.data)) {
          state = o.msg === 'process_completed' ? o.output.data[0] : applyGradioDiff(state, o.output.data[0]);
          if (Array.isArray(state)) {
            let rsn = '';
            let ans = '';
            for (const m of state) {
              if (!m || typeof m.content !== 'string') continue;
              if (m.metadata && m.metadata.title) rsn += m.content;
              else ans += m.content;
            }
            if (onDelta) {
              if (wantThink && rsn.length > emittedReason.length && rsn.startsWith(emittedReason)) {
                onDelta('', rsn.slice(emittedReason.length));
                emittedReason = rsn;
              }
              if (ans.length > emittedText.length && ans.startsWith(emittedText)) {
                onDelta(ans.slice(emittedText.length), '');
                emittedText = ans;
              }
            } else {
              emittedText = ans;
              emittedReason = rsn;
            }
          }
          if (o.msg === 'process_completed') {
            completed = true;
            break;
          }
        }
      }
      if (completed) {
        try { reader.cancel(); } catch (e) {}
        break;
      }
    }
    let text = tidy(stripEcho(emittedText));
    let reasoning = emittedReason.trim();
    if (!text && reasoning) { text = tidy(stripEcho(reasoning)); reasoning = ''; }
    if (text && !looksLikeProviderError(text)) {
      return { ok: true, text, reasoning: wantThink ? reasoning : '' };
    }
    return { ok: false, stage: 'parse' };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError' || /abort|timeout/i.test(msg))) {
      return { ok: false, stage: 'timeout' };
    }
    return { ok: false, stage: 'network' };
  }
}

async function askGradioPlus(question, images, wantThink, timeoutMs, onDelta) {
  const base = 'https://coherelabs-command-a-plus-05-2026.hf.space';
  const sh = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const limit = Math.max(8000, Math.min(75000, Number(timeoutMs) || 45000));
  const sig = AbortSignal.timeout ? AbortSignal.timeout(limit) : undefined;
  try {
    const uploaded = await uploadGradioImages(base, images, sig);
    const r1 = await fetch(base + '/gradio_api/queue/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        data: [{ text: question, files: uploaded }, []],
        fn_index: 7,
        session_hash: sh,
      }),
      signal: sig,
    });
    if (!r1.ok) return { ok: false, stage: 'network' };
    const r2 = await fetch(base + '/gradio_api/queue/data?session_hash=' + sh, {
      headers: { 'User-Agent': UA },
      signal: sig,
    });
    if (!r2.ok || !r2.body) return { ok: false, stage: 'network' };
    const reader = r2.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let state = null;
    let emittedText = '';
    let completed = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data: ')) continue;
        let o;
        try { o = JSON.parse(line.slice(6)); } catch (e) { continue; }
        if ((o.msg === 'process_generating' || o.msg === 'process_completed') && o.output && Array.isArray(o.output.data)) {
          state = o.msg === 'process_completed' ? o.output.data[0] : applyGradioDiff(state, o.output.data[0]);
          const raw = String(state || '');
          if (raw.indexOf('</think>') >= 0 || raw.indexOf('<think>') === -1) {
            const parsed = splitThink(raw);
            if (onDelta && parsed.text.length > emittedText.length && parsed.text.startsWith(emittedText)) {
              onDelta(parsed.text.slice(emittedText.length), '');
              emittedText = parsed.text;
            }
          }
          if (o.msg === 'process_completed') {
            completed = true;
            break;
          }
        }
      }
      if (completed) {
        try { reader.cancel(); } catch (e) {}
        break;
      }
    }
    const parsed = splitThink(String(state || ''));
    const text = tidy(stripEcho(parsed.text));
    if (text && !looksLikeProviderError(text)) {
      return { ok: true, text, reasoning: wantThink ? parsed.reasoning : '' };
    }
    return { ok: false, stage: 'parse' };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError' || /abort|timeout/i.test(msg))) {
      return { ok: false, stage: 'timeout' };
    }
    return { ok: false, stage: 'network' };
  }
}

async function askPollinations(question, images, wantThink, timeoutMs) {
  const limit = Math.max(8000, Math.min(60000, Number(timeoutMs) || 35000));
  const sig = AbortSignal.timeout ? AbortSignal.timeout(limit) : undefined;
  try {
    let userContent = question;
    if (Array.isArray(images) && images.length) {
      userContent = [{ type: 'text', text: question }];
      for (let i = 0; i < images.length && i < 5; i++) {
        if (images[i] && images[i].dataUrl) {
          userContent.push({ type: 'image_url', image_url: { url: images[i].dataUrl } });
        }
      }
    }
    const res = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        model: Array.isArray(images) && images.length ? 'openai' : 'openai-fast',
        messages: [{ role: 'user', content: userContent }],
        seed: Math.floor(Math.random() * 1000000),
      }),
      signal: sig,
    });
    if (!res.ok) return { ok: false, stage: 'provider' };
    const data = await res.json();
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) return { ok: false, stage: 'parse' };
    const parsed = splitThink(String(msg.content || ''));
    const text = tidy(stripEcho(parsed.text));
    const reasoning = String(msg.reasoning || parsed.reasoning || '').trim();
    if (text && !looksLikeProviderError(text)) {
      return { ok: true, text, reasoning: wantThink ? reasoning : '' };
    }
    return { ok: false, stage: 'parse' };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError' || /abort|timeout/i.test(msg))) {
      return { ok: false, stage: 'timeout' };
    }
    return { ok: false, stage: 'network' };
  }
}

async function searchWeb(query) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  if (!q || q.length < 5 || /^(?:كيفك|كيف الحال|كيف حالك|مرحبا|مرحبًا|اهلا|أهلا|أهلاً|هلا|سلام|السلام عليكم|صباح الخير|مساء الخير|شلونك|شو الاخبار|شو أخبارك|شخبارك|قل\s*:|hi|hello|hey|how are you)[\s!?.،؟]*$/i.test(q)) return [];
  const out = [];
  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ]);
  const wiki = async (lang) => {
    try {
      const url = 'https://' + lang + '.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=' + encodeURIComponent(q);
      const r = await withTimeout(fetch(url, { headers: { 'User-Agent': 'WORMGPT/1.0', 'Accept': 'application/json' } }), 4500);
      if (!r || !r.ok) return;
      const data = await r.json();
      const hits = (data && data.query && data.query.search) || [];
      for (const hit of hits) {
        const snippet = String(hit.snippet || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (snippet) out.push('(' + lang + ') ' + hit.title + ': ' + snippet);
      }
    } catch (e) {}
  };
  try {
    const ddg = await withTimeout(fetch('https://api.duckduckgo.com/?format=json&no_html=1&q=' + encodeURIComponent(q), {
      headers: { 'User-Agent': 'WORMGPT/1.0' }
    }), 4000);
    if (ddg && ddg.ok) {
      const d = await ddg.json();
      if (d && d.AbstractText) out.push('DDG: ' + String(d.AbstractText).slice(0, 320));
      const topics = (d && d.RelatedTopics) || [];
      for (const tp of topics.slice(0, 3)) {
        if (tp && tp.Text) out.push('DDG: ' + String(tp.Text).slice(0, 220));
      }
    }
  } catch (e) {}
  await Promise.all([wiki('ar'), wiki('en')]);
  return out.slice(0, 8);
}

function sendJSON(res, code, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }, SEC_HEADERS));
  res.end(payload);
}

function sseWrite(res, obj) {
  try { res.write(JSON.stringify(obj) + '\n'); } catch (e) {}
}

async function handleChat(req, res) {
  let raw = '';
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) { req.destroy(); return; }
    raw += chunk;
  });
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }
    const images = Array.isArray(body.images) ? body.images.slice(0, 5) : [];
    let question = buildQuestion(body);
    if (!question.trim() && images.length) {
      question = 'USER: حلّل الصورة المرفقة واشرح محتواها بالتفصيل.\n\nASSISTANT:';
    }
    if (!question.trim()) return sendJSON(res, 400, { ok: false, error: 'الرسالة فارغة' });

    const model = typeof body.model === 'string' && /^[\w.\-]{2,40}$/.test(body.model)
      ? body.model : UPSTREAM_MODEL;

    res.writeHead(200, Object.assign({
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
    }, SEC_HEADERS));

    let lastTransport = '';
    let lastDetail = '';
    sseWrite(res, { stage: 'start' });

    const beat = setInterval(() => sseWrite(res, { stage: 'alive' }), 4000);

    const userText = lastUserText(body);
    const wantArabic = ARABIC_RE.test(String(userText)) || (!userText && images.length > 0);
    const wantThink = !/Do not include a <think> block/i.test(String(body.system || ''));
    let systemText = String(body.system || '') + '\n\n' + languageRule(userText || 'حلّل الصورة');
    let langRetry = false;
    if (body.search !== false && !images.length) {
      const lastUser = (Array.isArray(body.messages) ? body.messages : [])
        .filter((m) => m && m.role !== 'assistant' && typeof m.content === 'string')
        .pop();
      const query = lastUser ? lastUser.content.slice(0, 220) : '';
      const results = await searchWeb(query);
      if (results.length) {
        systemText += '\n\n[WEB SEARCH CONTEXT — use silently, never mention that you searched]\n' + results.join('\n');
      }
    }
    sseWrite(res, { stage: 'generating' });

    try {
      const startedAt = Date.now();
      const DEADLINE = Number(process.env.DS_DEADLINE || 150000);
      const base = systemText ? (systemText + '\n\n' + question) : question;
      let scale = 1;
      for (let attempt = 0; attempt < 4; attempt++) {
        const left = DEADLINE - (Date.now() - startedAt);
        if (left < 5000) break;
        const perTry = Math.min(Number(process.env.DS_TRY || 70000), Math.max(4000, left - 2000));
        const merged = scale >= 1 ? base : base.slice(-Math.floor(base.length * scale));
        if (!images.length) {
          const out = await fetchUpstream({ model, question: merged }, IS_CUSTOM_UPSTREAM ? perTry : Math.min(6000, perTry));
          if (out.aborted || out.failed) {
            lastTransport = out.aborted ? 'timeout' : 'network';
            if (IS_CUSTOM_UPSTREAM) continue;
          } else if (!/slowAES\.decrypt/.test(out.text) && !/requires Javascript/i.test(out.text)) {
            const parsed = parseReply(out.text);
            if (parsed.text) parsed.text = stripEcho(parsed.text);
            if (parsed.text && !looksLikeProviderError(parsed.text)) {
              if (wantArabic && !ARABIC_RE.test(parsed.text) && !langRetry) {
                langRetry = true;
                continue;
              }
              clearInterval(beat);
              sseWrite(res, { ok: true, text: parsed.text, reasoning: wantThink ? parsed.reasoning : '', model });
              return res.end();
            }
            if (parsed.text && /PayloadTooLarge|request entity too large|413 Request Entity/i.test(parsed.text)) {
              scale = 0.45;
            }
            const err = stripTags((out.text.match(/<div[^>]*class="[^"]*(?:error|alert)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '').trim();
            lastTransport = parsed.text ? 'provider' : 'parse';
            lastDetail = err || 'رد بلا محتوى مفهوم';
            if (IS_CUSTOM_UPSTREAM) continue;
          }
          if (IS_CUSTOM_UPSTREAM) continue;
        }

        const fns = images.length
          ? [
              (q, wt, t, od) => askGradioVision(q, images, wt, t, od),
              (q, wt, t, od) => askGradioPlus(q, images, wt, t, od),
              (q, wt, t) => askPollinations(q, images, wt, t),
            ]
          : [
              (q, wt, t, od) => askGradioReasoning(q, wt, t, od),
              (q, wt, t, od) => askGradioVision(q, [], wt, t, od),
              (q, wt, t, od) => askGradioPlus(q, [], wt, t, od),
              (q, wt, t) => askPollinations(q, [], wt, t),
            ];

        for (const fn of fns) {
          let arVerified = !wantArabic;
          let pendingDelta = '';
          const onDelta = (deltaText, deltaReasoning) => {
            if (deltaReasoning) {
              sseWrite(res, { stage: 'delta', reasoning_delta: deltaReasoning });
            }
            if (deltaText) {
              if (!arVerified) {
                pendingDelta += deltaText;
                if (ARABIC_RE.test(pendingDelta)) {
                  arVerified = true;
                  sseWrite(res, { stage: 'delta', delta: pendingDelta });
                  pendingDelta = '';
                }
              } else {
                sseWrite(res, { stage: 'delta', delta: deltaText });
              }
            }
          };
          const fRes = await fn(merged, wantThink, perTry, onDelta);
          if (fRes.ok) {
            if (wantArabic && !ARABIC_RE.test(fRes.text) && !langRetry) {
              langRetry = true;
              continue;
            }
            clearInterval(beat);
            sseWrite(res, { ok: true, text: fRes.text, reasoning: fRes.reasoning, model });
            return res.end();
          }
          if (fRes.stage) lastTransport = fRes.stage;
        }
      }
      clearInterval(beat);
      const timedOut = lastTransport === 'timeout' || lastTransport === 'network';
      sseWrite(res, {
        ok: false,
        error: timedOut
          ? 'تأخّر المزوّد ولم يصل رد في الوقت المتاح — أعد الإرسال، وإن تكرّر فاختبر /api/chat?ping=1'
          : ('لم يصل رد من المزوّد' + (lastDetail ? ': ' + lastDetail : '')),
        stage: lastTransport
      });
      return res.end();
    } catch (e) {
      clearInterval(beat);
      sseWrite(res, { ok: false, error: 'تعذّر الوصول إلى المزوّد: ' + (e && e.message ? e.message : 'خطأ') });
      return res.end();
    }
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (urlPath === '/api/chat') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, Object.assign({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      }, SEC_HEADERS));
      return res.end();
    }
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'استخدم POST' });
    return handleChat(req, res);
  }

  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const abs = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

  if (!abs.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(abs, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — غير موجود');
    }
    res.writeHead(200, Object.assign({
      'Content-Type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    }, SEC_HEADERS));
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('WORMGPT (DeepSeek-R1-0528 via ' + UPSTREAM + ') -> http://0.0.0.0:' + PORT);
});
