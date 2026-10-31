// בדיקות אוטומטיות לשרת של תכל׳ס – רצות ב-GitHub Actions בכל push (ומקומית: node --test tests/)
// Firebase / FCM / Google מדומים בזיכרון – לא נוגעים בנתונים אמיתיים.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, fakeAdmin, load, ilAgo, ilHourNow } = require('./helpers');

const OWNER = { uid: 'staff-tasks' };
const quietNow = () => { const h = ilHourNow(); return h >= 22 || h < 7; };

// ---------- מנויים / אישור משתמשים ----------
test('מנויים: משתמש חדש ממתין לאישור, ישן מקבל גישה, מנהל תמיד מורשה', async () => {
  const db = fakeDb({ todoPushTokens: { 'staff-tasks': { d: { token: 'O' } }, newbie: { d: { token: 'N' } } } });
  const admin = fakeAdmin({ newbie: { created: Date.now(), name: 'יוסי', email: 'y@x.com' }, old: { created: Date.parse('2026-10-01') } });
  admin.tokens.n = { uid: 'newbie', name: 'יוסי', email: 'y@x.com' };
  admin.tokens.o = { uid: 'old', name: 'נוגה' };
  admin.tokens.r = OWNER;
  admin.tokens.g = { uid: 'rg', email: 'ranizik@gmail.com', email_verified: true };
  const { call } = load(['taskReminders', 'tasksAccess'], db, admin);

  let r = await call('POST', '/tasks/access/me', { token: 'n' });
  assert.equal(r.body.allowed, false); assert.equal(r.body.pending, true);
  assert.ok(admin.sent.some((m) => m.title.includes('בקשת הצטרפות')), 'בעל העסק מקבל התראה על בקשה');
  assert.equal((await call('POST', '/tasks/access/me', { token: 'o' })).body.allowed, true);
  assert.equal((await call('POST', '/tasks/access/me', { token: 'r' })).body.allowed, true);
  assert.equal((await call('POST', '/tasks/access/me', { token: 'g' })).body.allowed, true, 'חשבון Google של בעל העסק');
  assert.equal((await call('POST', '/tasks/access/me')).status, 401);

  assert.equal((await call('POST', '/tasks/access/list', { token: 'n' })).status, 401, 'רק בעל העסק רואה רשימה');
  const list = await call('POST', '/tasks/access/list', { token: 'r' });
  assert.equal(list.body.users[0].uid, 'newbie', 'ממתינים ראשונים');

  r = await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'newbie', action: 'approve' } });
  assert.equal(r.body.allowed, true);
  assert.ok(admin.sent.some((m) => m.title.includes('אושרת')));
  await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'newbie', action: 'lock' } });
  assert.equal((await call('POST', '/tasks/access/me', { token: 'n' })).body.allowed, false, 'נעילה ידנית');
  assert.equal((await call('POST', '/tasks/access/set', { token: 'n', body: { uid: 'old', action: 'lock' } })).status, 401, 'משתמש לא יכול לנעול');
});

test('מנויים: תקופת הרצה (חינם) מול מצב בתשלום', async () => {
  const db = fakeDb({ todoAccess: { users: { u1: { name: 'א', until: Date.now() - 1000, plan: 'trial' } } } });
  const admin = fakeAdmin({});
  admin.tokens.u = { uid: 'u1' }; admin.tokens.r = OWNER;
  const { call, mods } = load(['taskReminders', 'tasksAccess'], db, admin);
  assert.equal((await call('POST', '/tasks/access/me', { token: 'u' })).body.allowed, true, 'חינם כברירת מחדל');
  assert.equal((await mods.tasksAccess.blockedSet(db)).size, 0);
  await call('POST', '/tasks/access/config', { token: 'r', body: { freeMode: false } });
  assert.equal((await call('POST', '/tasks/access/me', { token: 'u' })).body.allowed, false, 'תקופה שנגמרה נועלת במצב תשלום');
  assert.ok((await mods.tasksAccess.blockedSet(db)).has('u1'));
  const m = await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'u1', action: 'month' } });
  assert.equal(m.body.allowed, true); assert.equal(m.body.plan, 'paid');
  const y = await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'u1', action: 'year' } });
  assert.equal(y.body.allowed, true); assert.equal(y.body.plan, 'year');
  assert.ok(y.body.daysLeft >= 365 + 29, 'שנה נוספת על החודש ששולם');
  const e = await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'u1', action: 'until', until: Date.now() + 10 * 864e5 } });
  assert.equal(e.body.daysLeft, 10, 'תאריך סיום מדויק');
  const x = await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'u1', action: 'extend', days: 90 } });
  assert.equal(x.body.daysLeft, 100, 'הארכה מוסיפה לתאריך הקיים');
  assert.equal((await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'u1', action: 'until', until: Date.now() - 1 } })).status, 400);
  await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'u1', action: 'kind', kind: 'business' } });
  assert.equal((await call('POST', '/tasks/access/list', { token: 'r' })).body.users.find((u) => u.uid === 'u1').kind, 'business', 'לקוח עסקי');
  assert.equal((await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'u1', action: 'kind', kind: 'x' } })).status, 400);
  const t = await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'u1', action: 'approve', days: 30 } });
  assert.equal(t.body.daysLeft, 30, 'ניסיון חודש'); assert.equal(t.body.plan, 'trial');
  await call('POST', '/tasks/access/config', { token: 'r', body: { price: 15, priceBusiness: 45 } });
  assert.equal((await call('POST', '/tasks/access/me', { token: 'u' })).body.price, 45, 'מחיר עסקי');
  await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'u1', action: 'kind', kind: 'private' } });
  assert.equal((await call('POST', '/tasks/access/me', { token: 'u' })).body.price, 15, 'מחיר פרטי');
});

