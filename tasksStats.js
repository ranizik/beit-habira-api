/**
 * נתוני שימוש לאפליקציית המשימות - רק ספירות, לבעל העסק בלבד
 *   POST /tasks/stats/ping    { standalone, platform }      - בכל פתיחה של האפליקציה (משתמש מחובר)
 *   POST /tasks/stats/event   { type: install|task_voice|task_typed }
 *   POST /tasks/stats/summary                                - רק לבעל העסק (כניסת מנהל)
 * נשמר ב-Firebase (נגיש רק לשרת):
 *   todoStats/users/<uid>  = { first, last, opens, standalone, platform, installedAt }
 *   todoStats/daily/<YYYY-MM-DD> = { active: {uid:true}, opens, install, task_voice, task_typed }
 * נתונים מלפני ההפעלה נלקחים מהמידע הקיים: תאריך הרשמה מ-Firebase Auth, ומשימות לפי שדה created.
 */
const SAFE = /^[-_A-Za-z0-9]{1,128}$/;
const OWNER = 'staff-tasks';
const EVENTS = ['install', 'task_voice', 'task_typed'];
const ilDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD

function register(app, admin, db, express) {
  async function authUser(req) {
    const h = req.headers.authorization || '';
    const d = h.startsWith('Bearer ') ? await admin.auth().verifyIdToken(h.slice(7)).catch(() => null) : null;
    return d && SAFE.test(d.uid) ? d : null;
  }
  const inc = (ref) => ref.transaction((v) => (Number(v) || 0) + 1);

  app.post('/tasks/stats/ping', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const { standalone, platform } = req.body || {};
      const now = Date.now();
      const uref = db.ref(`todoStats/users/${d.uid}`);
      const u = (await uref.once('value')).val() || {};
      const upd = { last: now, opens: (Number(u.opens) || 0) + 1, platform: String(platform || '').slice(0, 20) };
      if (!u.first) upd.first = now;
      if (standalone) { upd.standalone = true; upd.lastStandalone = now; }
      await uref.update(upd);
      const day = db.ref(`todoStats/daily/${ilDay(now)}`);
      await day.child(`active/${d.uid}`).set(true);
      await inc(day.child('opens'));
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /tasks/stats/ping error:', err.message);
      res.status(200).json({ ok: false });
    }
  });

  // כניסה לקישור (גם בלי התחברות) - כדי לדעת כמה פתחו את האפליקציה, לא רק כמה נרשמו
  // נשמר: todoStats/visitors/<vid> = { first, last, n, platform, src }, todoStats/daily/<day>/visitors/<vid> = true
  const visitHits = {};
  app.post('/tasks/stats/visit', express.json(), async (req, res) => {
    try {
      const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
      const now = Date.now();
      const hits = (visitHits[ip] || []).filter((t) => now - t < 3600000);
      if (hits.length >= 30) return res.json({ ok: false });
      hits.push(now); visitHits[ip] = hits;
      const { vid, standalone, platform, src } = req.body || {};
      if (!/^[A-Za-z0-9]{8,40}$/.test(String(vid || ''))) return res.status(400).json({ error: 'vid' });
      const vref = db.ref(`todoStats/visitors/${vid}`);
      const v = (await vref.once('value')).val() || {};
      const upd = { last: now, n: (Number(v.n) || 0) + 1, platform: String(platform || '').slice(0, 20) };
      if (!v.first) { upd.first = now; upd.src = String(src || '').slice(0, 40); }
      if (standalone) upd.standalone = true;
      await vref.update(upd);
      await db.ref(`todoStats/daily/${ilDay(now)}/visitors/${vid}`).set(true);
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /tasks/stats/visit error:', err.message);
      res.status(200).json({ ok: false });
    }
  });

  app.post('/tasks/stats/event', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const type = String((req.body || {}).type || '');
      if (!EVENTS.includes(type)) return res.status(400).json({ error: 'סוג לא תקף' });
      await inc(db.ref(`todoStats/daily/${ilDay(Date.now())}/${type}`));
      if (type === 'install') await db.ref(`todoStats/users/${d.uid}/installedAt`).set(Date.now());
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /tasks/stats/event error:', err.message);
      res.status(200).json({ ok: false });
    }
  });

  app.post('/tasks/stats/summary', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d || d.uid !== OWNER) return res.status(401).json({ error: 'רק לבעל העסק' });
      const now = Date.now();
      const DAY = 864e5;
      const visitorsP = db.ref('todoStats/visitors').once('value').then((x) => x.val() || {});
      const [stats, todo, push, gcal] = await Promise.all(['todoStats', 'todo', 'todoPushTokens', 'todoGcal'].map((p) => db.ref(p).once('value').then((s) => s.val() || {})));
      const sUsers = stats.users || {};
      const visitors = await visitorsP;
      const daily = stats.daily || {};

      // משתמשים = מי שנכנס עם Google לאפליקציית המשימות (לא כולל כניסת המנהל)
      const uids = new Set([...Object.keys(sUsers), ...Object.keys(todo.users || {})].filter((u) => u !== OWNER && SAFE.test(u)));
      Object.values(todo.shared || {}).forEach((l) => Object.keys((l && l.members) || {}).forEach((u) => u !== OWNER && SAFE.test(u) && uids.add(u)));
      const created = {};
      const ownerUids = new Set();
      const { OWNER_EMAILS } = require('./tasksAccess');
      const list = [...uids];
      for (let i = 0; i < list.length; i += 100) {
        const r = await admin.auth().getUsers(list.slice(i, i + 100).map((uid) => ({ uid })));
        r.users.forEach((u) => {
          created[u.uid] = Date.parse(u.metadata.creationTime) || null;
          if (OWNER_EMAILS.includes(String(u.email || '').toLowerCase())) ownerUids.add(u.uid); // החשבון הפרטי של בעל העסק - לא נספר
          const ls = Date.parse(u.metadata.lastRefreshTime || u.metadata.lastSignInTime) || 0;
          if (!sUsers[u.uid]) sUsers[u.uid] = {};
          if (!sUsers[u.uid].last || ls > sUsers[u.uid].last) sUsers[u.uid] = { ...sUsers[u.uid], last: ls };
        });
      }
      const users = list.filter((uid) => !ownerUids.has(uid)).map((uid) => ({ uid, first: created[uid] || (sUsers[uid] && sUsers[uid].first) || null, s: sUsers[uid] || {} }));
      const since = (ms) => users.filter((u) => u.s.last && now - u.s.last < ms).length;

      // משימות - מכל הרשימות (פרטיות של בעל העסק, של כל משתמש, משותפות)
      const allTasks = [];
      Object.values(todo.tasks || {}).forEach((t) => t && allTasks.push(t));
      Object.values(todo.users || {}).forEach((u) => Object.values((u && u.tasks) || {}).forEach((t) => t && allTasks.push(t)));
      Object.values(todo.shared || {}).forEach((l) => Object.values((l && l.tasks) || {}).forEach((t) => t && allTasks.push(t)));

      const days = [];
      for (let i = 29; i >= 0; i--) {
        const key = ilDay(now - i * DAY);
        const dd = daily[key] || {};
        days.push({
          day: key,
          active: Object.keys(dd.active || {}).filter((u) => u !== OWNER && !ownerUids.has(u)).length,
          newUsers: users.filter((u) => u.first && ilDay(u.first) === key).length,
          tasks: allTasks.filter((t) => t.created && ilDay(t.created) === key).length,
          installs: Number(dd.install) || 0,
          visitors: Object.keys(dd.visitors || {}).length,
          newVisitors: Object.values(visitors).filter((v) => v && v.first && ilDay(v.first) === key).length,
        });
      }
      const sum = (f) => Object.values(daily).reduce((a, dd) => a + (Number(dd && dd[f]) || 0), 0);
      const pushUsers = Object.keys(push).filter((u) => u !== OWNER && !ownerUids.has(u)).length;

      res.json({
        ok: true,
        trackingSince: Object.keys(daily).sort()[0] || null,
        users: {
          total: users.length,
          new7: users.filter((u) => u.first && now - u.first < 7 * DAY).length,
          new30: users.filter((u) => u.first && now - u.first < 30 * DAY).length,
          active1: since(DAY), active7: since(7 * DAY), active30: since(30 * DAY),
        },
        visits: (() => {
          const vs = Object.values(visitors).filter(Boolean);
          const uniq = (ms) => { const set = new Set(); for (let i = 0; i < ms; i++) Object.keys((daily[ilDay(now - i * DAY)] || {}).visitors || {}).forEach((x) => set.add(x)); return set.size; };
          return { total: vs.length, today: uniq(1), d7: uniq(7), d30: uniq(30), new7: vs.filter((v) => v.first && now - v.first < 7 * DAY).length,
            fromHome: vs.filter((v) => v.standalone).length, todayNew: vs.filter((v) => v.first && ilDay(v.first) === ilDay(now)).length };
        })(),
        installs: {
          installed: users.filter((u) => u.s.installedAt || u.s.standalone).length,
          installEvents: sum('install'),
          openFromHome7: users.filter((u) => u.s.lastStandalone && now - u.s.lastStandalone < 7 * DAY).length,
          platforms: users.reduce((a, u) => { const p = u.s.platform || 'לא ידוע'; a[p] = (a[p] || 0) + 1; return a; }, {}),
        },
        usage: {
          tasksTotal: allTasks.length,
          tasksOpen: allTasks.filter((t) => !t.done).length,
          tasks30: allTasks.filter((t) => t.created && now - t.created < 30 * DAY).length,
          voice: sum('task_voice'), typed: sum('task_typed'),
          sharedLists: Object.keys(todo.shared || {}).length,
          pushUsers,
          gcalUsers: Object.keys(gcal).filter((u) => u !== OWNER && !ownerUids.has(u)).length,
        },
        days,
      });
    } catch (err) {
      console.error('POST /tasks/stats/summary error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { register, ilDay };
