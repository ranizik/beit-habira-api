/**
 * חיבור קבוע ל-Google Tasks לאפליקציית המשימות
 * הבעיה: חיבור מהדפדפן נותן אישור לשעה בלבד. כאן ההרשאה (refresh token) נשמרת בשרת ומתחדשת לבד.
 *
 * משתני סביבה ב-Render:
 *   GCAL_CLIENT_SECRET  - הסוד של ה-OAuth Client (Google Cloud -> Credentials)
 *   GCAL_CLIENT_ID      - אופציונלי (ברירת מחדל: ה-Client של אפליקציית המשימות)
 * ב-Google Cloud צריך שיהיה Authorized redirect URI:  https://beit-habira-api.onrender.com/tasks/gcal/callback
 *
 * נתיבים (כולם עם Authorization: Bearer <idToken של Firebase>, חוץ מ-callback):
 *   POST /tasks/gcal/start       -> { url }  כתובת התחברות לגוגל (נפתחת בחלון)
 *   GET  /tasks/gcal/callback    <- גוגל חוזר לכאן, נשמר refresh token
 *   POST /tasks/gcal/status      -> { connected, email }
 *   POST /tasks/gcal/disconnect
 *   POST /tasks/gcal/task  { op: 'create'|'update'|'delete', task: {name,date,time,done}, gtaskId } -> { ok, id }
 *   POST /tasks/gcal/events { on, tasks? } - גם אירוע ביומן Google לכל משימה (מופיע ביומן של סמסונג). on=true בלי הרשאה -> { needConsent }
 *     מיפוי משימה->אירוע: todoGcalEv/<uid>/<gtaskId> = eventId
 *
 * נשמר ב-Firebase (נגיש רק לשרת): todoGcal/<uid> = { refresh, email, at },  todoGcalState/<state> = { uid, exp }
 */
const crypto = require('crypto');

const CLIENT_ID = process.env.GCAL_CLIENT_ID || '895106923239-7ctgh1gc0je4pah4egj0t8h2ajapo95c.apps.googleusercontent.com';
const REDIRECT = (process.env.PUBLIC_API_URL || 'https://beit-habira-api.onrender.com') + '/tasks/gcal/callback';
const SCOPES = 'https://www.googleapis.com/auth/tasks openid email';
const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events'; // רק למי שביקש "גם כאירוע ביומן" (כדי שיופיע ביומן של סמסונג)
const TZ = 'Asia/Jerusalem';
const SAFE = /^[-_A-Za-z0-9]{1,128}$/;
const tokenCache = {}; // uid -> { token, exp }

