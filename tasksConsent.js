/**
 * אישור תנאי שימוש ומדיניות פרטיות בתכל׳ס
 *   כל משתמש מאשר את הגרסה הנוכחית של המסמכים (בהרשמה, או בחלון חד-פעמי למשתמשים קיימים).
 *   נשמר בשרת בלבד (חוקי Firebase חוסמים גישה מהדפדפן):
 *     todoConsent/<uid>        = { termsV, privacyV, at, marketing, marketingAt }
 *     todoConsentLog/<uid>/<k> = { termsV, privacyV, marketing, at }   (היסטוריה - כל אישור / שינוי)
 *   חובת האישור פעילה רק כש-todoAccess/config.consentActive = true (מופעל מהניהול אחרי פרסום המסמכים).
 *   בעל העסק לעולם לא נחסם. תקלה בשרת לא חוסמת משתמשים. אישור לא מוחק ולא יוצר חשבונות - רק רושם.
 *   POST /tasks/consent/public                      -> { active, docs }            (בלי התחברות - למסך ההרשמה)
 *   POST /tasks/consent/status   Bearer             -> { active, docs, need, accepted, marketing }
 *   POST /tasks/consent/accept   Bearer { terms, privacy, marketing } -> { ok }
 *   POST /tasks/consent/marketing Bearer { on }     -> { ok, marketing }
 */
const SAFE = /^[-_A-Za-z0-9]{1,128}$/;
const OWNER = 'staff-tasks';
// גרסאות המסמכים הנוכחיות. שינוי מהותי במסמך -> להעלות גרסה -> כל המשתמשים יתבקשו לאשר שוב
const DOCS = { terms: '1.0', privacy: '1.0' };

function register(app, admin, db, express) {
  const { ADMIN_EMAILS } = require('./tasksAdmin');
  const isOwner = (d) => d.uid === OWNER || (d.email_verified && ADMIN_EMAILS.includes(String(d.email || '').toLowerCase()));
  const active = async () => !!((await db.ref('todoAccess/config/consentActive').once('value')).val());
  async function authUser(req) {
    const h = req.headers.authorization || '';
    const d = h.startsWith('Bearer ') ? await admin.auth().verifyIdToken(h.slice(7)).catch(() => null) : null;
    return d && SAFE.test(d.uid) ? d : null;
  }
  const current = (rec) => !!(rec && rec.termsV === DOCS.terms && rec.privacyV === DOCS.privacy);

  app.post('/tasks/consent/public', express.json(), async (req, res) => {
    try { res.json({ ok: true, active: await active(), docs: DOCS }); }
    catch (err) { res.json({ ok: true, active: false, docs: DOCS }); }
  });

  app.post('/tasks/consent/status', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const [on, rec] = await Promise.all([active(), db.ref(`todoConsent/${d.uid}`).once('value').then((s) => s.val())]);
      const need = on && !isOwner(d) && !current(rec);
      res.json({ ok: true, active: on, docs: DOCS, need, accepted: rec ? { termsV: rec.termsV, privacyV: rec.privacyV, at: rec.at } : null, marketing: !!(rec && rec.marketing) });
    } catch (err) {
      console.error('POST /tasks/consent/status error:', err.message);
      res.json({ ok: false, need: false }); // תקלה בשרת לא חוסמת
    }
  });

  app.post('/tasks/consent/accept', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const b = req.body || {};
      if (b.terms !== DOCS.terms || b.privacy !== DOCS.privacy) return res.status(409).json({ error: 'המסמכים עודכנו - טען מחדש ואשר שוב', docs: DOCS });
      const now = Date.now();
      const prev = (await db.ref(`todoConsent/${d.uid}`).once('value')).val() || {};
      const marketing = !!b.marketing;
      const rec = { termsV: DOCS.terms, privacyV: DOCS.privacy, at: now, marketing, marketingAt: marketing !== !!prev.marketing || !prev.marketingAt ? now : prev.marketingAt };
      await db.ref(`todoConsent/${d.uid}`).set(rec);
      await db.ref(`todoConsentLog/${d.uid}`).push({ termsV: rec.termsV, privacyV: rec.privacyV, marketing, at: now });
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /tasks/consent/accept error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/tasks/consent/marketing', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const on = !!(req.body || {}).on, now = Date.now();
      await db.ref(`todoConsent/${d.uid}`).update({ marketing: on, marketingAt: now });
      await db.ref(`todoConsentLog/${d.uid}`).push({ marketing: on, at: now });
      res.json({ ok: true, marketing: on });
    } catch (err) {
      console.error('POST /tasks/consent/marketing error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { register, DOCS };