// ---------- תזכורות + נודניק ----------
test('תזכורות: בשעת המשימה, בלי כפילות, ונודניק אחרי 5 דקות', async () => {
  const t = ilAgo(10);
  const db = fakeDb({ todoPushTokens: { 'staff-tasks': { d1: { token: 'T' } } },
    todo: { tasks: { t1: { id: 't1', name: 'להזמין קולה', date: t.date, time: t.time, done: false, created: Date.now() - 864e5 } } } });
  const admin = fakeAdmin({});
  const { timers } = load(['taskReminders', 'tasksAccess'], db, admin);
  const tick = timers.find((x) => x.kind === 'interval' && x.ms === 60000).f;

  await tick();
  assert.deepEqual(admin.sent.map((m) => m.title), ['⏰ הגיע הזמן: להזמין קולה']);
  assert.ok(admin.sent[0].data.act, 'בהתראה יש טוקן לכפתורים');
  admin.sent.length = 0;
  await tick();
  assert.equal(admin.sent.length, 0, 'לא שולח שוב');

  db.store.todo.tasks.t1.rem.atAt = Date.now() - 6 * 60000;
  await tick();
  if (quietNow()) assert.equal(admin.sent.length, 0, 'שעות שקט');
  else assert.match(admin.sent[0].title, /^🔁 עדיין לא בוצע/);
});

test('נודניק: "עוד 30 דק׳", "בוצע" (כולל משימה חוזרת), טוקן מזויף נדחה, הגדרות', async () => {
  const t = ilAgo(10);
  const db = fakeDb({ todoPushTokens: { 'staff-tasks': { d1: { token: 'T' } } },
    todo: { tasks: { t1: { id: 't1', name: 'להשקות', date: t.date, time: t.time, done: false, rep: 'daily', created: Date.now() - 864e5 } } } });
  const admin = fakeAdmin({}); admin.tokens.r = OWNER;
  const { timers, call } = load(['taskReminders', 'tasksAccess'], db, admin);
  const tick = timers.find((x) => x.kind === 'interval' && x.ms === 60000).f;
  await tick();
  const act = admin.sent[0].data.act;

  assert.equal((await call('POST', '/tasks/nag/act', { body: { t: act, a: 'snooze' } })).body.ok, true);
  assert.ok(db.store.todo.tasks.t1.rem.snooze > Date.now() + 25 * 60000);
  admin.sent.length = 0;
  db.store.todo.tasks.t1.rem.atAt = Date.now() - 6 * 60000;
  await tick();
  assert.equal(admin.sent.length, 0, 'נדחה – לא מציק');

  assert.equal((await call('POST', '/tasks/nag/act', { body: { t: act, a: 'done' } })).body.ok, true);
  assert.equal(db.store.todo.tasks.t1.done, true);
  const next = Object.values(db.store.todo.tasks).find((x) => x.id !== 't1');
  assert.ok(next && !next.done && next.rep === 'daily' && next.date > t.date, 'נוצרה הפעם הבאה');

  const forged = act.split('.')[0] + '.' + 'A'.repeat(32);
  assert.equal((await call('POST', '/tasks/nag/act', { body: { t: forged, a: 'done' } })).status, 400);

  assert.equal((await call('POST', '/tasks/nag/settings', { token: 'r' })).body.every, 5, 'ברירת מחדל: כל 5 דקות');
  const s = await call('POST', '/tasks/nag/settings', { token: 'r', body: { mode: 'urgent', every: 15 } });
  assert.equal(s.body.mode, 'urgent'); assert.equal(s.body.every, 15);
  assert.equal((await call('POST', '/tasks/nag/settings', { token: 'r', body: { every: 7 } })).body.every, 15, 'ערך לא חוקי נדחה');
});