function register(app, admin, db, express) {
  async function authUser(req) {
    const h = req.headers.authorization || '';
    const d = h.startsWith('Bearer ') ? await admin.auth().verifyIdToken(h.slice(7)).catch(() => null) : null;
    return d && SAFE.test(d.uid) ? d : null;
  }
  const configured = () => !!process.env.GCAL_CLIENT_SECRET;

  async function tokenRequest(params) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: process.env.GCAL_CLIENT_SECRET, ...params }),
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }

  async function accessToken(uid) {
    const c = tokenCache[uid];
    if (c && c.exp > Date.now() + 60000) return c.token;
    const saved = (await db.ref(`todoGcal/${uid}`).once('value')).val();
    if (!saved || !saved.refresh) return null;
    const { data } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: saved.refresh });
    if (!data.access_token) {
      // ההרשאה בוטלה בגוגל (או פגה) - מוחקים כדי שהאפליקציה תציע להתחבר מחדש
      if (data.error === 'invalid_grant') await db.ref(`todoGcal/${uid}`).remove();
      console.warn('gcal refresh failed for', uid, data.error);
      return null;
    }
    tokenCache[uid] = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
    return data.access_token;
  }

  function gtaskBody(t) {
    return {
      title: String(t.name || '').slice(0, 900), // השעה לא בשם - היא בפרטי המשימה (Google לא שומר שעה במשימה מ-API)
      notes: (t.notes ? String(t.notes).slice(0, 2000) + '\n\n' : '') + 'נוסף מאפליקציית המשימות' + (t.time ? ' | שעה: ' + t.time : ''),
      due: t.date + 'T00:00:00.000Z',
      status: t.done ? 'completed' : 'needsAction',
    };
  }

  app.post('/tasks/gcal/start', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      if (!configured()) return res.status(503).json({ error: 'החיבור ליומן עוד לא הוגדר בשרת' });
      const state = crypto.randomBytes(18).toString('hex');
      const wantCal = !!(req.body || {}).cal;
      await db.ref(`todoGcalState/${state}`).set({ uid: d.uid, exp: Date.now() + 10 * 60 * 1000, cal: wantCal });
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES + (wantCal ? ' ' + CAL_SCOPE : ''),
        access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state,
      });
      res.json({ ok: true, url });
    } catch (err) {
      console.error('POST /tasks/gcal/start error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.get('/tasks/gcal/callback', async (req, res) => {
    const page = (ok, msg) => res.status(200).type('html').send(
      '<!DOCTYPE html><html lang="he" dir="rtl"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<body style="font-family:Arial;text-align:center;padding:40px 16px;background:#f0f0f0">'
      + '<div style="font-size:48px">' + (ok ? '✅' : '⚠️') + '</div><h2>' + msg + '</h2>'
      + '<p>אפשר לסגור את החלון ולחזור לאפליקציה</p>'
      + '<script>setTimeout(function(){window.close()},1500)</script></body></html>');
    try {
      const { code, state, error } = req.query;
      if (error) return page(false, 'החיבור בוטל');
      if (!SAFE.test(String(state || '')) || !code) return page(false, 'קישור לא תקין');
      const st = (await db.ref(`todoGcalState/${state}`).once('value')).val();
      await db.ref(`todoGcalState/${state}`).remove();
      if (!st || st.exp < Date.now()) return page(false, 'פג הזמן - נסה שוב מהאפליקציה');
      const { data } = await tokenRequest({ grant_type: 'authorization_code', code: String(code), redirect_uri: REDIRECT });
      if (!data.access_token) { console.error('gcal code exchange failed:', data.error, data.error_description); return page(false, 'החיבור נכשל - נסה שוב'); }
      if (!/auth\/tasks/.test(data.scope || '')) return page(false, 'צריך לסמן את ההרשאה למשימות - נסה שוב');
      let email = '';
      try { email = JSON.parse(Buffer.from(String(data.id_token || '').split('.')[1] || '', 'base64url').toString()).email || ''; } catch (e) {}
      const prev = (await db.ref(`todoGcal/${st.uid}`).once('value')).val();
      const refresh = data.refresh_token || (prev && prev.email === email ? prev.refresh : null);
      if (!refresh) return page(false, 'גוגל לא נתן הרשאה קבועה - נסה שוב');
      const cal = (data.scope || '').includes(CAL_SCOPE) || !!(prev && prev.cal && prev.email === email && !data.refresh_token);
      await db.ref(`todoGcal/${st.uid}`).set({ refresh, email, at: Date.now(), cal, events: !!(cal && (st.cal || (prev && prev.events && prev.email === email))) });
      tokenCache[st.uid] = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
      page(true, 'היומן מחובר' + (email ? ' (' + email + ')' : ''));
    } catch (err) {
      console.error('GET /tasks/gcal/callback error:', err.message);
      page(false, 'שגיאת שרת - נסה שוב');
    }
  });

  app.post('/tasks/gcal/status', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const saved = (await db.ref(`todoGcal/${d.uid}`).once('value')).val();
      res.json({ ok: true, configured: configured(), connected: !!(saved && saved.refresh), email: (saved && saved.email) || '', cal: !!(saved && saved.cal), events: !!(saved && saved.events) });
    } catch (err) {
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/tasks/gcal/disconnect', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const saved = (await db.ref(`todoGcal/${d.uid}`).once('value')).val();
      if (saved && saved.refresh) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(saved.refresh), { method: 'POST' }).catch(() => {});
      await db.ref(`todoGcal/${d.uid}`).remove();
      await db.ref(`todoGcalEv/${d.uid}`).remove();
      delete tokenCache[d.uid];
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/tasks/gcal/task', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const { op, task, gtaskId } = req.body || {};
      if (!['create', 'update', 'delete'].includes(op)) return res.status(400).json({ error: 'op לא תקף' });
      if (op !== 'delete' && (!task || !/^\d{4}-\d{2}-\d{2}$/.test(String(task.date || '')))) return res.status(400).json({ error: 'חסר תאריך' });
      if (op !== 'create' && !/^[-_A-Za-z0-9]{1,200}$/.test(String(gtaskId || ''))) return res.status(400).json({ error: 'חסר gtaskId' });
      const token = await accessToken(d.uid);
      if (!token) return res.json({ ok: false, error: 'not_connected' });
      const base = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';
      const r = await fetch(base + (op === 'create' ? '' : '/' + gtaskId), {
        method: op === 'create' ? 'POST' : op === 'update' ? 'PATCH' : 'DELETE',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: op === 'delete' ? undefined : JSON.stringify(gtaskBody(task)),
      });
      const data = r.status === 204 ? {} : await r.json().catch(() => ({}));
      if (r.ok || (op !== 'create' && r.status === 404)) {
        const id = data.id || gtaskId || null;
        await mirrorEvent(d.uid, token, op, id, task).catch((e) => console.warn('gcal event mirror:', e.message));
        return res.json({ ok: true, id });
      }
      if (r.status === 401) { delete tokenCache[d.uid]; return res.json({ ok: false, error: 'not_connected' }); }
      if (r.status === 403 && /has not been used|disabled|SERVICE_DISABLED/i.test(JSON.stringify(data))) return res.json({ ok: false, error: 'Google Tasks API לא מופעל בפרויקט ב-Google Cloud' });
      res.json({ ok: false, error: (data.error && data.error.message) || ('שגיאה ' + r.status) });
    } catch (err) {
      console.error('POST /tasks/gcal/task error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // ---------- אירוע ביומן Google (בנוסף למשימה) - כדי שיופיע גם ביומן של סמסונג ----------
  function addMinutes(date, time, mins) {
    const [y, mo, d] = date.split('-').map(Number); const [h, mi] = time.split(':').map(Number);
    const t = new Date(Date.UTC(y, mo - 1, d, h, mi + mins));
    const p = (n) => String(n).padStart(2, '0');
    return { date: t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()), time: p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) };
  }
  function eventBody(t) {
    const timed = /^\d{2}:\d{2}$/.test(String(t.time || ''));
    const body = {
      summary: (t.done ? '✓ ' : '') + String(t.name || '').slice(0, 900),
      description: (t.notes ? String(t.notes).slice(0, 2000) + '\n\n' : '') + 'נוסף מתכל׳ס – beit-habira.com/tasks',
      transparency: 'transparent', // לא חוסם זמן ביומן
      reminders: timed && !t.done ? { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] } : { useDefault: false, overrides: [] },
    };
    if (t.pri === 'high' && !t.done) body.colorId = '11';
    else if (t.done) body.colorId = '8';
    else body.colorId = '9';
    if (timed) {
      const e = addMinutes(t.date, t.time, 30);
      body.start = { dateTime: t.date + 'T' + t.time + ':00', timeZone: TZ };
      body.end = { dateTime: e.date + 'T' + e.time + ':00', timeZone: TZ };
    } else {
      const e = addMinutes(t.date, '00:00', 24 * 60);
      body.start = { date: t.date }; body.end = { date: e.date };
    }
    return body;
  }
  const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  async function mirrorEvent(uid, token, op, gtaskId, task) {
    const key = String(gtaskId || '').replace(/[^-_A-Za-z0-9]/g, '').slice(0, 128);
    if (!key) return;
    const saved = (await db.ref(`todoGcal/${uid}`).once('value')).val() || {};
    const mapRef = db.ref(`todoGcalEv/${uid}/${key}`);
    const evId = (await mapRef.once('value')).val();
    const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (op === 'delete' || !saved.events || !saved.cal) {
      if (evId && op === 'delete') { await fetch(CAL_BASE + '/' + evId, { method: 'DELETE', headers: H }); await mapRef.remove(); }
      return;
    }
    if (!task || !/^\d{4}-\d{2}-\d{2}$/.test(String(task.date || ''))) return;
    if (evId) {
      const r = await fetch(CAL_BASE + '/' + evId, { method: 'PATCH', headers: H, body: JSON.stringify(eventBody(task)) });
      if (r.ok) return;
      if (r.status !== 404 && r.status !== 410) throw new Error('event patch ' + r.status);
    }
    const r = await fetch(CAL_BASE, { method: 'POST', headers: H, body: JSON.stringify(eventBody(task)) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('event create ' + r.status + ' ' + ((j.error && j.error.message) || ''));
    await mapRef.set(j.id);
  }

  // הפעלה/כיבוי "גם כאירוע ביומן". בהפעלה - יוצר אירועים למשימות הפתוחות שכבר ביומן; בכיבוי - מוחק את האירועים
  app.post('/tasks/gcal/events', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const { on, tasks } = req.body || {};
      const saved = (await db.ref(`todoGcal/${d.uid}`).once('value')).val();
      if (!saved || !saved.refresh) return res.json({ ok: false, error: 'not_connected' });
      if (on && !saved.cal) return res.json({ ok: false, needConsent: true });
      const token = await accessToken(d.uid);
      if (!token) return res.json({ ok: false, error: 'not_connected' });
      await db.ref(`todoGcal/${d.uid}/events`).set(!!on);
      let n = 0;
      if (on) {
        for (const t of (Array.isArray(tasks) ? tasks : []).slice(0, 300)) {
          if (!t || !t.gtaskId) continue;
          try { await mirrorEvent(d.uid, token, 'update', t.gtaskId, t); n++; } catch (e) { console.warn('events backfill:', e.message); if (/ 403 /.test(e.message)) return res.json({ ok: false, error: /has not been used|disabled/i.test(e.message) ? 'Google Calendar API לא מופעל בפרויקט' : e.message }); }
        }
      } else {
        const map = (await db.ref(`todoGcalEv/${d.uid}`).once('value')).val() || {};
        for (const evId of Object.values(map)) { await fetch(CAL_BASE + '/' + evId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }).catch(() => {}); n++; }
        await db.ref(`todoGcalEv/${d.uid}`).remove();
      }
      res.json({ ok: true, events: !!on, count: n });
    } catch (err) {
      console.error('POST /tasks/gcal/events error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // דף הבית ומדיניות הפרטיות עברו לאתר (beit-habira.com/tasks) לצורך אימות האפליקציה ב-Google
  app.get('/tasks/privacy', (req, res) => res.redirect(301, 'https://beit-habira.com/tasks/privacy.html'));
  app.get('/tasks/home', (req, res) => res.redirect(301, 'https://beit-habira.com/tasks/home.html'));
  // אימות בעלות ב-Google Search Console (נדרש לאימות מסך ההרשאה)
  app.get('/googlef6f83aa4fb83a2bb.html', (req, res) => res.type('html').send('google-site-verification: googlef6f83aa4fb83a2bb.html'));

  // ---------- כניסה עם Google לאפליקציית המשימות - דרך השרת ----------
  // ב-Firebase כבויה יצירת משתמשים מהדפדפן (הקשחת אבטחה), ולכן כניסה ישירה עם Google נכשלת למשתמש חדש
  // (auth/admin-restricted-operation). כאן השרת מאמת את Google, יוצר/מוצא את המשתמש, ומחזיר טוקן כניסה.
  // משתמש שכבר נכנס בעבר עם Google מקבל את אותו חשבון (לפי האימייל) - המשימות שלו נשמרות.
  const loginHits = {};
  const tooMany = (ip) => { const now = Date.now(); const a = (loginHits[ip] || []).filter((t) => now - t < 60000); a.push(now); loginHits[ip] = a; return a.length > 20; };
  async function verifyGoogleIdToken(cred) {
    if (!cred || typeof cred !== 'string' || cred.length > 4096) return null;
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred));
    const p = await r.json().catch(() => ({}));
    if (!r.ok || p.aud !== CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(p.iss)) return null;
    if (String(p.email_verified) !== 'true' || !p.email || Number(p.exp) * 1000 < Date.now()) return null;
    return p;
  }
  async function customTokenFor(p) {
    let uid;
    try { uid = (await admin.auth().getUserByEmail(p.email)).uid; }
    catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
      uid = (await admin.auth().createUser({ email: p.email, emailVerified: true, displayName: p.name || undefined, photoURL: p.picture || undefined })).uid;
    }
    if (!SAFE.test(uid) || uid.startsWith('staff-')) throw new Error('חשבון לא תקין');
    return admin.auth().createCustomToken(uid);
  }
  app.post('/tasks/google-login', express.json(), async (req, res) => {
    try {
      if (tooMany(req.ip)) return res.status(429).json({ error: 'יותר מדי ניסיונות, נסה שוב בעוד דקה' });
      const p = await verifyGoogleIdToken((req.body || {}).credential);
      if (!p) return res.status(401).json({ error: 'האימות מול Google נכשל' });
      res.json({ ok: true, token: await customTokenFor(p) });
    } catch (err) {
      console.error('POST /tasks/google-login error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
  // אייפון / אפליקציה מהמסך הבית: Google שולח לכאן את האישור (טופס), ומשם חוזרים לאפליקציה עם טוקן כניסה בסימן #
  app.post('/tasks/google-login-redirect', express.urlencoded({ extended: false }), async (req, res) => {
    const back = (hash) => res.redirect(303, 'https://beit-habira.com/tasks/#' + hash);
    try {
      if (tooMany(req.ip)) return back('lerr=' + encodeURIComponent('יותר מדי ניסיונות'));
      // הגנת אבטחה: עוגיית g_csrf_token של Google לא מגיעה לשרת הזה (דומיין אחר) ודף Google לא שולח Origin.
      // במקום זה: האפליקציה שולחת לגוגל קוד חד-פעמי (nonce) ששמור אצלה, גוגל חותם אותו בתוך האישור,
      // ואנחנו מחזירים אותו לאפליקציה - שמשווה אותו לקוד ששמרה לפני שהיא נכנסת. בקשה שלא יצאה מהאפליקציה תידחה שם.
      const p = await verifyGoogleIdToken((req.body || {}).credential);
      if (!p) return back('lerr=' + encodeURIComponent('האימות מול Google נכשל'));
      back('ct=' + encodeURIComponent(await customTokenFor(p)) + '&n=' + encodeURIComponent(p.nonce || ''));
    } catch (err) {
      console.error('POST /tasks/google-login-redirect error:', err.message);
      back('lerr=' + encodeURIComponent('שגיאת שרת'));
    }
  });

  // קבצי העזר של Firebase להתחברות עם Google - כדי לארח אותם על beit-habira.com (התחברות באייפון/Safari)
  // https://firebase.google.com/docs/auth/web/redirect-best-practices (Option 4). רשימה סגורה של קבצים בלבד.
  const HELPERS = { handler: '/__/auth/handler', 'handler.js': '/__/auth/handler.js', 'experiments.js': '/__/auth/experiments.js', iframe: '/__/auth/iframe', 'iframe.js': '/__/auth/iframe.js', links: '/__/auth/links', 'links.js': '/__/auth/links.js', 'init.json': '/__/firebase/init.json' };
  app.get('/tasks/auth-helper/:file', async (req, res) => {
    const p = HELPERS[req.params.file];
    if (!p) return res.status(404).end();
    try {
      const r = await fetch('https://orders-app-78c0f.firebaseapp.com' + p);
      res.status(r.status).type('text/plain').send(await r.text());
    } catch (e) { res.status(502).end(); }
  });

  console.log('📅 חיבור Google Tasks קבוע:', configured() ? 'פעיל' : 'ממתין ל-GCAL_CLIENT_SECRET');
}

module.exports = { register };
