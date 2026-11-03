/**
 * תכל׳ס לעסקים – סביבת ארגון
 *   עסק מבקש לפתוח ארגון -> בעל האפליקציה מאשר (פאנל ניהול) -> בעל הארגון מצרף עובדים, מגדיר מנהלים,
 *   יוצר רשימות ארגון ומחליט מי בכל רשימה. מנהל רואה דוח משימות לפי עובד (משימות בלבד – בלי שעות כניסה).
 *   הסרת עובד: יוצא מהארגון ומכל רשימות הארגון, והמשימות הפתוחות שבאחריותו עוברות למנהל שהסיר אותו.
 * נשמר (נגיש רק לשרת):
 *   todoOrgs/<orgId> = { name, owner, ownerName, createdAt, status: 'pending'|'active'|'rejected', invite,
 *                        members: { uid: { role: 'owner'|'manager'|'member', name, at, by } } }
 *   todoUserOrg/<uid> = orgId          (משתמש שייך לארגון אחד לכל היותר)
 *   רשימת ארגון = רשימה משותפת רגילה (todo/shared/<listId>) עם השדה org = orgId.
 *     ברשימת ארגון: רק בעלים/מנהל מצרפים ומוציאים חברים; אין הצטרפות בקישור; עובד לא יוצא בעצמו.
 * נקודות קצה (Bearer):
 *   /tasks/org/mine                      -> { org|null, role, pending, members, lists }
 *   /tasks/org/request   { name }        -> בקשה לפתיחת ארגון (ממתין לאישור בעל האפליקציה)
 *   /tasks/org/admin-list                -> (בעל האפליקציה) כל הארגונים
 *   /tasks/org/admin-set { orgId, action: approve|reject|delete }
 *   /tasks/org/invite                    -> { link }  (בעלים/מנהל)
 *   /tasks/org/join      { orgId, token }
 *   /tasks/org/add       { email }       (בעלים/מנהל) – משתמש פעיל בתכל׳ס
 *   /tasks/org/remove    { uid }         (בעלים/מנהל; מנהל לא מסיר מנהל/בעלים)
 *   /tasks/org/role      { uid, role }   (בעלים בלבד)
 *   /tasks/org/leave                     (עובד/מנהל; בעלים לא עוזב)
 *   /tasks/org/list-create  { name, members: [uid] }
 *   /tasks/org/list-members { listId, add: [uid], remove: [uid] }
 *   /tasks/org/list-delete  { listId }   (בעלים בלבד)
 *   /tasks/org/report                    -> לכל עובד: פתוחות, באיחור, בוצעו ב-7 ימים, לפי רשימה
 */
const crypto = require('crypto');
const { U } = require('./tasksI18n');
const SAFE = /^[-_A-Za-z0-9]{1,128}$/;
const OWNER_APP = 'staff-tasks';
const ROLES = ['owner', 'manager', 'member'];
const ilDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const ilHM = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts));