test('תזכורות: משתמש ממתין לאישור לא מקבל תזכורות', async () => {
  const t = ilAgo(5);
  const db = fakeDb({ todoPushTokens: { u1: { d: { token: 'T' } } }, todoAccess: { users: { u1: { pending: true } } },
    todo: { users: { u1: { tasks: { a: { id: 'a', name: 'x', date: t.date, time: t.time, created: 1 } } } } } });
  const admin = fakeAdmin({});
  const { timers } = load(['taskReminders', 'tasksAccess'], db, admin);
  await timers.find((x) => x.kind === 'interval' && x.ms === 60000).f();
  assert.equal(admin.sent.length, 0);
});

// ---------- רשימות משותפות ----------
test('רשימות: יצירה, הצטרפות בקישור, צירוף ישיר, יציאה, היסטוריה, הרשאות, מחיקה דרך השרת', async () => {
  const db = fakeDb({ todoAccess: { users: { dani: { name: 'דני' } } } });
  const admin = fakeAdmin({ dani: { email: 'dani@x.com', name: 'דני לוי' } });
  admin.tokens.r = OWNER; admin.tokens.n = { uid: 'noga', name: 'נוגה' }; admin.tokens.x = { uid: 'stranger', name: 'זר' };
  const { call } = load(['taskReminders', 'tasksAccess'], db, admin);

  const c = await call('POST', '/tasks/lists/create', { token: 'r', body: { name: 'קניות' } });
  const L = c.body.listId;
  assert.equal((await call('POST', '/tasks/lists/join', { token: 'n', body: { listId: L, invite: 'wrong' } })).status, 404);
  assert.equal((await call('POST', '/tasks/lists/join', { token: 'n', body: { listId: L, invite: c.body.invite } })).body.ok, true);

  const L2 = (await call('POST', '/tasks/lists/create', { token: 'r', body: { name: 'בית' } })).body.listId;
  const contacts = (await call('POST', '/tasks/lists/contacts', { token: 'r' })).body.contacts.map((x) => x.uid);
  assert.deepEqual(contacts, ['noga']);
  assert.equal((await call('POST', '/tasks/lists/add', { token: 'r', body: { listId: L2, uid: 'noga' } })).body.ok, true, 'צירוף איש קשר');
  assert.equal((await call('POST', '/tasks/lists/add', { token: 'r', body: { listId: L2, email: 'dani@x.com' } })).body.ok, true, 'צירוף לפי מייל');
  assert.equal((await call('POST', '/tasks/lists/add', { token: 'r', body: { listId: L2, email: 'nobody@x.com' } })).body.ok, false);
  assert.equal((await call('POST', '/tasks/lists/add', { token: 'x', body: { listId: L2, uid: 'noga' } })).status, 403, 'לא חבר – לא מצרף');

  db.store.todo.shared[L2].tasks = { a: { id: 'a', name: 'חלב' }, b: { id: 'b', name: 'לחם' } };
  assert.equal((await call('POST', '/tasks/lists/remove-tasks', { token: 'x', body: { listId: L2, ids: ['a'] } })).status, 403);
  assert.equal((await call('POST', '/tasks/lists/remove-tasks', { token: 'n', body: { listId: L2, ids: ['a'] } })).body.removed, 1);
  assert.deepEqual(Object.keys(db.store.todo.shared[L2].tasks), ['b']);

  admin.tokens.d = { uid: 'dani', name: 'דני' };
  await call('POST', '/tasks/lists/leave', { token: 'd', body: { listId: L2 } });
  const info = await call('POST', '/tasks/lists/info', { token: 'r', body: { listId: L2 } });
  assert.equal(info.body.count, 2);
  assert.deepEqual(info.body.log.map((e) => e.type).sort(), ['add', 'add', 'create', 'leave']);
  assert.equal((await call('POST', '/tasks/lists/info', { token: 'x', body: { listId: L2 } })).status, 403);
});

