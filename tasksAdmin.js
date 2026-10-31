/**
 * הרשאת ניהול בתכל׳ס - רק אחרי אימות עם חשבון Google של בעל העסק
 *   קוד המנהל (PIN) לבד נותן רק את המשימות של בעל העסק. כדי לראות משתמשים, נתונים וגיבויים צריך גם
 *   אימות Google של ranizik@gmail.com - ואז השרת מנפיק כניסה עם סימון gadmin (נשאר במכשיר עד התנתקות).
 *   כך גם מי שמנחש את קוד המנהל לא יכול לראות נתונים של משתמשים אחרים.
 *   POST /tasks/admin/google           { credential }  -> { ok, token }   (חלון קופץ)
 *   POST /tasks/admin/google-redirect  (טופס מגוגל)    -> חזרה ל-beit-habira.com/tasks/#ct=...&n=...&adm=1
 */
const OWNER = 'staff-tasks';
const ADMIN_EMAILS = ['ranizik@gmail.com'];
const CLIENT_ID = process.env.GCAL_CLIENT_ID || '895106923239-7ctgh1gc0je4pah4egj0t8h2ajapo95c.apps.googleusercontent.com';

// משמש את כל נתיבי הניהול (משתמשים, נתונים, גיבוי)
const isAdmin = (d) => !!(d && d.uid === OWNER && d.gadmin === true);

function register(app, admin, db, express) {
  const hits = {};
  const tooMany = (ip) => { const now = Date.now(); const a = (hits[ip] || []).filter((t) => now - t < 60000); a.push(now); hits[ip] = a; return a.length > 10; };
  async function verifyOwnerGoogle(cred) {
    if (!cred || typeof cred !== 'string' || cred.length > 4096) return null;
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred));
    const p = await r.json().catch(() => ({}));
    if (!r.ok || p.aud !== CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(p.iss)) return null;
    if (String(p.email_verified) !== 'true' || Number(p.exp) * 1000 < Date.now()) return null;
    if (!ADMIN_EMAILS.includes(String(p.email || '').toLowerCase())) return null;
    return p;
  }
  const adminToken = () => admin.auth().createCustomToken(OWNER, { staff: 'tasks', staffRole: 'owner', gadmin: true });

  app.post('/tasks/admin/google', express.json(), async (req, res) => {
    try {
      if (tooMany(req.ip)) return res.status(429).json({ error: 'יותר מדי ניסיונות, נסה שוב בעוד דקה' });
      const p = await verifyOwnerGoogle((req.body || {}).credential);
      if (!p) return res.status(403).json({ error: 'רק חשבון Google של בעל העסק יכול לפתוח את הניהול' });
      res.json({ ok: true, token: await adminToken() });
    } catch (err) {
      console.error('POST /tasks/admin/google error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/tasks/admin/google-redirect', express.urlencoded({ extended: false }), async (req, res) => {
    const back = (hash) => res.redirect(303, 'https://beit-habira.com/tasks/#' + hash);
    try {
      if (tooMany(req.ip)) return back('lerr=' + encodeURIComponent('יותר מדי ניסיונות'));
      // כמו בכניסה הרגילה: הקוד החד-פעמי (nonce) חוזר לאפליקציה, שמשווה אותו לקוד ששמרה - בקשה שלא יצאה ממנה נדחית שם
      const p = await verifyOwnerGoogle((req.body || {}).credential);
      if (!p) return back('lerr=' + encodeURIComponent('רק חשבון Google של בעל העסק יכול לפתוח את הניהול'));
      back('ct=' + encodeURIComponent(await adminToken()) + '&n=' + encodeURIComponent(p.nonce || '') + '&adm=1');
    } catch (err) {
      console.error('POST /tasks/admin/google-redirect error:', err.message);
      back('lerr=' + encodeURIComponent('שגיאת שרת'));
    }
  });
}

module.exports = { register, isAdmin, ADMIN_EMAILS };