function register(app, admin, db, express) {
  const { isAdmin } = require('./tasksAdmin');
  async function authUser(req) {
    const h = req.headers.authorization || '';
    const d = h.startsWith('Bearer ') ? await admin.auth().verifyIdToken(h.slice(7)).catch(() => null) : null;
    return d && SAFE.test(d.uid) ? d : null;
  }
  const push = (uid, title, body) => {
    const fn = require('./taskReminders').sendToUser;
    return fn ? fn(uid, title, body, 'org').catch(() => 0) : Promise.resolve(0);
  };
  const nameOf = (d) => String(d.uid === OWNER_APP ? 'רני' : (d.name || (d.email || '').split('@')[0] || 'משתמש')).slice(0, 40);
  const getOrg = async (id) => (SAFE.test(String(id || '')) ? (await db.ref(`todoOrgs/${id}`).once('value')).val() : null);
  async function myOrg(uid) {
    const id = (await db.ref(`todoUserOrg/${uid}`).once('value')).val();
    const org = id ? await getOrg(id) : null;
    return org ? { id, org, role: (org.members && org.members[uid] && org.members[uid].role) || null } : null;
  }
  const isMgr = (role) => role === 'owner' || role === 'manager';
  async function orgLists(orgId) {
    const ids = Object.keys((await db.ref(`todoOrgLists/${orgId}`).once('value')).val() || {}).filter((x) => SAFE.test(x));
    const out = [];
    for (const id of ids) { const l = (await db.ref(`todo/shared/${id}`).once('value')).val(); if (l && l.org === orgId) out.push({ id, l }); }
    return out;
  }
  const logList = (listId, ev) => db.ref(`todo/shared/${listId}/log`).push({ ...ev, at: Date.now() }).catch(() => {});
  async function limitFor(org) { return require('./tasksAccess').memberLimit(db, org.owner).catch(() => Infinity); }

  // מוציא משתמש מרשימת ארגון; משימות פתוחות שבאחריותו עוברות ל-toUid (המנהל)
  async function removeFromList(listId, l, uid, toUid, toName, byName) {
    const upd = {};
    upd[`todo/shared/${listId}/members/${uid}`] = null;
    upd[`todo/userLists/${uid}/${listId}`] = null;
    let moved = 0;
    for (const [tid, t] of Object.entries(l.tasks || {})) {
      if (t && !t.done && t.who && t.who.uid === uid) {
        upd[`todo/shared/${listId}/tasks/${tid}/who`] = toUid ? { uid: toUid, name: toName } : null;
        moved++;
      }
    }
    if (toUid && !(l.members && l.members[toUid])) { // המנהל מקבל גישה לרשימה כדי לטפל במשימות
      upd[`todo/shared/${listId}/members/${toUid}`] = { name: toName, at: Date.now(), via: 'org' };
      upd[`todo/userLists/${toUid}/${listId}`] = true;
    }
    for (const [k, v] of Object.entries(upd)) await (v === null ? db.ref(k).remove() : db.ref(k).set(v));
    await logList(listId, { type: 'remove', uid, name: (l.members && l.members[uid] && l.members[uid].name) || '', by: toUid || '', byName: byName || '' });
    return moved;
  }

  const route = (p, fn) => app.post(p, express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      await fn(req, res, d, req.body || {});
    } catch (err) {
      console.error('POST ' + p + ' error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  route('/tasks/org/mine', async (req, res, d) => {
    const m = await myOrg(d.uid);
    if (!m) return res.json({ ok: true, org: null });
    const { id, org, role } = m;
    const base = { ok: true, org: { id, name: org.name, status: org.status, owner: org.owner }, role };
    if (org.status !== 'active') return res.json(base);
    const members = Object.entries(org.members || {}).map(([uid, x]) => ({ uid, name: x.name || '', role: x.role, at: x.at || null, me: uid === d.uid }))
      .sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || String(a.name).localeCompare(String(b.name), 'he'));
    const lists = (await orgLists(id)).filter(({ l }) => isMgr(role) || (l.members && l.members[d.uid]))
      .map(({ id: lid, l }) => ({ id: lid, name: l.name, members: Object.keys(l.members || {}) }));
    res.json({ ...base, members, lists, limit: isMgr(role) ? await limitFor(org) : undefined });
  });

  route('/tasks/org/request', async (req, res, d, b) => {
    const name = String(b.name || '').trim().slice(0, 60);
    if (name.length < 2) return res.status(400).json({ error: 'כתוב את שם העסק' });
    const cur = await myOrg(d.uid);
    if (cur && cur.org.status !== 'rejected') return res.json({ ok: false, error: cur.org.status === 'pending' ? 'הבקשה כבר ממתינה לאישור' : 'אתה כבר חבר בארגון' });
    const id = 'o' + crypto.randomBytes(8).toString('hex');
    const now = Date.now(), nm = nameOf(d);
    await db.ref(`todoOrgs/${id}`).set({ name, owner: d.uid, ownerName: nm, ownerEmail: d.email || '', createdAt: now, status: 'pending',
      invite: crypto.randomBytes(9).toString('hex'), members: { [d.uid]: { role: 'owner', name: nm, at: now } } });
    await db.ref(`todoUserOrg/${d.uid}`).set(id);
    await push(OWNER_APP, '🏢 בקשה לפתיחת ארגון', name + ' – ' + nm + (d.email ? ' (' + d.email + ')' : '') + '. לאשר? 📊 ← משתמשים');
    res.json({ ok: true, status: 'pending' });
  });

  route('/tasks/org/admin-list', async (req, res, d) => {
    if (!isAdmin(d)) return res.status(401).json({ error: 'רק לבעל העסק (אימות Google)' });
    const all = (await db.ref('todoOrgs').once('value')).val() || {};
    const orgs = Object.entries(all).map(([id, o]) => ({ id, name: o.name, status: o.status, ownerName: o.ownerName || '', ownerEmail: o.ownerEmail || '',
      createdAt: o.createdAt || 0, members: Object.keys(o.members || {}).length }))
      .sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || b.createdAt - a.createdAt);
    res.json({ ok: true, orgs });
  });

  route('/tasks/org/admin-set', async (req, res, d, b) => {
    if (!isAdmin(d)) return res.status(401).json({ error: 'רק לבעל העסק (אימות Google)' });
    const org = await getOrg(b.orgId);
    if (!org) return res.status(404).json({ error: 'ארגון לא נמצא' });
    if (b.action === 'approve' || b.action === 'reject') {
      const status = b.action === 'approve' ? 'active' : 'rejected';
      await db.ref(`todoOrgs/${b.orgId}/status`).set(status);
      if (status === 'rejected') await db.ref(`todoUserOrg/${org.owner}`).remove();
      await push(org.owner, status === 'active' ? '🏢 הארגון "' + U(org.name) + '" אושר' : '🏢 הבקשה לארגון לא אושרה',
        status === 'active' ? 'אפשר לצרף עובדים וליצור רשימות – 🏢 בכותרת' : 'לפרטים – פנה לרני');
      return res.json({ ok: true, status });
    }
    if (b.action === 'delete') { // מוחק את מסגרת הארגון בלבד; רשימות הארגון נשארות כרשימות משותפות רגילות
      for (const uid of Object.keys(org.members || {})) await db.ref(`todoUserOrg/${uid}`).remove();
      for (const { id } of await orgLists(b.orgId)) await db.ref(`todo/shared/${id}/org`).remove();
      await db.ref(`todoOrgLists/${b.orgId}`).remove();
      await db.ref(`todoOrgs/${b.orgId}`).remove();
      return res.json({ ok: true, deleted: true });
    }
    res.status(400).json({ error: 'פעולה לא מוכרת' });
  });

  // ---------- עובדים ----------
  async function mgr(d, res) {
    const m = await myOrg(d.uid);
    if (!m || m.org.status !== 'active') { res.json({ ok: false, error: 'אין ארגון פעיל' }); return null; }
    if (!isMgr(m.role)) { res.status(403).json({ error: 'רק למנהל הארגון' }); return null; }
    return m;
  }
  async function addMember(m, uid, name, byUid, byName) {
    const at = Date.now();
    await db.ref(`todoOrgs/${m.id}/members/${uid}`).set({ role: 'member', name: String(name || '').slice(0, 40), at, by: byUid });
    await db.ref(`todoUserOrg/${uid}`).set(m.id);
    await push(uid, '🏢 צורפת לארגון "' + U(m.org.name) + '"', (byName ? U(byName) : 'מנהל') + ' צירף/ה אותך. רשימות הארגון יופיעו אצלך.');
  }

  route('/tasks/org/invite', async (req, res, d) => {
    const m = await mgr(d, res); if (!m) return;
    res.json({ ok: true, link: require('./tasksAdmin').APP_URL + '?org=' + m.id + '.' + m.org.invite });
  });

  route('/tasks/org/join', async (req, res, d, b) => {
    const org = await getOrg(b.orgId);
    if (!org || org.status !== 'active' || !b.token || String(b.token) !== String(org.invite)) return res.json({ ok: false, error: 'הקישור לא תקף' });
    if (org.members && org.members[d.uid]) return res.json({ ok: true, already: true, name: org.name });
    const cur = await myOrg(d.uid);
    if (cur && cur.org.status !== 'rejected') return res.json({ ok: false, error: 'אתה כבר חבר בארגון אחר' });
    if (Object.keys(org.members || {}).length >= await limitFor(org)) return res.json({ ok: false, error: 'הארגון מלא – פנה למנהל' });
    await addMember({ id: b.orgId, org }, d.uid, nameOf(d), d.uid, nameOf(d));
    await push(org.owner, '🏢 ' + U(org.name), U(nameOf(d)) + ' הצטרף/ה לארגון בקישור');
    res.json({ ok: true, name: org.name });
  });

  route('/tasks/org/add', async (req, res, d, b) => {
    const m = await mgr(d, res); if (!m) return;
    const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    const u = email ? await admin.auth().getUserByEmail(email).catch(() => null) : null;
    if (!u) return res.json({ ok: false, error: 'לא מצאתי משתמש בתכל׳ס עם המייל הזה. שלח לו קישור הזמנה לארגון במקום.' });
    if (m.org.members && m.org.members[u.uid]) return res.json({ ok: true, already: true });
    const cur = await myOrg(u.uid);
    if (cur && cur.org.status !== 'rejected') return res.json({ ok: false, error: 'המשתמש כבר חבר בארגון אחר' });
    if (Object.keys(m.org.members || {}).length >= await limitFor(m.org)) return res.json({ ok: false, error: 'הגעת למספר העובדים במסלול. להגדלה – פנה לרני.' });
    await addMember(m, u.uid, u.displayName || email.split('@')[0], d.uid, nameOf(d));
    res.json({ ok: true, name: u.displayName || email });
  });

  route('/tasks/org/remove', async (req, res, d, b) => {
    const m = await mgr(d, res); if (!m) return;
    const t = m.org.members && m.org.members[b.uid];
    if (!t) return res.json({ ok: false, error: 'לא חבר בארגון' });
    if (t.role === 'owner') return res.status(403).json({ error: 'אי אפשר להסיר את בעל הארגון' });
    if (t.role === 'manager' && m.role !== 'owner') return res.status(403).json({ error: 'רק בעל הארגון מסיר מנהל' });
    if (b.uid === d.uid) return res.status(400).json({ error: 'כדי לצאת – "עזוב ארגון"' });
    const me = nameOf(d);
    let moved = 0;
    for (const { id, l } of await orgLists(m.id)) if (l.members && l.members[b.uid]) moved += await removeFromList(id, l, b.uid, d.uid, (m.org.members[d.uid] || {}).name || me, me);
    await db.ref(`todoOrgs/${m.id}/members/${b.uid}`).remove();
    await db.ref(`todoUserOrg/${b.uid}`).remove();
    await push(b.uid, '🏢 ' + U(m.org.name), 'הוסרת מהארגון. המשימות הפרטיות שלך נשארות אצלך.');
    res.json({ ok: true, moved });
  });

  route('/tasks/org/role', async (req, res, d, b) => {
    const m = await myOrg(d.uid);
    if (!m || m.role !== 'owner' || m.org.status !== 'active') return res.status(403).json({ error: 'רק לבעל הארגון' });
    if (!['manager', 'member'].includes(b.role) || !(m.org.members && m.org.members[b.uid]) || b.uid === d.uid) return res.status(400).json({ error: 'בקשה לא תקינה' });
    await db.ref(`todoOrgs/${m.id}/members/${b.uid}/role`).set(b.role);
    res.json({ ok: true });
  });

  route('/tasks/org/leave', async (req, res, d) => {
    const m = await myOrg(d.uid);
    if (!m) return res.json({ ok: true });
    if (m.role === 'owner' && m.org.status === 'active') return res.json({ ok: false, error: 'בעל הארגון לא יכול לעזוב. לסגירת הארגון – פנה לרני.' });
    if (m.role === 'owner') { // בקשה שעדיין ממתינה / נדחתה – מבטלים
      await db.ref(`todoOrgs/${m.id}`).remove(); await db.ref(`todoUserOrg/${d.uid}`).remove();
      return res.json({ ok: true, cancelled: true });
    }
    const owner = m.org.owner, oName = (m.org.members[owner] || {}).name || '';
    for (const { id, l } of await orgLists(m.id)) if (l.members && l.members[d.uid]) await removeFromList(id, l, d.uid, owner, oName, nameOf(d));
    await db.ref(`todoOrgs/${m.id}/members/${d.uid}`).remove();
    await db.ref(`todoUserOrg/${d.uid}`).remove();
    await push(owner, '🏢 ' + U(m.org.name), U(nameOf(d)) + ' עזב/ה את הארגון. משימות פתוחות שבאחריותו/ה עברו אליך.');
    res.json({ ok: true });
  });

  // ---------- רשימות ארגון ----------
  const pick = (m, arr) => [...new Set((Array.isArray(arr) ? arr : []).filter((u) => SAFE.test(String(u)) && m.org.members && m.org.members[u]))].slice(0, 200);

  route('/tasks/org/list-create', async (req, res, d, b) => {
    const m = await mgr(d, res); if (!m) return;
    const name = String(b.name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'חסר שם לרשימה' });
    if ((await orgLists(m.id)).length >= 50) return res.json({ ok: false, error: 'יותר מדי רשימות' });
    const now = Date.now(), uids = [...new Set([d.uid, ...pick(m, b.members)])];
    const members = {};
    uids.forEach((u) => { members[u] = { name: (m.org.members[u] || {}).name || '', at: now, via: 'org', by: d.uid, byName: nameOf(d) }; });
    const ref = db.ref('todo/shared').push();
    const listId = ref.key;
    await db.ref(`todo/shared/${listId}`).set({ name, owner: d.uid, org: m.id, created: now, invite: crypto.randomBytes(9).toString('hex'), members });
    await db.ref(`todoOrgLists/${m.id}/${listId}`).set(true);
    for (const u of uids) {
      await db.ref(`todo/userLists/${u}/${listId}`).set(true);
      if (u !== d.uid) await push(u, '🏢 רשימה חדשה: ' + U(name), U(m.org.name) + ' – צורפת לרשימה');
    }
    await logList(listId, { type: 'create', uid: d.uid, name: nameOf(d) });
    res.json({ ok: true, listId });
  });

  async function orgList(m, listId, res) {
    if (!SAFE.test(String(listId || ''))) { res.status(400).json({ error: 'רשימה לא תקינה' }); return null; }
    const l = (await db.ref(`todo/shared/${listId}`).once('value')).val();
    if (!l || l.org !== m.id) { res.status(404).json({ error: 'רשימה לא נמצאה בארגון' }); return null; }
    return l;
  }

  route('/tasks/org/list-members', async (req, res, d, b) => {
    const m = await mgr(d, res); if (!m) return;
    const l = await orgList(m, b.listId, res); if (!l) return;
    const me = nameOf(d), myName = (m.org.members[d.uid] || {}).name || me;
    let added = 0, moved = 0;
    for (const u of pick(m, b.add)) {
      if (l.members && l.members[u]) continue;
      await db.ref(`todo/shared/${b.listId}/members/${u}`).set({ name: (m.org.members[u] || {}).name || '', at: Date.now(), via: 'org', by: d.uid, byName: me });
      await db.ref(`todo/userLists/${u}/${b.listId}`).set(true);
      await logList(b.listId, { type: 'add', uid: u, name: (m.org.members[u] || {}).name || '', by: d.uid, byName: me });
      await push(u, '🏢 ' + (l.name ? U(l.name) : 'רשימה'), U(me) + ' צירף/ה אותך לרשימה');
      added++;
    }
    for (const u of pick(m, b.remove)) {
      if (!(l.members && l.members[u]) || u === d.uid) continue;
      const fresh = (await db.ref(`todo/shared/${b.listId}`).once('value')).val();
      moved += await removeFromList(b.listId, fresh, u, d.uid, myName, me);
    }
    res.json({ ok: true, added, moved });
  });

  route('/tasks/org/list-delete', async (req, res, d, b) => {
    const m = await myOrg(d.uid);
    if (!m || m.role !== 'owner' || m.org.status !== 'active') return res.status(403).json({ error: 'רק לבעל הארגון' });
    const l = await orgList(m, b.listId, res); if (!l) return;
    for (const u of Object.keys(l.members || {})) if (SAFE.test(u)) await db.ref(`todo/userLists/${u}/${b.listId}`).remove();
    await db.ref(`todoOrgLists/${m.id}/${b.listId}`).remove();
    await db.ref(`todo/shared/${b.listId}`).remove(); // נשמר בגיבוי הלילי 30 יום
    res.json({ ok: true });
  });

  // ---------- דוח משימות לפי עובד (משימות בלבד) ----------
  route('/tasks/org/report', async (req, res, d) => {
    const m = await mgr(d, res); if (!m) return;
    const now = Date.now(), today = ilDay(now), hm = ilHM(now), weekAgo = now - 7 * 864e5;
    const per = {};
    Object.entries(m.org.members || {}).forEach(([uid, x]) => { per[uid] = { uid, name: x.name || '', role: x.role, open: 0, overdue: 0, done7: 0, lists: {} }; });
    const unassigned = { open: 0, overdue: 0 };
    for (const { id, l } of await orgLists(m.id)) {
      for (const t of Object.values(l.tasks || {})) {
        if (!t) continue;
        const uid = t.who && t.who.uid;
        const late = !t.done && t.date && (t.date < today || (t.date === today && t.time && t.time < hm));
        const row = uid && per[uid];
        if (!row) { if (!t.done) { unassigned.open++; if (late) unassigned.overdue++; } continue; }
        const lr = row.lists[id] = row.lists[id] || { name: l.name, open: 0, overdue: 0, done7: 0 };
        if (!t.done) { row.open++; lr.open++; if (late) { row.overdue++; lr.overdue++; } }
        else if (Number(t.doneAt) >= weekAgo) { row.done7++; lr.done7++; }
      }
    }
    const rows = Object.values(per).map((r) => ({ ...r, lists: Object.values(r.lists) })).sort((a, b) => b.overdue - a.overdue || b.open - a.open);
    res.json({ ok: true, rows, unassigned, asOf: now });
  });
}

// לשימוש מודול הרשימות: הרשאות ברשימת ארגון
async function orgRole(db, orgId, uid) {
  if (!orgId) return null;
  const o = (await db.ref(`todoOrgs/${orgId}`).once('value')).val();
  return (o && o.status === 'active' && o.members && o.members[uid] && o.members[uid].role) || null;
}

module.exports = { register, orgRole };