test('רשימות: התראה למי שהמשימה באחריותו', async () => {
  const db = fakeDb({ todo: { shared: { L: { name: 'צוות', members: { 'staff-tasks': { name: 'רני' }, noga: { name: 'נוגה' }, efrat: { name: 'אפרת' } } } } },
    todoPushTokens: { noga: { d: { token: 'N' } }, efrat: { d: { token: 'E' } } } });
  const admin = fakeAdmin({}); admin.tokens.r = OWNER;
  const { call } = load(['taskReminders', 'tasksAccess'], db, admin);
  await call('POST', '/tasks/lists/notify', { token: 'r', body: { listId: 'L', name: 'לקנות בלונים', assignee: 'noga' } });
  const byTok = Object.fromEntries(admin.sent.map((m) => [m.tokens[0], m.title]));
  assert.match(byTok.N, /באחריותך/); assert.match(byTok.E, /^👥/);
});

// ---------- נתונים ובריאות ----------
test('נתונים: כניסה לקישור נספרת, מזהה לא חוקי נדחה, סיכום רק למנהל', async () => {
  const db = fakeDb();
  const admin = fakeAdmin({}); admin.tokens.r = OWNER; admin.tokens.u = { uid: 'u' };
  const { call } = load(['taskReminders', 'tasksAccess', 'tasksStats'], db, admin);
  assert.equal((await call('POST', '/tasks/stats/visit', { body: { vid: 'abcdefgh12', src: 'wa' } })).body.ok, true);
  assert.equal((await call('POST', '/tasks/stats/visit', { body: { vid: 'x' } })).status, 400);
  assert.equal((await call('POST', '/tasks/stats/summary', { token: 'u' })).status, 401);
  const s = await call('POST', '/tasks/stats/summary', { token: 'r' });
  assert.equal(s.body.visits.today, 1); assert.equal(s.body.days.length, 30);
});

test('נתונים: מי נכנס ומתי, ומחיקת היסטוריה (למשתמש אחד ולכולם)', async () => {
  const db = fakeDb();
  const admin = fakeAdmin({ a: { name: 'דני' }, b: { name: 'יוסי' } });
  admin.tokens.r = OWNER; admin.tokens.a = { uid: 'a' }; admin.tokens.b = { uid: 'b' };
  const { call } = load(['taskReminders', 'tasksAccess', 'tasksStats'], db, admin);
  await call('POST', '/tasks/stats/ping', { token: 'a', body: {} });
  await call('POST', '/tasks/stats/ping', { token: 'a', body: {} });
  await call('POST', '/tasks/stats/ping', { token: 'b', body: {} });
  let s = (await call('POST', '/tasks/stats/summary', { token: 'r' })).body;
  assert.equal(s.activity.length, 1);
  assert.deepEqual(s.activity[0].people.map((p) => p.name).sort(), ['דני', 'יוסי']);
  assert.ok(typeof s.activity[0].people[0].at === 'number');
  const l = (await call('POST', '/tasks/access/list', { token: 'r' })).body;
  assert.equal(l.users.find((u) => u.uid === 'a').opens, 2);
  assert.equal((await call('POST', '/tasks/stats/clear', { token: 'a', body: {} })).status, 401);
  assert.equal((await call('POST', '/tasks/stats/clear', { token: 'r', body: { uid: 'a' } })).body.ok, true);
  s = (await call('POST', '/tasks/stats/summary', { token: 'r' })).body;
  assert.deepEqual(s.activity[0].people.map((p) => p.name), ['יוסי']);
  await call('POST', '/tasks/stats/clear', { token: 'r', body: {} });
  s = (await call('POST', '/tasks/stats/summary', { token: 'r' })).body;
  assert.equal(s.activity.length, 0);
  assert.equal(s.visits.total, 0);
});

