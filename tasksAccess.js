/**
 * מנויים / נעילת משתמשים באפליקציית המשימות (תכל׳ס)
 *   POST /tasks/access/me                      - כל משתמש: האם מותר לו להשתמש (משתמש חדש מקבל תקופת ניסיון)
 *   POST /tasks/access/list                    - בעל העסק: כל המשתמשים + מצב המנוי
 *   POST /tasks/access/set   { uid, action }   - בעל העסק: lock | approve{days?} | kind{kind} | year | extend{days} | until{until} | month | forever | trial7
 *   POST /tasks/access/config { trialDays, price, contact } - בעל העסק: הגדרות
 * נשמר ב-Firebase (נגיש רק לשרת):
 *   todoAccess/users/<uid> = { name, email, kind: business|private, start, until, locked, plan: trial|paid|year|free, warned, ended }
 *   todoAccess/config      = { trialDays, price, contact }
 * תזכורות (בדיקה כל 10 דקות):
 *   יום לפני סוף התקופה  -> הודעה לבעל העסק + למשתמש
 *   כשהתקופה נגמרת       -> הודעה לבעל העסק ("ננעל/ה - לחדש?")
 */
const SAFE = /^[-_A-Za-z0-9]{1,128}$/;
const OWNER = 'staff-tasks';
const OWNER_EMAILS = ['ranizik@gmail.com']; // החשבון של בעל העסק ב-Google - אף פעם לא ננעל
const DAY = 864e5;
// freeMode = תקופת הרצה: כל מי שאושר משתמש בחינם בלי הגבלת זמן (אין נעילה אוטומטית ואין תזכורות סוף תקופה)
const DEF_CONFIG = { trialDays: 30, price: 20, contact: '0559800017', approval: true, freeMode: true };
// משתמשים שנרשמו לפני שהופעל 'אישור ידני' - מקבלים ניסיון רגיל ולא נחסמים
const APPROVAL_SINCE = Date.parse('2026-10-27T16:30:00Z');

