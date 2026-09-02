/**
 * Beit HaBira - Integration API
 * שכבת חיבור בין אפליקציית ההזמנות (Firebase) לבין מנוע הקופות
 *
 * Environment Variables נדרשים:
 *   FIREBASE_KEY     - תוכן קובץ ה-Service Account JSON (כמחרוזת אחת)
 *   FIREBASE_DB_URL  - כתובת ה-Realtime Database
 *   API_KEY          - מפתח סודי לאימות בקשות ל-API הזה
 *
 * סניפים תקפים: shfayim | tel_mond
 */

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const ExcelJS = require('exceljs');

// ---------- בדיקת משתני סביבה ----------
const REQUIRED_ENV = ['FIREBASE_KEY', 'FIREBASE_DB_URL', 'API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('❌ חסרים משתני סביבה:', missing.join(', '));
  process.exit(1);
}

const VALID_BRANCHES = ['shfayim', 'tel_mond'];

// ---------- אתחול Firebase ----------
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch (err) {
  console.error('❌ FIREBASE_KEY אינו JSON תקין:', err.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL,
});

const db = admin.database();

// ---------- Express App ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// לוגים בסיסיים לכל בקשה
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

// הגנת Rate Limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. נסה שוב בעוד רגע.' },
});
app.use(limiter);

// אימות API Key - מתקבל גם כ-header וגם כפרמטר בכתובת (?api_key=...) לצורך תאימות
// עם מערכות שלא תומכות בשליחת headers מותאמים (כמו קישור ישיר להורדת קובץ).
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized - API key חסר או שגוי' });
  }
  next();
}

// ---------- Health Check (ללא אימות) ----------
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'beit-habira-api', time: new Date().toISOString() });
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ================= תשלומים (PayPlus) - ציבורי, נגיש ללקוחות מהאפליקציה =================
//
// TODO לפני הפעלה בפועל:
//   1. להירשם ל-PayPlus, ליצור "עמוד תשלום" (Payment Page) בדשבורד שלהם
//   2. להגדיר ב-Render 3 משתני סביבה: PAYPLUS_API_KEY, PAYPLUS_SECRET_KEY, PAYPLUS_PAGE_UID
//   3. לבדוק מול הדוגמה שהם נותנים בדשבורד שלהם ששמות השדות בגוף הבקשה תואמים בדיוק -
//      תיעוד ה-API עשוי להשתנות, ואין לי דרך לבדוק את זה מולם בפועל בלי מפתחות אמיתיים.

const PAYPLUS_BASE = 'https://restapi.payplus.co.il/api/v1.0';

function paymentsConfigured() {
  return !!(process.env.PAYPLUS_API_KEY && process.env.PAYPLUS_SECRET_KEY && process.env.PAYPLUS_PAGE_UID);
}

// POST /payments/create-link  body: { branch, orderId }
// שים לב: הסכום נלקח מתוך ההזמנה השמורה ב-Firebase (לא מהלקוח!) - כדי שאי אפשר יהיה
// לשנות מחיר בצד הלקוח ולשלם פחות.
app.post('/payments/create-link', express.json(), async (req, res) => {
  try {
    if (!paymentsConfigured()) {
      return res.status(503).json({ error: 'סליקה עדיין לא מוגדרת בשרת (חסרים מפתחות PayPlus)' });
    }
    const { branch, orderId } = req.body || {};
    if (!branch || !orderId) return res.status(400).json({ error: 'branch ו-orderId חובה' });
    if (!VALID_BRANCHES.includes(branch)) return res.status(400).json({ error: 'branch לא תקין' });

    const orderSnap = await db.ref(`pickupOrders/${branch}/${orderId}`).once('value');
    const order = orderSnap.val();
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    if (order.paymentStatus === 'paid') return res.status(409).json({ error: 'ההזמנה כבר שולמה' });

    const origin = req.headers.origin || `https://${req.headers.host}`;

    const payload = {
      payment_page_uid: process.env.PAYPLUS_PAGE_UID,
      amount: order.totalAmount,
      currency_code: 'ILS',
      more_info: `${branch}:${orderId}`, // נשתמש בזה בוובהוק כדי לדעת לאיזו הזמנה זה שייך
      refURL_success: `${origin}/index.html?branch=${branch}&paymentOrderId=${orderId}&paymentStatus=success`,
      refURL_failure: `${origin}/index.html?branch=${branch}&paymentOrderId=${orderId}&paymentStatus=failure`,
      refURL_callback: `${req.protocol}://${req.headers.host}/payments/webhook`,
    };

    const ppRes = await fetch(`${PAYPLUS_BASE}/PaymentPages/generateLink`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.PAYPLUS_API_KEY,
        'secret-key': process.env.PAYPLUS_SECRET_KEY,
      },
      body: JSON.stringify(payload),
    });
    const ppData = await ppRes.json();
    if (!ppRes.ok || !ppData || !ppData.data || !ppData.data.payment_page_link) {
      console.error('PayPlus generateLink failed:', JSON.stringify(ppData));
      return res.status(502).json({ error: 'יצירת קישור תשלום נכשלה', details: ppData });
    }

    res.json({ paymentUrl: ppData.data.payment_page_link });
  } catch (err) {
    console.error('POST /payments/create-link error:', err.message);
    res.status(502).json({ error: 'שגיאה ביצירת קישור תשלום', details: err.message });
  }
});