test('נתונים: משימות לכל משתמש ביום, אחוז שימוש ומדדי תלות', async () => {
  const now = Date.now();
  const db = fakeDb({ todo: { users: { a: { tasks: { t1: { name: 'x', created: now - 864e5 } } } } } });
  const admin = fakeAdmin({ a: { name: 'דני' }, b: { name: 'יוסי' } });
  admin.tokens.r = OWNER; admin.tokens.a = { uid: 'a' }; admin.tokens.b = { uid: 'b' };
  const { call } = load(['taskReminders', 'tasksAccess', 'tasksStats'], db, admin);
  await call('POST', '/tasks/stats/ping', { token: 'a', body: {} });
  for (let i = 0; i < 3; i++) await call('POST', '/tasks/stats/event', { token: 'a', body: { type: 'task_voice' } });
  await call('POST', '/tasks/stats/ping', { token: 'b', body: {} });
  await call('POST', '/tasks/stats/event', { token: 'b', body: { type: 'task_typed' } });
  const s = (await call('POST', '/tasks/stats/summary', { token: 'r' })).body;
  const a = s.perUser.find((u) => u.uid === 'a'), b = s.perUser.find((u) => u.uid === 'b');
  assert.equal(a.today, 3); assert.equal(a.tasks[12], 1, 'משימה קיימת מאתמול נספרת'); assert.equal(a.d7, 4); assert.equal(a.activeDays, 2);
  assert.equal(b.today, 1); assert.equal(s.perUser[0].uid, 'a', 'ממוין לפי כמות משימות');
  assert.equal(s.pct.length, 30); assert.ok(s.pct[29].pct >= 0 && s.pct[29].pct <= 100);
  assert.equal(s.dependence.users, 2); assert.ok(s.dependence.tasksPerActiveDay > 0);
});

test('בריאות: /tasks/health ובדיקה עצמית עם התראה לבעלים', async () => {
  const db = fakeDb({ todoPushTokens: { 'staff-tasks': { d: { token: 'T' } } } });
  const admin = fakeAdmin({});
  const { call, mods, timers } = load(['taskReminders', 'tasksAccess', 'tasksHealth'], db, admin);
  const check = timers.find((x) => x.kind === 'interval' && x.ms === 5 * 60000).f;
  mods.taskReminders.health.lastTickAt = Date.now();
  assert.equal((await call('GET', '/tasks/health')).status, 200);
  mods.taskReminders.health.lastTickAt = Date.now() - 10 * 60000;
  assert.equal((await call('GET', '/tasks/health')).status, 503);
  await check();
  assert.ok(admin.sent.some((m) => m.title.startsWith('⚠️ תכל׳ס')), 'התראת תקלה');
  mods.taskReminders.health.lastTickAt = Date.now();
  await check();
  assert.ok(admin.sent.some((m) => m.title.includes('חזר לעבוד')), 'התראת חזרה');
});

// ---------- יומן ----------
test('יומן: משימה → Google Tasks + אירוע ביומן (עדכון ומחיקה)', async () => {
  process.env.GCAL_CLIENT_SECRET = 'x';
  const db = fakeDb({ todoGcal: { u1: { refresh: 'R', email: 'e', cal: true, events: true } } });
  const admin = fakeAdmin({}); admin.tokens.u = { uid: 'u1' };
  const calls = []; let n = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, o = {}) => {
    calls.push((o.method || 'GET') + ' ' + String(url).replace(/^https:\/\/[^/]+/, ''));
    if (String(url).includes('oauth2.googleapis.com/token')) return { status: 200, json: async () => ({ access_token: 'A', expires_in: 3600 }) };
    if (String(url).includes('tasks.googleapis')) return { ok: true, status: 200, json: async () => ({ id: 'gt1' }) };
    return { ok: true, status: 200, json: async () => (o.method === 'POST' ? { id: 'ev' + (++n) } : {}) };
  };
  try {
    const { call } = load(['taskReminders', 'tasksGcal'], db, admin);
    const r = await call('POST', '/tasks/gcal/task', { token: 'u', body: { op: 'create', task: { name: 'פגישה', date: '2026-11-05', time: '23:45', pri: 'high' } } });
    assert.equal(r.body.id, 'gt1');
    assert.equal(db.store.todoGcalEv.u1.gt1, 'ev1');
    await call('POST', '/tasks/gcal/task', { token: 'u', body: { op: 'update', gtaskId: 'gt1', task: { name: 'פגישה', date: '2026-11-05', done: true } } });
    await call('POST', '/tasks/gcal/task', { token: 'u', body: { op: 'delete', gtaskId: 'gt1' } });
    assert.ok(calls.includes('POST /calendar/v3/calendars/primary/events'));
    assert.ok(calls.includes('PATCH /calendar/v3/calendars/primary/events/ev1'));
    assert.ok(calls.includes('DELETE /calendar/v3/calendars/primary/events/ev1'));
    assert.equal((db.store.todoGcalEv.u1 || {}).gt1, undefined);
  } finally { global.fetch = realFetch; }
});

