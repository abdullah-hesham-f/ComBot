# 🌿 AI Company

شركة موظفينها بوتات Gemma 4: CEO، مهندس قواعد بيانات، مصمم جرافيك، مدير مهام، محاسب، منظم وقت، ومعدّ تقارير. بيتواصلوا مع بعض لايف وبيطلعوا تقرير نهائي.

## التشغيل المحلي
1. نزّل Node.js 20 أو أحدث.
2. `cp .env.example .env` وعدّل:
   - `MODEL_NAME` = اسم Gemma 4 بالظبط من Google AI Studio (أو من `ollama list`)
   - `API_KEY` = مفتاح AI Studio (أو `PROVIDER=ollama` للتشغيل المحلي)
   - `APP_PASSWORD` = كود دخول للموقع (**ضروري قبل ما تنشره**)
3. `npm install`
4. `npm start` ثم افتح http://localhost:3000

## التشغيل بـ Docker
```
docker build -t ai-company .
docker run -d --name ai-company -p 3000:3000 --env-file .env -v ai-company-data:/app/data ai-company
```

## النشر (Production)
- حط ورا Nginx/Caddy/Cloudflare بـ HTTPS، وخلّي `TRUST_PROXY=1`.
- لو Nginx: أضف `proxy_buffering off;` عشان البث اللحظي يشتغل (السيرفر بيبعت X-Accel-Buffering: no).
- الـ API Key عمره ما بيوصل للمتصفح؛ كل الاستدعاءات بتعدّي على `/api/llm`.
- فيه Rate limit (`RATE_LIMIT_PER_MIN`) وحد أقصى لحجم النص (`MAX_PROMPT_CHARS`) ومهلة 120 ثانية لكل استدعاء.
- الحالة (الشركة، الموظفين، الرسائل، التقرير) بتتحفظ في `DATA_DIR/state.json`، فاعمل Volume عليه.
- `/healthz` للـ health check.

## ملاحظة
النسخة دي لشركة واحدة بكود دخول واحد (single-tenant). لو عايزها متعددة المستخدمين محتاج نظام حسابات وقاعدة بيانات.