// POST /payments/webhook - PayPlus קוראים לזה שרת-לשרת אחרי תשלום (מקור האמת - לא לסמוך על הפניית success בלבד)
app.post('/payments/webhook', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    console.log('PayPlus webhook received:', JSON.stringify(body));

    // TODO: לבדוק מול פלט אמיתי מהם את שמות השדות המדויקים (status_code/transaction_type וכו')
    const moreInfo = body.more_info || (body.data && body.data.more_info) || '';
    const [branch, orderId] = String(moreInfo).split(':');
    const isApproved = body.transaction_type === 'Approved' || body.status_code === '000' || body.status === 'approved';

    if (branch && orderId && VALID_BRANCHES.includes(branch)) {
      await db.ref(`pickupOrders/${branch}/${orderId}`).update({
        paymentStatus: isApproved ? 'paid' : 'failed',
        paymentUpdatedAt: Date.now(),
        paymentRaw: body,
      });
    }
    res.json({ received: true });
  } catch (err) {
    console.error('POST /payments/webhook error:', err.message);
    res.status(200).json({ received: true }); // תמיד 200 לוובהוק, כדי שלא ינסו שוב ושוב על שגיאה אצלנו
  }
});

// ================= התראת פוש על הזמנה חדשה - ציבורי (נקרא מהלקוח מיד אחרי יצירת הזמנה) =================
//
// למה ציבורי ולא מוגן ב-API Key: הלקוח עצמו (לא admin) הוא זה שיוצר את ההזמנה ומודיע עליה.
// ה-endpoint רק שולח התראה - לא חושף/משנה נתונים רגישים, ומאמת שההזמנה אכן קיימת ב-Firebase לפני השליחה.
//
// POST /notify-new-order  body: { branch, orderId }
app.post('/notify-new-order', express.json(), async (req, res) => {
  try {
    const { branch, orderId } = req.body || {};
    if (!branch || !orderId || !VALID_BRANCHES.includes(branch)) {
      return res.status(400).json({ error: 'branch ו-orderId תקפים חובה' });
    }
    // מוודאים שההזמנה אכן קיימת (לא סתם שולחים התראות שרירותיות)
    const orderSnap = await db.ref(`pickupOrders/${branch}/${orderId}`).once('value');
    const order = orderSnap.val();
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });

    const tokensSnap = await db.ref(`adminPushTokens/${branch}`).once('value');
    const tokensData = tokensSnap.val() || {};
    const tokens = Object.values(tokensData).map((t) => t && t.token).filter(Boolean);

    if (!tokens.length) {
      return res.json({ ok: true, sent: 0, note: 'אין מכשירי admin רשומים להתראות בסניף הזה' });
    }

    const message = {
      notification: {
        title: 'הזמנה חדשה 🔔',
        body: `${order.customerName || 'לקוח'} · ₪${(order.totalAmount || 0).toFixed(2)} · ${(order.items || []).length} פריטים`,
      },
      tokens,
    };
    const result = await admin.messaging().sendEachForMulticast(message);

    // מנקים מזהי מכשיר שכבר לא תקפים (המשתמש הסיר הרשאה/מחק את האפליקציה) כדי לא לצבור זבל
    const invalidTokens = [];
    result.responses.forEach((r, i) => {
      if (!r.success && r.error && ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(r.error.code)) {
        invalidTokens.push(tokens[i]);
      }
    });
    if (invalidTokens.length) {
      const cleanup = {};
      invalidTokens.forEach((t) => { cleanup[skKey(t)] = null; });
      await db.ref(`adminPushTokens/${branch}`).update(cleanup);
    }

    res.json({ ok: true, sent: result.successCount, failed: result.failureCount });
  } catch (err) {
    console.error('POST /notify-new-order error:', err.message);
    // לעולם לא נכשיל את יצירת ההזמנה בגלל שגיאת התראה - הלקוח כבר קיבל אישור הזמנה
    res.status(200).json({ ok: false, error: err.message });
  }
});