// ---------- מסלולים: מחיר ומכסת משתתפים ----------
test('מסלולים: מחיר לפי פרטי/עסקי, משתתפים נוספים, מחיר קבוע, ורשימה מלאה', async () => {
  const db = fakeDb({ todoAccess: { config: { freeMode: true, price: 20, priceBusiness: 50, membersPrivate: 2, membersBusiness: 3, extraPricePrivate: 4, extraPriceBusiness: 6 },
    users: { u1: { name: 'א', plan: 'free', until: null }, u2: { name: 'ב', plan: 'free', until: null }, u3: { name: 'ג', plan: 'free', until: null }, u4: { name: 'ד', plan: 'free', until: null } } } });
  const admin = fakeAdmin({});
  admin.tokens.r = OWNER; ['u1', 'u2', 'u3', 'u4'].forEach((u) => { admin.tokens[u] = { uid: u, name: u }; });
  const { call } = load(['taskReminders', 'tasksAccess'], db, admin);
  let me = (await call('POST', '/tasks/access/me', { token: 'u1' })).body;
  assert.equal(me.price, 20); assert.equal(me.limit, 2, 'פרטי כברירת מחדל');
  await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'u1', action: 'kind', kind: 'business' } });
  const x = await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'u1', action: 'extra', extra: 2 } });
  assert.equal(x.body.limit, 5); assert.equal(x.body.price, 50 + 2 * 6, 'עסקי + 2 משתתפים');
  const p = await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'u1', action: 'price', price: 99 } });
  assert.equal(p.body.price, 99); assert.equal(p.body.autoPrice, 62, 'מחיר קבוע גובר על האוטומטי');
  assert.equal((await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'u1', action: 'price', price: null } })).body.price, 62, 'חזרה לאוטומטי');
  // רשימה של לקוח פרטי עם מכסה 2: בעלים + משתתף אחד, השלישי נדחה
  const c = (await call('POST', '/tasks/lists/create', { token: 'u2', body: { name: 'בית' } })).body;
  assert.equal((await call('POST', '/tasks/lists/join', { token: 'u3', body: { listId: c.listId, invite: c.invite } })).body.ok, true);
  const full = await call('POST', '/tasks/lists/join', { token: 'u4', body: { listId: c.listId, invite: c.invite } });
  assert.equal(full.status, 403); assert.equal(full.body.full, true);
  assert.equal((await call('POST', '/tasks/lists/join', { token: 'u3', body: { listId: c.listId, invite: c.invite } })).body.ok, true, 'מי שכבר ברשימה נשאר');
  await call('POST', '/tasks/access/set', { token: 'r', body: { uid: 'u2', action: 'extra', extra: 1 } });
  assert.equal((await call('POST', '/tasks/lists/join', { token: 'u4', body: { listId: c.listId, invite: c.invite } })).body.ok, true, 'אחרי תוספת מקום');
});

// ---------- גיבוי ----------
test('גיבוי: נשמר דחוס, אפשר להוריד, רק 30 אחרונים, רק למנהל, בלי הרשאות יומן', async () => {
  const old = {}; for (let i = 0; i < 31; i++) old[`2026-01-${String(i + 1).padStart(2, '0')}`] = { at: 1, gz: 'x' };
  const db = fakeDb({ todo: { users: { a: { tasks: { t1: { name: 'לקנות חלב' } } } }, shared: { L: { tasks: { s1: { name: 'x' } } } } },
    todoGcal: { a: { refresh: 'SECRET' } }, todoBackup: old });
  const admin = fakeAdmin({}); admin.tokens.r = OWNER; admin.tokens.u = { uid: 'a' };
  const { call } = load(['tasksBackup'], db, admin);
  assert.equal((await call('POST', '/tasks/backup/now', { token: 'u' })).status, 401);
  const r = (await call('POST', '/tasks/backup/now', { token: 'r' })).body;
  assert.equal(r.ok, true); assert.equal(r.counts.tasks, 2);
  const list = (await call('POST', '/tasks/backup/list', { token: 'r' })).body;
  assert.equal(list.backups.length, 30); assert.equal(list.backups[0].day, r.day);
  const g = (await call('POST', '/tasks/backup/get', { token: 'r', body: { day: r.day } })).body;
  assert.equal(g.data.todo.users.a.tasks.t1.name, 'לקנות חלב');
  assert.equal(g.data.todoGcal, undefined, 'הרשאות יומן לא נשמרות בגיבוי');
  assert.equal((await call('POST', '/tasks/backup/get', { token: 'r', body: { day: '../x' } })).status, 400);
});
