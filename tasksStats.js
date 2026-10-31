/**
 * נתוני שימוש לאפליקציית המשימות - רק ספירות, לבעל העסק בלבד
 *   POST /tasks/stats/ping    { standalone, platform }      - בכל פתיחה של האפליקציה (משתמש מחובר)
 *   POST /tasks/stats/event   { type: install|task_voice|task_typed }
 *   POST /tasks/stats/summary                                - רק לבעל העסק (כניסת מנהל)
 *   POST /tasks/stats/clear   { uid? }                       - רק לבעל העסק: מחיקת היסטוריית השימוש (של משתמש אחד או של כולם)
 * נשמר ב-Firebase (נגיש רק לשרת):
 *   todoStats/users/<uid>  = { first, last, opens, standalone, platform, installedAt }
 *   todoStats/daily/<YYYY-MM-DD> = { active: {uid:ts}, tasksBy: {uid:n}, opens, install, task_voice, task_typed }
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
      await day.child(`active/${d.uid}`).set(now); // שעת הכניסה האחרונה באותו יום
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
      if (type !== 'install') await inc(db.ref(`todoStats/daily/${ilDay(Date.now())}/tasksBy/${d.uid}`)); // כמה משימות כל משתמש הוסיף ביום (כולל כאלה שנמחקו אח"כ)
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
      if (!require('./tasksAdmin').isAdmin(d)) return res.status(401).json({ error: 'רק לבעל העסק (אימות Google)' });
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
      const names = {};
      const ownerUids = new Set();
      const { OWNER_EMAILS } = require('./tasksAccess');
      const list = [...uids];
      for (let i = 0; i < list.length; i += 100) {
        const r = await admin.auth().getUsers(list.slice(i, i + 100).map((uid) => ({ uid })));
        r.users.forEach((u) => {
          created[u.uid] = Date.parse(u.metadata.creationTime) || null;
          names[u.uid] = u.displayName || u.email || '';
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
      const createdBy = {}; // uid -> { day -> מספר משימות קיימות שנוצרו באותו יום }
      const addBy = (uid, t) => { if (!uid || !t.created || uid === OWNER) return; const k = ilDay(t.created); (createdBy[uid] = createdBy[uid] || {})[k] = (createdBy[uid][k] || 0) + 1; };
      Object.values(todo.tasks || {}).forEach((t) => t && allTasks.push(t));
      Object.entries(todo.users || {}).forEach(([uid, u]) => Object.values((u && u.tasks) || {}).forEach((t) => { if (t) { allTasks.push(t); addBy(t.byUid || uid, t); } }));
      Object.values(todo.shared || {}).forEach((l) => Object.values((l && l.tasks) || {}).forEach((t) => { if (t) { allTasks.push(t); addBy(t.byUid, t); } }));

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
        ...(() => {
          // משימות לכל משתמש ביום (14 ימים) + מדדי תלות באפליקציה
          const N = 14, keys = []; for (let i = N - 1; i >= 0; i--) keys.push(ilDay(now - i * DAY));
          const counted = (uid, k) => Math.max(Number(((daily[k] || {}).tasksBy || {})[uid]) || 0, ((createdBy[uid] || {})[k]) || 0);
          const wasActive = (uid, k) => !!(((daily[k] || {}).active || {})[uid]) || counted(uid, k) > 0;
          const perUser = users.map((u) => {
            const tasks = keys.map((k) => counted(u.uid, k)), act = keys.map((k) => wasActive(u.uid, k));
            const activeDays = act.filter(Boolean).length, total = tasks.reduce((a, b) => a + b, 0);
            return { uid: u.uid, name: names[u.uid] || '', tasks, active: act.map((x) => (x ? 1 : 0)), today: tasks[N - 1], d7: tasks.slice(-7).reduce((a, b) => a + b, 0),
              total14: total, activeDays, perActiveDay: activeDays ? Math.round((total / activeDays) * 10) / 10 : 0, active7: act.slice(-7).filter(Boolean).length };
          }).sort((a, b) => b.total14 - a.total14 || b.activeDays - a.activeDays);
          // אחוז המשתמשים הרשומים (עד אותו יום) שנכנסו בכל יום - 30 יום
          const pct = days.map((d) => { const reg = users.filter((u) => u.first && ilDay(u.first) <= d.day).length;
            const act = Object.keys((daily[d.day] || {}).active || {}).filter((x) => x !== OWNER && !ownerUids.has(x)).length;
            return { day: d.day, registered: reg, active: act, pct: reg ? Math.round((Math.min(act, reg) / reg) * 100) : 0 }; });
          const last7 = pct.slice(-7), avgDau = last7.reduce((a, d) => a + d.active, 0) / 7;
          const mau = users.filter((u) => u.s.last && now - u.s.last < 30 * DAY).length;
          const actTask = perUser.reduce((a, u) => a + u.activeDays, 0);
          return { perUser, pct, dependence: {
            stickiness: mau ? Math.round((avgDau / mau) * 100) : 0, // כמה מהפעילים בחודש נכנסים בממוצע כל יום
            habit: perUser.filter((u) => u.active7 >= 3).length, // נכנסו 3+ ימים בשבוע האחרון
            users: users.length,
            tasksPerActiveDay: actTask ? Math.round((perUser.reduce((a, u) => a + u.total14, 0) / actTask) * 10) / 10 : 0,
          } };
        })(),
        // מי נכנס ומתי - 14 הימים האחרונים (at = שעת הכניסה האחרונה באותו יום; נתונים ישנים בלי שעה)
        activity: (() => {
          const out = [];
          for (let i = 0; i < 14; i++) {
            const key = ilDay(now - i * DAY);
            const act = (daily[key] || {}).active || {};
            const people = Object.entries(act).filter(([u]) => u !== OWNER && !ownerUids.has(u) && SAFE.test(u))
              .map(([u, at]) => ({ uid: u, name: names[u] || '', at: typeof at === 'number' ? at : null }))
              .sort((a, b) => (b.at || 0) - (a.at || 0));
            if (people.length) out.push({ day: key, people });
          }
          return out;
        })(),
      });
    } catch (err) {
      console.error('POST /tasks/stats/summary error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // מחיקת היסטוריית שימוש: uid - של משתמש אחד, בלי uid - של כולם (הספירות הכלליות של כניסות לקישור נשמרות)
  app.post('/tasks/stats/clear', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!require('./tasksAdmin').isAdmin(d)) return res.status(401).json({ error: 'רק לבעל העסק (אימות Google)' });
      const uid = req.body && req.body.uid;
      if (uid != null && !SAFE.test(String(uid))) return res.status(400).json({ error: 'משתמש לא תקין' });
      const daily = (await db.ref('todoStats/daily').once('value')).val() || {};
      const upd = {};
      if (uid) {
        upd[`todoStats/users/${uid}`] = null;
        Object.keys(daily).forEach((k) => { if (daily[k] && daily[k].active && daily[k].active[uid] != null) upd[`todoStats/daily/${k}/active/${uid}`] = null; });
      } else {
        upd['todoStats/users'] = null;
        Object.keys(daily).forEach((k) => { if (daily[k] && daily[k].active) upd[`todoStats/daily/${k}/active`] = null; });
      }
      await db.ref().update(upd);
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /tasks/stats/clear error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { register, ilDay };