function register(app, admin, db, express) {
  async function authUser(req) {
    const h = req.headers.authorization || '';
    const d = h.startsWith('Bearer ') ? await admin.auth().verifyIdToken(h.slice(7)).catch(() => null) : null;
    return d && SAFE.test(d.uid) ? d : null;
  }
  const getConfig = async () => ({ ...DEF_CONFIG, ...((await db.ref('todoAccess/config').once('value')).val() || {}) });
  const push = (uid, title, body) => {
    const fn = require('./taskReminders').sendToUser;
    return fn ? fn(uid, title, body, 'access').catch(() => 0) : Promise.resolve(0);
  };
  const allowedNow = (a, now, cfg) => !!a && !a.pending && !a.locked && ((cfg && cfg.freeMode) || a.until == null || a.until > now);
  const pub = (a, cfg, now) => ({
    allowed: allowedNow(a, now, cfg), freeMode: !!cfg.freeMode,
    locked: !!a.locked, pending: !!a.pending, plan: a.plan || 'trial', until: a.until == null ? null : a.until,
    daysLeft: (a.until == null || cfg.freeMode) ? null : Math.max(0, Math.ceil((a.until - now) / DAY)),
    price: cfg.price, contact: cfg.contact,
  });
  async function ensure(uid, info, created) {
    const ref = db.ref(`todoAccess/users/${uid}`);
    let a = (await ref.once('value')).val();
    if (!a) {
      const cfg = await getConfig();
      const now = Date.now();
      if (created === undefined) created = await admin.auth().getUser(uid).then((u) => Date.parse(u.metadata.creationTime) || 0).catch(() => 0);
      const isNew = created >= APPROVAL_SINCE;
      if (cfg.approval && isNew) {
        // משתמש חדש - ממתין לאישור של בעל העסק
        a = { start: now, until: null, locked: false, pending: true, plan: 'trial', name: info.name || '', email: info.email || '', askedAt: now };
        await ref.set(a);
        await push(OWNER, '🙋 בקשת הצטרפות לתכל׳ס', (info.name || info.email || 'משתמש חדש') + (info.email && info.name ? ' (' + info.email + ')' : '') + ' – לאשר? 📊 ← משתמשים');
        return a;
      }
      a = { start: now, until: now + cfg.trialDays * DAY, locked: false, plan: 'trial', name: info.name || '', email: info.email || '' };
      await ref.set(a);
    } else if (info && ((info.name && info.name !== a.name) || (info.email && info.email !== a.email))) {
      await ref.update({ name: info.name || a.name || '', email: info.email || a.email || '' });
    }
    return a;
  }

  app.post('/tasks/access/me', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      if (d.uid === OWNER || (d.email_verified && OWNER_EMAILS.includes(String(d.email || '').toLowerCase()))) return res.json({ ok: true, allowed: true, owner: true });
      const a = await ensure(d.uid, { name: d.name || '', email: d.email || '' });
      res.json({ ok: true, ...pub(a, await getConfig(), Date.now()) });
    } catch (err) {
      console.error('POST /tasks/access/me error:', err.message);
      res.status(200).json({ ok: false, allowed: true }); // תקלה בשרת לא נועלת משתמשים
    }
  });

  app.post('/tasks/access/list', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d || d.uid !== OWNER) return res.status(401).json({ error: 'רק לבעל העסק' });
      const [acc, todo, stats] = await Promise.all(['todoAccess/users', 'todo', 'todoStats/users'].map((p) => db.ref(p).once('value').then((s) => s.val() || {})));
      const uids = new Set([...Object.keys(acc), ...Object.keys(todo.users || {}), ...Object.keys(stats)].filter((u) => u !== OWNER && SAFE.test(u)));
      const authInfo = {};
      const list = [...uids];
      for (let i = 0; i < list.length; i += 100) {
        const r = await admin.auth().getUsers(list.slice(i, i + 100).map((uid) => ({ uid })));
        r.users.forEach((u) => { authInfo[u.uid] = { name: u.displayName || '', email: u.email || '', created: Date.parse(u.metadata.creationTime) || null }; });
      }
      const cfg = await getConfig();
      const now = Date.now();
      const users = [];
      for (const uid of list) {
        const info = authInfo[uid] || {};
        if (OWNER_EMAILS.includes(String(info.email || '').toLowerCase())) continue;
        const a = acc[uid] || await ensure(uid, info, info.created || 0);
        const tasks = Object.values(((todo.users || {})[uid] || {}).tasks || {}).filter(Boolean);
        users.push({
          uid, name: a.name || info.name || '', email: a.email || info.email || '', kind: a.kind || '',
          joined: info.created || a.start || null, last: (stats[uid] || {}).last || null,
          tasks: tasks.length, open: tasks.filter((t) => !t.done).length,
          ...pub(a, cfg, now),
        });
      }
      const rank = (u) => (u.pending ? 0 : u.allowed ? 2 : 1);
      users.sort((x, y) => rank(x) - rank(y) || (x.until || Infinity) - (y.until || Infinity));
      res.json({ ok: true, config: cfg, users });
    } catch (err) {
      console.error('POST /tasks/access/list error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/tasks/access/set', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d || d.uid !== OWNER) return res.status(401).json({ error: 'רק לבעל העסק' });
      const { uid, action, days, until, kind } = req.body || {};
      if (!SAFE.test(String(uid || '')) || uid === OWNER) return res.status(400).json({ error: 'משתמש לא תקף' });
      const a = await ensure(uid, {}, 0);
      const now = Date.now();
      const base = Math.max(now, a.until || 0);
      let upd;
      const cfg = await getConfig();
      if (action === 'lock') upd = { locked: true, pending: null };
      else if (action === 'kind') {
        if (!['business', 'private', ''].includes(String(kind || ''))) return res.status(400).json({ error: 'סוג לקוח לא תקף' });
        await db.ref(`todoAccess/users/${uid}/kind`).set(kind || null);
        return res.json({ ok: true, kind: kind || '' });
      }
      else if (action === 'approve') {
        const n = days == null ? cfg.trialDays : Math.round(Number(days));
        if (!(n >= 1 && n <= 365)) return res.status(400).json({ error: 'מספר ימים לא תקף' });
        upd = { locked: false, pending: null, plan: 'trial', start: now, until: now + n * DAY, warned: null, ended: null };
      }
      else if (action === 'year') upd = { locked: false, pending: null, plan: 'year', start: a.start || now, until: (a.pending ? now : base) + 365 * DAY, warned: null, ended: null };
      else if (action === 'extend') {
        const n = Math.round(Number(days));
        if (!(n >= 1 && n <= 3650)) return res.status(400).json({ error: 'מספר ימים לא תקף' });
        upd = { locked: false, pending: null, plan: 'year', start: a.start || now, until: (a.pending ? now : base) + n * DAY, warned: null, ended: null };
      } else if (action === 'until') {
        const t = Number(until);
        if (!(t > now && t < now + 3650 * DAY)) return res.status(400).json({ error: 'תאריך לא תקף' });
        upd = { locked: false, pending: null, plan: 'year', start: a.start || now, until: t, warned: null, ended: null };
      }
      else if (action === 'month') upd = { locked: false, pending: null, plan: 'paid', until: base + 30 * DAY, warned: null, ended: null, paidAt: now };
      else if (action === 'forever') upd = { locked: false, pending: null, plan: 'free', until: null, warned: null, ended: null };
      else if (action === 'trial7') upd = { locked: false, pending: null, until: base + 7 * DAY, warned: null, ended: null };
      else return res.status(400).json({ error: 'פעולה לא תקפה' });
      await db.ref(`todoAccess/users/${uid}`).update(upd);
      const n = { ...a, ...upd };
      if (action !== 'lock' && !allowedNow(a, now, cfg)) await push(uid, a.pending ? '✅ אושרת! ברוך הבא לתכל׳ס' : '✅ תכל׳ס נפתחה', a.pending ? 'אפשר להתחיל – לחץ על המיקרופון ותגיד משימה' : 'אפשר להמשיך להשתמש באפליקציה');
      res.json({ ok: true, ...pub(n, await getConfig(), now) });
    } catch (err) {
      console.error('POST /tasks/access/set error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/tasks/access/config', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d || d.uid !== OWNER) return res.status(401).json({ error: 'רק לבעל העסק' });
      const b = req.body || {};
      const upd = {};
      if (b.trialDays != null) { const v = Math.round(Number(b.trialDays)); if (v >= 1 && v <= 365) upd.trialDays = v; }
      if (b.price != null) { const v = Number(b.price); if (v >= 0 && v <= 10000) upd.price = v; }
      if (b.approval != null) upd.approval = !!b.approval;
      if (b.freeMode != null) upd.freeMode = !!b.freeMode;
      if (b.contact != null) { const v = String(b.contact).replace(/[^0-9+]/g, '').slice(0, 15); if (v.length >= 9) upd.contact = v; }
      await db.ref('todoAccess/config').update(upd);
      res.json({ ok: true, config: await getConfig() });
    } catch (err) {
      console.error('POST /tasks/access/config error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // ---------- תזכורות סוף תקופה ----------
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      if ((await getConfig()).freeMode) return; // תקופת הרצה - אין סוף תקופה
      const acc = (await db.ref('todoAccess/users').once('value')).val() || {};
      for (const [uid, a] of Object.entries(acc)) {
        if (!a || !SAFE.test(uid) || uid === OWNER || a.locked || a.until == null) continue;
        const who = a.name || a.email || 'משתמש';
        const paid = a.plan === 'paid' || a.plan === 'year';
        if (a.until > now && a.until - now <= DAY && a.warned !== a.until) {
          await db.ref(`todoAccess/users/${uid}/warned`).set(a.until);
          await push(OWNER, '⏳ ' + who + ': ' + (paid ? 'המנוי נגמר מחר' : 'הניסיון נגמר מחר'), 'כדאי לדבר איתה/ו על המשך – 📊 ← משתמשים');
          await push(uid, '⏳ ' + (paid ? 'המנוי שלך בתכל׳ס נגמר מחר' : 'תקופת הניסיון בתכל׳ס נגמרת מחר'), 'כדי להמשיך להשתמש – פנה/י לרני');
        }
        if (a.until <= now && a.ended !== a.until && now - a.until < 7 * DAY) {
          await db.ref(`todoAccess/users/${uid}/ended`).set(a.until);
          await push(OWNER, '🔒 ' + who + ' – ' + (paid ? 'המנוי נגמר' : 'הניסיון נגמר'), 'הגישה ננעלה. לפתוח לחודש? 📊 ← משתמשים');
        }
      }
    } catch (err) {
      console.error('access tick error:', err.message);
    } finally {
      running = false;
    }
  }
  module.exports._tick = tick;
  setInterval(tick, 10 * 60 * 1000);
  setTimeout(tick, 20000);
  console.log('🔐 מנויי משימות פעילים');
}

// לשימוש של מודול התזכורות: מי חסום (נעול / תקופה נגמרה)
async function blockedSet(db) {
  const acc = (await db.ref('todoAccess/users').once('value')).val() || {};
  const free = { ...DEF_CONFIG, ...((await db.ref('todoAccess/config').once('value')).val() || {}) }.freeMode;
  const now = Date.now();
  return new Set(Object.entries(acc).filter(([, a]) => a && (a.pending || a.locked || (!free && a.until != null && a.until <= now))).map(([u]) => u));
}

module.exports = { register, blockedSet, OWNER_EMAILS };
