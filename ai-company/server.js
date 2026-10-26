import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  PROVIDER = 'gemini', MODEL_NAME = 'gemini-3.5-flash', API_KEY = '', OLLAMA_URL = 'http://localhost:11434',
  APP_PASSWORD = '', PORT = 3000, DATA_DIR = path.join(__dirname, 'data'),
  MAX_PROMPT_CHARS = '30000', TRUST_PROXY = '0', RATE_LIMIT_PER_MIN = '40'
} = process.env;

if (!['gemini', 'ollama'].includes(PROVIDER)) { console.error('PROVIDER لازم يكون gemini أو ollama'); process.exit(1); }
if (!MODEL_NAME) { console.error('MODEL_NAME مطلوب في .env'); process.exit(1); }
if (PROVIDER === 'gemini' && !API_KEY) {
  console.warn('⚠️ تنبيه: لم يتم تعيين API_KEY في .env — سيعمل النظام تجريبياً حتى إضافة المفتاح.');
}
if (!APP_PASSWORD) console.warn('⚠️ APP_PASSWORD فاضي: أي حد يوصل للموقع هيستهلك الـ API بتاعك');

fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE = path.join(DATA_DIR, 'state.json');

const app = express();
app.set('trust proxy', Number(TRUST_PROXY));
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], scriptSrcAttr: ["'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ['https://fonts.gstatic.com'],
  imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"]
} } }));
app.use(express.json({ limit: '25mb' }));

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const auth = (req, res, next) => {
  if (!APP_PASSWORD) return next();
  if (crypto.timingSafeEqual(sha(req.get('x-access-code') || ''), sha(APP_PASSWORD))) return next();
  res.status(401).json({ error: 'unauthorized' });
};

app.get('/favicon.ico', (_, res) => res.status(204).end());
app.get('/healthz', (_, res) => res.send('ok'));
app.get('/api/config', (_, res) => res.json({ auth: !!APP_PASSWORD }));

app.get('/api/state', auth, (_, res) => {
  try { res.json(JSON.parse(fs.readFileSync(STATE, 'utf8'))); } catch { res.json({}); }
});
app.put('/api/state', auth, (req, res) => {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ error: 'bad state' });
  const clean = {
    co: b.co && typeof b.co === 'object' ? { name: String(b.co.name || '').slice(0, 120), int: String(b.co.int || '').slice(0, 500) } : null,
    staff: b.staff && typeof b.staff === 'object' ? b.staff : {},
    msgs: Array.isArray(b.msgs) ? b.msgs.slice(-200) : [],
    report: String(b.report || '').slice(0, 100000),
    sched: String(b.sched || '').slice(0, 100000),
    plan: Array.isArray(b.plan) ? b.plan : []
  };
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean));
  fs.renameSync(tmp, STATE);
  res.json({ ok: true });
});

async function* lines(body) {
  const dec = new TextDecoder(); let buf = '';
  for await (const c of body) {
    buf += dec.decode(c, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); }
  }
  if (buf.trim()) yield buf;
}

async function* stream(system, prompt, files = [], signal) {
  if (PROVIDER === 'ollama') {
    const r = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/api/chat`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, stream: true, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] })
    });
    if (!r.ok) {
      let m = ''; try { m = JSON.parse(await r.text()).error?.message; } catch {}
      throw new Error(m || `فشل الاتصال بنموذج Ollama (HTTP ${r.status})`);
    }
    for await (const l of lines(r.body)) {
      if (!l) continue;
      const j = JSON.parse(l);
      if (j.message?.content) yield j.message.content;
    }
    return;
  }

  // Google AI Studio (Gemma / Gemini) - 100% Real Live AI
  if (!API_KEY) {
    throw new Error('API_KEY غير موجود في ملف .env — يرجى إضافة مفتاح Google AI Studio');
  }

  // Prioritize active and stable multimodal models (deduplicated)
  const modelsToTry = Array.from(new Set([MODEL_NAME, 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemma-4-26b-a4b-it'])).filter(Boolean);

  const hasFiles = Array.isArray(files) && files.length > 0;
  const parts = [];
  if (hasFiles) {
    for (const f of files) {
      if (f && f.data) {
        let mime = f.type || f.mimeType;
        if (!mime) {
          if (f.name?.toLowerCase().endsWith('.pdf')) mime = 'application/pdf';
          else if (f.name?.toLowerCase().endsWith('.png')) mime = 'image/png';
          else if (f.name?.toLowerCase().endsWith('.webp')) mime = 'image/webp';
          else mime = 'image/jpeg';
        }
        const b64 = String(f.data).replace(/^data:[^;]+;base64,/, '');
        parts.push({
          inlineData: {
            mimeType: mime,
            data: b64
          }
        });
      }
    }
  }
  parts.push({ text: `${system}\n\n---\n${prompt}` });

  let lastErr = null;

  for (const mod of modelsToTry) {
    try {
      // 1. Try SSE Streaming first
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mod)}:streamGenerateContent?alt=sse`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts }] })
      });

      if (r.ok) {
        let gotAny = false;
        for await (const l of lines(r.body)) {
          if (!l.startsWith('data:')) continue;
          const d = l.slice(5).trim();
          if (!d || d === '[DONE]') continue;
          const j = JSON.parse(d);
          for (const p of j.candidates?.[0]?.content?.parts || []) {
            if (p.text && !p.thought) {
              gotAny = true;
              yield p.text;
            }
          }
        }
        if (gotAny) return;
      } else {
        const errJson = await r.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `HTTP ${r.status}`);
      }

      // 2. Try generateContent (for models like Gemma 4 that don't support SSE)
      const r2 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mod)}:generateContent`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts }] })
      });

      if (r2.ok) {
        const data = await r2.json();
        const resParts = data.candidates?.[0]?.content?.parts || [];
        let text = resParts.filter(p => !p.thought).map(p => p.text).join('\n');
        if (!text) text = resParts.map(p => p.text).filter(Boolean).join('\n');
        if (text) {
          for (const word of text.split(' ')) {
            await new Promise(res => setTimeout(res, 20));
            yield word + ' ';
          }
          return;
        }
      } else {
        const errJson = await r2.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `HTTP ${r2.status}`);
      }
    } catch (e) {
      console.warn(`Model ${mod} attempt failed: ${e.message}, trying next fallback...`);
      lastErr = e;
    }
  }

  throw lastErr || new Error('فشلت جميع محاولات الاتصال بنماذج الذكاء الاصطناعي');
}

const limiter = rateLimit({ windowMs: 60000, limit: Number(RATE_LIMIT_PER_MIN), standardHeaders: true, legacyHeaders: false, message: { error: 'طلبات كتير، استنى شوية وجرّب تاني' } });

app.post('/api/llm', auth, limiter, async (req, res) => {
  const { system, prompt, files } = req.body || {};
  if (typeof system !== 'string' || typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'طلب غير صالح' });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180000);
  res.on('close', () => { clearTimeout(timer); ac.abort(); });
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
  try { for await (const t of stream(system, prompt, files, ac.signal)) send({ t }); }
  catch (e) { console.error('llm error:', e.message); send({ error: ac.signal.aborted ? 'انتهت المهلة أو اتقطع الاتصال' : e.message }); }
  res.end();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'خطأ في الطلب' }));

const srv = app.listen(PORT, () => console.log(`AI Company on :${PORT} (${PROVIDER} / ${MODEL_NAME})`));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => srv.close(() => process.exit(0)));