// ---------- Middleware אימות לכל שאר הנתיבים ----------
app.use(requireApiKey);


// ---------- עזר: קריאת ענף מ-Firebase עם timeout ----------
function readRef(path, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Firebase timeout')), timeoutMs);
    db.ref(path)
      .once('value')
      .then((snap) => {
        clearTimeout(timer);
        resolve(snap.val());
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function validateBranch(branch, res) {
  if (!branch) {
    res.status(400).json({ error: `פרמטר branch חובה (${VALID_BRANCHES.join(' / ')})` });
    return false;
  }
  if (!VALID_BRANCHES.includes(branch)) {
    res.status(400).json({ error: `branch לא תקין. ערכים תקפים: ${VALID_BRANCHES.join(' / ')}` });
    return false;
  }
  return true;
}

// ---------- עזרי נורמליזציה - Firebase לפעמים שומר מערכים כאובייקט עם מפתחות מספריים ----------
function normArr(a) {
  if (Array.isArray(a)) return a;
  if (!a) return [];
  return Object.keys(a).sort((x, y) => +x - +y).map((k) => a[k]);
}
function skKey(name) {
  return String(name).replace(/[.#$[\]/]/g, '_');
}
function isPromoActive(promo) {
  if (!promo || !promo.type) return false;
  const now = new Date();
  if (promo.from && new Date(promo.from) > now) return false;
  if (promo.to && new Date(promo.to) < now) return false;
  return true;
}

// ---------- ליבה: שליפת כל המוצרים של סניף, בפורמט אחיד ----------
async function fetchProducts(branch) {
  const data = await readRef(`suppliers/${branch}`);
  const suppliers = normArr(data);
  const products = [];

  suppliers.forEach((sup) => {
    if (!sup) return;
    const cats = normArr(sup.cats);
    cats.forEach((cat) => {
      if (!cat) return;
      const items = normArr(cat.items);
      items.forEach((name) => {
        if (!name) return;
        const isk = skKey(name);
        const priceEntry = (cat.prices || {})[isk] ?? (cat.prices || {})[name];
        const price = priceEntry ? (typeof priceEntry === 'object' ? priceEntry.b || 0 : parseFloat(priceEntry) || 0) : 0;
        const unitsPerBox = priceEntry && typeof priceEntry === 'object' ? priceEntry.unitsPerBox || 0 : 0;
        const barcode = (cat.barcodes || {})[isk] ?? (cat.barcodes || {})[name] ?? '';
        const image = (cat.images || {})[isk] ?? (cat.images || {})[name] ?? '';
        const promoRaw = (cat.promos || {})[isk] ?? (cat.promos || {})[name] ?? null;
        const promoActive = isPromoActive(promoRaw);
        products.push({
          barcode: barcode || null,
          name,
          category: cat.cat || null,
          supplier: sup.label || sup.key || '',
          unitPrice: price,
          unitsPerBox: unitsPerBox || null,
          promoActive,
          promoType: promoActive ? promoRaw.type : null,
          promoValue: promoActive ? promoRaw.val : null,
          imageUrl: image || null,
        });
      });
    });
  });

  return products;
}

// ---------- ליבה: שליפת הזמנות (מהיסטוריית ההזמנות) ----------
// מקבל timestamp (מספר) או תאריך פשוט כמו 2026-08-23 - ומחזיר מילישניות.
// כש-endOfDay=true (בשביל פרמטר to) ותאריך בלי שעה נמסר, מתייחסים לסוף אותו היום (23:59:59.999)
// כדי שהתאריך האחרון ייכלל בטווח באופן טבעי.
function parseDateParam(value, endOfDay = false) {
  if (!value) return null;
  if (/^\d+$/.test(String(value))) return Number(value); // timestamp מספרי טהור
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(value));
  const t = new Date(value).getTime();
  if (isNaN(t)) return null;
  return isDateOnly && endOfDay ? t + (24 * 60 * 60 * 1000 - 1) : t;
}

async function fetchOrders(branch, { from, to } = {}) {
  const historyData = await readRef(`orderHistory/${branch}`);
  if (!historyData) return [];

  const records = Object.entries(historyData).map(([id, rec]) => ({ id, ...rec }));
  const fromMs = parseDateParam(from, false);
  const toMs = parseDateParam(to, true);

  let filtered = records;
  if (fromMs != null) filtered = filtered.filter((r) => r.date && new Date(r.date).getTime() >= fromMs);
  if (toMs != null) filtered = filtered.filter((r) => r.date && new Date(r.date).getTime() <= toMs);

  return filtered;
}

function ordersToManeoRows(orderRecords, barcodeMap) {
  const rows = [];
  orderRecords.forEach((rec) => {
    normArr(rec.items).forEach((item) => {
      if (!item) return;
      const barcode = barcodeMap ? barcodeMap.get(`${item.cat}||${item.name}`) : null;
      rows.push({
        orderId: rec.id,
        date: rec.date || null,
        supplier: rec.supLabel || '',
        barcode: barcode || '',
        name: item.name || '',
        quantity: item.lineUnits ?? ((item.cartons || 0) + (item.units || 0)) ?? 0,
        unitPrice: item.price ?? 0,
        discount: item.promo ? item.promo.val || 0 : 0,
      });
    });
  });
  return rows;
}

// ================= JSON API =================

// GET /products?branch=shfayim
app.get('/products', async (req, res) => {
  try {
    const { branch } = req.query;
    if (!validateBranch(branch, res)) return;
    const products = await fetchProducts(branch);
    res.json({ branch, count: products.length, products });
  } catch (err) {
    console.error('GET /products error:', err.message);
    res.status(502).json({ error: 'שגיאה בקריאת מוצרים', details: err.message });
  }
});

// GET /orders?branch=shfayim&format=maneo&from=...&to=...
app.get('/orders', async (req, res) => {
  try {
    const { branch, format, from, to } = req.query;
    if (!validateBranch(branch, res)) return;

    const [orderRecords, products] = await Promise.all([
      fetchOrders(branch, { from, to }),
      fetchProducts(branch),
    ]);
    const barcodeMap = new Map();
    products.forEach((p) => barcodeMap.set(`${p.category}||${p.name}`, p.barcode));

    if (format === 'maneo') {
      const rows = ordersToManeoRows(orderRecords, barcodeMap);
      return res.json({ branch, format: 'maneo', count: rows.length, rows });
    }

    res.json({ branch, count: orderRecords.length, orders: orderRecords });
  } catch (err) {
    console.error('GET /orders error:', err.message);
    res.status(502).json({ error: 'שגיאה בקריאת הזמנות', details: err.message });
  }
});

// ================= דף ייצוא ידני (טופס פשוט - בלי צורך לבנות קישורים ידנית) =================

// GET /export?api_key=... - דף עם טופס: בחירת סניף + טווח תאריכים + כפתור הורדה
app.get('/export', (req, res) => {
  const key = req.query.api_key || '';
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ייצוא הזמנות - בית הבירה והיין</title>
<style>
  body{font-family:Arial,sans-serif;background:#f5f3ef;margin:0;padding:24px;direction:rtl;}
  .card{max-width:420px;margin:0 auto;background:white;border-radius:12px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08);}
  h1{font-size:19px;margin:0 0 18px;}
  label{display:block;font-size:13px;font-weight:700;margin:14px 0 5px;color:#444;}
  select,input[type=date]{width:100%;padding:9px 10px;border:1.5px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box;}
  button{width:100%;margin-top:20px;padding:12px;background:#1f6feb;color:white;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;}
  button:hover{background:#1a5fd1;}
  .err{color:#c0392b;font-size:13px;margin-top:10px;}
</style>
</head>
<body>
  <div class="card">
    <h1>📥 ייצוא הזמנות ל-Excel</h1>
    <form action="/files/orders.xlsx" method="get">
      <input type="hidden" name="api_key" value="${key.replace(/"/g, '&quot;')}">
      <label>סניף</label>
      <select name="branch">
        <option value="tel_mond">תל מונד</option>
        <option value="shfayim">שפיים</option>
      </select>
      <label>מתאריך</label>
      <input type="date" name="from" value="${today}">
      <label>עד תאריך</label>
      <input type="date" name="to" value="${today}">
      <button type="submit">⬇ הורד קובץ Excel</button>
    </form>
    ${!key ? '<div class="err">⚠️ חסר api_key בכתובת - הוסף ?api_key=... לסוף הקישור</div>' : ''}
  </div>
</body>
</html>`);
});

// ================= קבצי Excel (לינק סטטי להורדה - למערכות שלא תומכות ב-API רגיל) =================

// GET /files/products.xlsx?branch=shfayim&api_key=...
app.get('/files/products.xlsx', async (req, res) => {
  try {
    const { branch } = req.query;
    if (!validateBranch(branch, res)) return;
    const products = await fetchProducts(branch);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('מוצרים');
    ws.views = [{ rightToLeft: true }];
    ws.columns = [
      { header: 'ברקוד', key: 'barcode', width: 16 },
      { header: 'שם מוצר', key: 'name', width: 35 },
      { header: 'קטגוריה', key: 'category', width: 18 },
      { header: 'ספק', key: 'supplier', width: 20 },
      { header: 'מחיר יחידה', key: 'unitPrice', width: 12 },
      { header: 'יח\' בקרטון', key: 'unitsPerBox', width: 12 },
      { header: 'מבצע פעיל', key: 'promoActive', width: 10 },
      { header: 'סוג מבצע', key: 'promoType', width: 10 },
      { header: 'ערך מבצע', key: 'promoValue', width: 10 },
      { header: 'קישור לתמונה', key: 'imageUrl', width: 45 },
    ];
    ws.getRow(1).font = { bold: true };
    products.forEach((p) => {
      const row = ws.addRow(p);
      if (p.imageUrl) {
        row.getCell('imageUrl').value = { text: p.imageUrl, hyperlink: p.imageUrl };
        row.getCell('imageUrl').font = { color: { argb: 'FF1155CC' }, underline: true };
      }
    });

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="products-${branch}.xlsx"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error('GET /files/products.xlsx error:', err.message);
    res.status(502).json({ error: 'שגיאה ביצירת קובץ Excel', details: err.message });
  }
});

// GET /files/orders.xlsx?branch=shfayim&api_key=...
app.get('/files/orders.xlsx', async (req, res) => {
  try {
    const { branch, from, to } = req.query;
    if (!validateBranch(branch, res)) return;

    const [orderRecords, products] = await Promise.all([
      fetchOrders(branch, { from, to }),
      fetchProducts(branch),
    ]);
    const barcodeMap = new Map();
    products.forEach((p) => barcodeMap.set(`${p.category}||${p.name}`, p.barcode));
    const rows = ordersToManeoRows(orderRecords, barcodeMap);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('הזמנות');
    ws.views = [{ rightToLeft: true }];
    ws.columns = [
      { header: 'מזהה הזמנה', key: 'orderId', width: 22 },
      { header: 'תאריך', key: 'date', width: 20 },
      { header: 'ספק', key: 'supplier', width: 20 },
      { header: 'ברקוד', key: 'barcode', width: 16 },
      { header: 'שם מוצר', key: 'name', width: 35 },
      { header: 'כמות', key: 'quantity', width: 10 },
      { header: 'מחיר יחידה', key: 'unitPrice', width: 12 },
      { header: 'הנחה', key: 'discount', width: 10 },
    ];
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow(r));

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="orders-${branch}.xlsx"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error('GET /files/orders.xlsx error:', err.message);
    res.status(502).json({ error: 'שגיאה ביצירת קובץ Excel', details: err.message });
  }
});

// ================= סנכרון מוצרים מ-WooCommerce =================
//
// TODO לפני הפעלה בפועל:
//   1. ב-WooCommerce (וורדפרס): הגדרות -> תקדם -> REST API -> צור מפתח חדש
//      (מספיקה הרשאת "קריאה בלבד" - Read)
//   2. להגדיר ב-Render 2 משתני סביבה: WOOCOMMERCE_CONSUMER_KEY, WOOCOMMERCE_CONSUMER_SECRET
//      (לעולם לא בקוד/ב-Firebase/בצד לקוח - רק כמשתני סביבה כאן בשרת)
//   3. (אופציונלי) WOOCOMMERCE_URL אם הכתובת שונה מברירת המחדל למטה

const WOOCOMMERCE_URL = process.env.WOOCOMMERCE_URL || 'https://beit-habira.com';

function woocommerceConfigured() {
  return !!(process.env.WOOCOMMERCE_CONSUMER_KEY && process.env.WOOCOMMERCE_CONSUMER_SECRET);
}

// שולף את כל המוצרים מ-WooCommerce, כולל דפדוף מלא (Pagination) - לא רק עמוד ראשון
async function fetchAllWooCommerceProducts() {
  const products = [];
  let page = 1;
  const perPage = 100;
  while (true) {
    const url = `${WOOCOMMERCE_URL}/wp-json/wc/v3/products?per_page=${perPage}&page=${page}&status=publish` +
      `&consumer_key=${encodeURIComponent(process.env.WOOCOMMERCE_CONSUMER_KEY)}` +
      `&consumer_secret=${encodeURIComponent(process.env.WOOCOMMERCE_CONSUMER_SECRET)}`;
    const wcRes = await fetch(url);
    if (!wcRes.ok) {
      throw new Error(`WooCommerce API החזיר שגיאה (עמוד ${page}): ${wcRes.status} ${wcRes.statusText}`);
    }
    const batch = await wcRes.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    products.push(...batch);
    if (batch.length < perPage) break; // הגענו לעמוד האחרון
    page++;
    if (page > 200) break; // הגנת בטיחות - לא אמור לקרות בקטלוג רגיל
  }
  return products;
}

// שולף את כל קטגוריות WooCommerce (עם parent) - כדי לשמר מבנה הורה/ילד (יין -> יין אדום) ולא רק רשימה שטוחה
async function fetchAllWooCommerceCategories() {
  const cats = [];
  let page = 1;
  while (true) {
    const url = `${WOOCOMMERCE_URL}/wp-json/wc/v3/products/categories?per_page=100&page=${page}` +
      `&consumer_key=${encodeURIComponent(process.env.WOOCOMMERCE_CONSUMER_KEY)}` +
      `&consumer_secret=${encodeURIComponent(process.env.WOOCOMMERCE_CONSUMER_SECRET)}`;
    const wcRes = await fetch(url);
    if (!wcRes.ok) {
      throw new Error(`WooCommerce קטגוריות - שגיאה (עמוד ${page}): ${wcRes.status} ${wcRes.statusText}`);
    }
    const batch = await wcRes.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    cats.push(...batch);
    if (batch.length < 100) break;
    page++;
    if (page > 50) break;
  }
  return cats;
}

function normalizeWooProduct(wp, categoryParentById) {
  // אם למוצר יש כמה קטגוריות, מעדיפים את המדויקת ביותר (זו שיש לה הורה - כלומר תת-קטגוריה) על פני קטגוריה ראשית כללית
  let categoryObj = null;
  if (wp.categories && wp.categories.length) {
    categoryObj = wp.categories.find((c) => categoryParentById && categoryParentById[c.id]) || wp.categories[0];
  }
  const category = (categoryObj && categoryObj.name) ? String(categoryObj.name).trim() : '';
  const image = (wp.images && wp.images[0] && wp.images[0].src) ? wp.images[0].src : '';
  const regularPrice = parseFloat(wp.regular_price || wp.price || 0) || 0;
  const salePrice = parseFloat(wp.sale_price || 0) || 0;
  const onSale = !!wp.on_sale && salePrice > 0 && salePrice < regularPrice;
  return {
    wooId: wp.id,
    sku: wp.sku || '',
    name: wp.name || '',
    image,
    category,
    price: regularPrice,
    promo: onSale ? { type: 'fixed', val: salePrice } : null,
    inStock: wp.stock_status === 'instock',
  };
}

// POST /sync/woocommerce?branch=shfayim - מריץ סנכרון מלא, נקרא מכפתור "עדכן מוצרים מהאתר" בניהול
app.post('/sync/woocommerce', requireApiKey, async (req, res) => {
  const branch = req.query.branch;
  if (!validateBranch(branch, res)) return;
  if (!woocommerceConfigured()) {
    return res.status(503).json({
      error: 'WooCommerce לא מוגדר',
      details: 'חסרים משתני הסביבה WOOCOMMERCE_CONSUMER_KEY ו-WOOCOMMERCE_CONSUMER_SECRET ב-Render',
    });
  }

  const stats = { foundOnSite: 0, beforeInFirebase: 0, added: 0, updated: 0, pendingReview: 0, errors: [] };

  try {
    // שלב 1: גיבוי מלא לפני כל שינוי - snapshot עם חותמת זמן, לא נמחק אף פעם אוטומטית
    const currentSnap = await db.ref(`retail/${branch}`).once('value');
    const currentData = currentSnap.val() || {};
    stats.beforeInFirebase = Object.keys(currentData).length;
    await db.ref(`retailBackups/${branch}/${Date.now()}`).set(currentData);

    // שלב 2: משיכת כל המוצרים מהאתר, עם Pagination מלא
    const wooProducts = await fetchAllWooCommerceProducts();
    stats.foundOnSite = wooProducts.length;

    // שלב 2.5: משיכת קטגוריות ובניית מבנה הורה/ילד (יין -> יין אדום), כדי לשמר תתי-קטגוריות ולא רשימה שטוחה
    const wooCategories = await fetchAllWooCommerceCategories();
    const categoryNameById = {};
    wooCategories.forEach((c) => { categoryNameById[c.id] = String(c.name).trim(); });
    const categoryParentById = {}; // { categoryId: parentCategoryId } - רק לקטגוריות שיש להן הורה אמיתי
    const categoryHierarchyUpdates = {}; // { "שם תת-קטגוריה": "שם קטגוריית-על" } - בפורמט ש-Firebase שלנו כבר יודע לקרוא
    wooCategories.forEach((c) => {
      if (c.parent && c.parent !== 0 && categoryNameById[c.parent]) {
        categoryParentById[c.id] = c.parent;
        const childName = categoryNameById[c.id];
        const parentName = categoryNameById[c.parent];
        categoryHierarchyUpdates[skKey(childName)] = parentName;
      }
    });
    if (Object.keys(categoryHierarchyUpdates).length) {
      await db.ref(`retailCategoryHierarchy/${branch}`).update(categoryHierarchyUpdates);
    }

    // שלב 3: התאמה - קודם לפי wooId (מזהה יציב), ואז לפי SKU כגיבוי
    const byWooId = {};
    const bySku = {};
    Object.entries(currentData).forEach(([key, item]) => {
      if (item && item.wooId) byWooId[item.wooId] = key;
      if (item && item.sku) bySku[item.sku] = key;
    });

    const updates = {};
    const matchedKeys = new Set();

    wooProducts.forEach((wp) => {
      const norm = normalizeWooProduct(wp, categoryParentById);
      if (!norm.name || !norm.price) {
        stats.errors.push(`מוצר WooCommerce ${wp.id} דולג - חסר שם או מחיר תקין`);
        return;
      }
      const existingKey = byWooId[norm.wooId] || (norm.sku && bySku[norm.sku]) || null;
      if (existingKey) {
        matchedKeys.add(existingKey);
        updates[existingKey] = { ...currentData[existingKey], ...norm, syncedFromWoo: true, status: 'active', lastSyncAt: Date.now() };
        stats.updated++;
      } else {
        const newKey = `woo_${norm.wooId}`;
        updates[newKey] = { ...norm, syncedFromWoo: true, status: 'active', lastSyncAt: Date.now(), updatedAt: Date.now() };
        stats.added++;
      }
    });

    // שלב 4: מוצרים שהיו מסונכרנים בעבר מהאתר אך נעלמו ממנו -> מועברים ל"דורש בדיקה", לעולם לא נמחקים
    Object.entries(currentData).forEach(([key, item]) => {
      if (item && item.syncedFromWoo && item.wooId && !matchedKeys.has(key)) {
        updates[key] = { ...item, status: 'pending_review', reviewReason: 'לא נמצא באתר', lastSyncAt: Date.now() };
        stats.pendingReview++;
      }
    });

    // שלב 5: כתיבה אחת מרוכזת - לא כותבים חלקי-חלקי כדי לא להשאיר מצב ביניים אם משהו נכשל באמצע
    await db.ref(`retail/${branch}`).update(updates);

    res.json({ ok: true, branch, stats, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error('POST /sync/woocommerce error:', err.message);
    res.status(502).json({ error: 'סנכרון נכשל', details: err.message, stats });
  }
});

// GET /sync/status?branch=shfayim - מצב הסנכרון האחרון, לדשבורד בניהול
app.get('/sync/status', requireApiKey, async (req, res) => {
  const branch = req.query.branch;
  if (!validateBranch(branch, res)) return;
  try {
    const snap = await db.ref(`retail/${branch}`).once('value');
    const items = Object.values(snap.val() || {});
    const lastSyncAt = items.reduce((max, it) => Math.max(max, (it && it.lastSyncAt) || 0), 0);
    res.json({
      configured: woocommerceConfigured(),
      lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
      totalProducts: items.length,
      active: items.filter((it) => it && it.status !== 'pending_review').length,
      pendingReview: items.filter((it) => it && it.status === 'pending_review').length,
      noPrice: items.filter((it) => it && !(it.price > 0)).length,
      noImage: items.filter((it) => it && !it.image).length,
    });
  } catch (err) {
    res.status(502).json({ error: 'שגיאה בקריאת סטטוס', details: err.message });
  }
});

// ================= התראת פוש ללקוח על שינוי סטטוס - מוגן ב-API Key (נקרא רק מהניהול) =================
//
// POST /notify-order-status?api_key=...  body: { branch, orderId, status }
const CUSTOMER_STATUS_MESSAGES = {
  new: 'ההזמנה שלך התקבלה',
  preparing: 'אנחנו מכינים את ההזמנה שלך',
  ready: 'ההזמנה שלך מוכנה לאיסוף! 🎉',
  collected: 'ההזמנה נאספה - תודה שקנית אצלנו',
  cancelled: 'ההזמנה בוטלה',
};
app.post('/notify-order-status', requireApiKey, async (req, res) => {
  try {
    const { branch, orderId, status, customMessage } = req.body || {};
    if (!branch || !orderId || !VALID_BRANCHES.includes(branch)) {
      return res.status(400).json({ error: 'branch ו-orderId תקפים חובה' });
    }
    if (!status && !customMessage) {
      return res.status(400).json({ error: 'צריך status או customMessage' });
    }
    const tokensSnap = await db.ref(`customerPushTokens/${branch}/${orderId}`).once('value');
    const tokensData = tokensSnap.val() || {};
    const tokens = Object.values(tokensData).map((t) => t && t.token).filter(Boolean);

    if (!tokens.length) {
      return res.json({ ok: true, sent: 0, note: 'הלקוח לא הפעיל התראות להזמנה הזו' });
    }

    const message = {
      notification: {
        title: 'בית הבירה והיין',
        body: customMessage || CUSTOMER_STATUS_MESSAGES[status] || 'סטטוס ההזמנה שלך התעדכן',
      },
      tokens,
    };
    const result = await admin.messaging().sendEachForMulticast(message);

    const invalidTokens = [];
    result.responses.forEach((r, i) => {
      if (!r.success && r.error && ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(r.error.code)) {
        invalidTokens.push(tokens[i]);
      }
    });
    if (invalidTokens.length) {
      const cleanup = {};
      invalidTokens.forEach((t) => { cleanup[skKey(t)] = null; });
      await db.ref(`customerPushTokens/${branch}/${orderId}`).update(cleanup);
    }

    res.json({ ok: true, sent: result.successCount, failed: result.failureCount });
  } catch (err) {
    console.error('POST /notify-order-status error:', err.message);
    res.status(200).json({ ok: false, error: err.message });
  }
});

// ================= שידור הודעה שיווקית - רק למי שהסכים במפורש (marketingPushTokens) =================
//
// POST /broadcast-message?branch=shfayim&api_key=...  body: { title, body }
app.post('/broadcast-message', requireApiKey, async (req, res) => {
  try {
    const branch = req.query.branch;
    if (!validateBranch(branch, res)) return;
    const { title, body } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'title ו-body חובה' });

    const snap = await db.ref(`marketingPushTokens/${branch}`).once('value');
    const data = snap.val() || {};
    // המבנה: { phoneKey: { tokenKey: {token, consentedAt} } } - שוטחים לרשימת טוקנים
    const tokenEntries = []; // [[phoneKey, tokenKey, token], ...] - לצורך ניקוי מדויק אחר כך
    Object.entries(data).forEach(([phoneKey, tokensObj]) => {
      Object.entries(tokensObj || {}).forEach(([tokenKey, t]) => {
        if (t && t.token) tokenEntries.push([phoneKey, tokenKey, t.token]);
      });
    });

    if (!tokenEntries.length) {
      return res.json({ ok: true, sent: 0, note: 'אין לקוחות שהסכימו לקבל עדכונים' });
    }

    // FCM מגביל ל-500 טוקנים לכל קריאת sendEachForMulticast - מחלקים למנות
    const BATCH_SIZE = 500;
    let totalSent = 0;
    let totalFailed = 0;
    const invalidEntries = [];
    for (let i = 0; i < tokenEntries.length; i += BATCH_SIZE) {
      const batch = tokenEntries.slice(i, i + BATCH_SIZE);
      const tokens = batch.map((e) => e[2]);
      const result = await admin.messaging().sendEachForMulticast({ notification: { title, body }, tokens });
      totalSent += result.successCount;
      totalFailed += result.failureCount;
      result.responses.forEach((r, idx) => {
        if (!r.success && r.error && ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(r.error.code)) {
          invalidEntries.push(batch[idx]);
        }
      });
    }

    if (invalidEntries.length) {
      const cleanup = {};
      invalidEntries.forEach(([phoneKey, tokenKey]) => { cleanup[`${phoneKey}/${tokenKey}`] = null; });
      await db.ref(`marketingPushTokens/${branch}`).update(cleanup);
    }

    res.json({ ok: true, sent: totalSent, failed: totalFailed });
  } catch (err) {
    console.error('POST /broadcast-message error:', err.message);
    res.status(502).json({ error: 'שידור ההודעה נכשל', details: err.message });
  }
});

// ================= טיפול בשגיאות כלליות =================

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint לא נמצא' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'שגיאת שרת פנימית' });
});

// ---------- הפעלת השרת ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Beit HaBira API רץ על פורט ${PORT}`);
});
