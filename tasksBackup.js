/**
 * גיבוי לילי של נתוני תכל׳ס (Firebase בתוכנית החינמית - אין בה גיבוי אוטומטי)
 *   כל לילה ב-03:00 (שעון ישראל) נשמר עותק דחוס של: todo (משימות, רשימות), todoAccess, todoNag, todoGcalEv, todoStats
 *   לא נשמרים: הרשאות יומן Google (todoGcal) וטוקני התראות - רגישים, ומתחדשים לבד בחיבור מחדש.
 *   נשמר ב: todoBackup/<YYYY-MM-DD> = { at, bytes, counts, gz }  (gz = JSON דחוס ב-gzip, base64). נשמרים 30 האחרונים.
 *   נגיש רק לשרת (חוקי Firebase חוסמים כל נתיב שלא הוגדר).
 * לבעל העסק בלבד:
 *   POST /tasks/backup/list               -> { backups: [{ day, at, bytes, counts }] }
 *   POST /tasks/backup/now                -> גיבוי מיידי
 *   POST /tasks/backup/get { day }        -> { day, at, data }  (להורדה כקובץ)
 */
const zlib = require('zlib');

const OWNER = 'staff-tasks';
const PATHS = ['todo', 'todoAccess', 'todoNag', 'todoGcalEv', 'todoStats'];
const KEEP = 30;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ilDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const ilHour = (ts) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hourCycle: 'h23', hour: '2-digit' }).format(new Date(ts)));

function countData(data) {
  const todo = data.todo || {};
  let tasks = Object.keys(todo.tasks || {}).length;
  Object.values(todo.users || {}).forEach((u) => { tasks += Object.keys((u && u.tasks) || {}).length; });
  Object.values(todo.shared || {}).forEach((l) => { tasks += Object.keys((l && l.tasks) || {}).length; });
  return { tasks, users: Object.keys(todo.users || {}).length, lists: Object.keys(todo.shared || {}).length };
}

function register(app, admin, db, express) {
  async function isOwner(req) {
    const h = req.headers.authorization || '';
    const d = h.startsWith('Bearer ') ? await admin.auth().verifyIdToken(h.slice(7)).catch(() => null) : null;
    return require('./tasksAdmin').isAdmin(d);
  }

  let running = false;
  async function runBackup() {
    if (running) return null;
    running = true;
    try {
      const now = Date.now();
      const vals = await Promise.all(PATHS.map((p) => db.ref(p).once('value').then((s) => s.val())));
      const data = {};
      PATHS.forEach((p, i) => { if (vals[i] != null) data[p] = vals[i]; });
      const json = JSON.stringify(data);
      const gz = zlib.gzipSync(Buffer.from(json, 'utf8')).toString('base64');
      const day = ilDay(now);
      const counts = countData(data);
      await db.ref(`todoBackup/${day}`).set({ at: now, bytes: json.length, counts, gz });
      // שומרים רק את 30 האחרונים
      const all = (await db.ref('todoBackup').once('value')).val() || {};
      const days = Object.keys(all).filter((k) => DAY_RE.test(k)).sort();
      const upd = {};
      days.slice(0, Math.max(0, days.length - KEEP)).forEach((k) => { upd[`todoBackup/${k}`] = null; });
      if (Object.keys(upd).length) await db.ref().update(upd);
      console.log(`💾 גיבוי תכל׳ס ${day}: ${counts.tasks} משימות, ${Math.round(gz.length / 1024)}KB`);
      return { day, at: now, bytes: json.length, counts };
    } finally { running = false; }
  }

  // בדיקה כל 30 דקות: אם אחרי 03:00 ועוד אין גיבוי של היום - מגבים
  async function tick() {
    try {
      const now = Date.now();
      if (ilHour(now) < 3) return;
      const has = (await db.ref(`todoBackup/${ilDay(now)}/at`).once('value')).val();
      if (!has) await runBackup();
    } catch (err) { console.error('tasks backup error:', err.message); }
  }
  setInterval(tick, 30 * 60000);
  setTimeout(tick, 2 * 60000);

  app.post('/tasks/backup/list', express.json(), async (req, res) => {
    try {
      if (!(await isOwner(req))) return res.status(401).json({ error: 'רק לבעל העסק' });
      const all = (await db.ref('todoBackup').once('value')).val() || {};
      const backups = Object.keys(all).filter((k) => DAY_RE.test(k)).sort().reverse()
        .map((day) => ({ day, at: all[day].at, bytes: all[day].bytes, counts: all[day].counts || {} }));
      res.json({ ok: true, keep: KEEP, backups });
    } catch (err) {
      console.error('POST /tasks/backup/list error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/tasks/backup/now', express.json(), async (req, res) => {
    try {
      if (!(await isOwner(req))) return res.status(401).json({ error: 'רק לבעל העסק' });
      const r = await runBackup();
      if (!r) return res.status(409).json({ error: 'גיבוי כבר רץ' });
      res.json({ ok: true, ...r });
    } catch (err) {
      console.error('POST /tasks/backup/now error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/tasks/backup/get', express.json(), async (req, res) => {
    try {
      if (!(await isOwner(req))) return res.status(401).json({ error: 'רק לבעל העסק' });
      const day = String((req.body || {}).day || '');
      if (!DAY_RE.test(day)) return res.status(400).json({ error: 'תאריך לא תקין' });
      const b = (await db.ref(`todoBackup/${day}`).once('value')).val();
      if (!b || !b.gz) return res.status(404).json({ error: 'אין גיבוי לתאריך הזה' });
      const data = JSON.parse(zlib.gunzipSync(Buffer.from(b.gz, 'base64')).toString('utf8'));
      res.json({ ok: true, day, at: b.at, data });
    } catch (err) {
      console.error('POST /tasks/backup/get error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  return { runBackup, tick };
}

module.exports = { register };
