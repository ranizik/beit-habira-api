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

// אימות API Key
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

// ================= יצירת הזמנה =================
function isPromoActiveServer(promo) {
  if (!promo || !promo.type) return false;
  const now = Date.now();
  if (promo.from && new Date(promo.from).getTime() > now) return false;
  if (promo.to && new Date(promo.to).getTime() < now) return false;
  return true;
}

app.post('/create-order', express.json(), async (req, res) => {
  try {
    const { branch, items, pickupDay, pickupSlot, customerName, customerPhone, marketingConsent, payNow } = req.body || {};
    if (!branch || !VALID_BRANCHES.includes(branch)) return res.status(400).json({ error: 'branch לא תקף' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items חובה' });
    if (!pickupSlot) return res.status(400).json({ error: 'pickupSlot חובה' });
    if (!customerName || !String(customerName).trim()) return res.status(400).json({ error: 'customerName חובה' });
    const phoneDigits = String(customerPhone || '').replace(/\D/g, '');
    if (phoneDigits.length < 9) return res.status(400).json({ error: 'customerPhone לא תקין' });

    const retailSnap = await db.ref(`retail/${branch}`).once('value');
    const retailData = retailSnap.val() || {};

    const memberSnap = await db.ref(`clubMembers/${skKey(phoneDigits)}`).once('value');
    const memberData = memberSnap.val();
    const isClubMember = !!(memberData && memberData.active !== false);

    const orderItems = [];
    for (const reqItem of items) {
      const barcode = reqItem && reqItem.barcode;
      const qty = parseInt(reqItem && reqItem.qty, 10);
      if (!barcode || !qty || qty <= 0) continue;
      const product = retailData[barcode];
      if (!product || !(product.price > 0) || product.inStock === false) {
        return res.status(409).json({ error: `המוצר "${product ? product.name : barcode}" כבר לא זמין`, unavailableBarcode: barcode, unavailableName: product ? product.name : barcode });
      }
      const regularPrice = product.price || 0;
      let priceAfterPromo = regularPrice;
      if (isPromoActiveServer(product.promo)) {
        if (product.promo.type === 'pct') priceAfterPromo = priceAfterPromo * (1 - (product.promo.val || 0) / 100);
        else if (product.promo.type === 'fixed') priceAfterPromo = product.promo.val || priceAfterPromo;
      }
      const clubPrice = product.clubPrice > 0 ? product.clubPrice : null;
      const useClubPrice = !!(isClubMember && clubPrice && clubPrice < priceAfterPromo);
      const appliedPrice = useClubPrice ? clubPrice : priceAfterPromo;

      let lineTotal;
      if (product.promo && product.promo.type === 'bundle' && isPromoActiveServer(product.promo) && product.promo.qty > 0) {
        const groups = Math.floor(qty / product.promo.qty);
        const remainder = qty % product.promo.qty;
        lineTotal = groups * product.promo.val + remainder * regularPrice;
      } else {
        lineTotal = appliedPrice * qty;
      }

      orderItems.push({
        barcode, name: product.name, qty,
        unitPrice: appliedPrice,
        lineTotal,
        regularPrice, clubPrice: clubPrice || null,
        appliedPrice, isClubPrice: useClubPrice,
      });
    }
    if (!orderItems.length) return res.status(400).json({ error: 'אין פריטים תקפים בהזמנה' });

    const totalItems = orderItems.reduce((s, it) => s + it.qty, 0);
    const totalAmount = orderItems.reduce((s, it) => s + it.lineTotal, 0);

    const order = {
      branch, items: orderItems, totalItems, totalAmount,
      pickupDay, pickupSlot,
      customerName: String(customerName).trim(), customerPhone: phoneDigits,
      status: 'new', paymentStatus: payNow ? 'pending' : 'pay_at_pickup',
      createdAt: Date.now(), createdAtISO: new Date().toISOString(),
      marketingConsent: !!marketingConsent,
    };
    if (isClubMember) order.clubMemberPhone = phoneDigits;

    const ref = await db.ref(`pickupOrders/${branch}`).push(order);
    res.json({ ok: true, orderId: ref.key, order });
  } catch (err) {
    console.error('POST /create-order error:', err.message);
    res.status(500).json({ error: 'יצירת ההזמנה נכשלה, נסה שוב', details: err.message });
  }
});

// ================= התראת פוש על הזמנה חדשה - חוזר מיד, עדכון profile ברקע =================
app.post('/notify-new-order', express.json(), async (req, res) => {
  try {
    const { branch, orderId } = req.body || {};
    if (!branch || !orderId || !VALID_BRANCHES.includes(branch)) {
      return res.status(400).json({ error: 'branch ו-orderId תקפים חובה' });
    }
    
    const orderSnap = await db.ref(`pickupOrders/${branch}/${orderId}`).once('value');
    const order = orderSnap.val();
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });

    const tokensSnap = await db.ref(`adminPushTokens/${branch}`).once('value');
    const tokensData = tokensSnap.val() || {};
    const entries = Object.entries(tokensData).filter(([k, t]) => t && t.token);
    const tokens = entries.map(([k, t]) => t.token);

    if (!tokens.length) {
      return res.json({ ok: true, sent: 0, note: 'אין מכשירי admin רשומים להתראות בסניף הזה' });
    }

    const message = {
      notification: {
        title: 'הזמנה חדשה 🔔',
        body: `${order.customerName || 'לקוח'} · ₪${(order.totalAmount || 0).toFixed(2)} · ${(order.items || []).length} פריטים`,
      },
      data: { orderId: String(orderId), branch: String(branch), type: 'new-order' },
      tokens,
    };
    const result = await admin.messaging().sendEachForMulticast(message);

    const invalidKeys = [];
    result.responses.forEach((r, i) => {
      if (!r.success && r.error && ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(r.error.code)) {
        invalidKeys.push(entries[i][0]);
      }
    });
    if (invalidKeys.length) {
      const cleanup = {};
      invalidKeys.forEach((k) => { cleanup[k] = null; });
      await db.ref(`adminPushTokens/${branch}`).update(cleanup);
    }

    // ⭐⭐⭐ החזר מיד - אל תחכה לעדכון profile! ⭐⭐⭐
    res.json({ ok: true, sent: result.successCount, failed: result.failureCount });

    // ⭐⭐⭐ עדכון profile ברקע - לא מחכים עליו! ⭐⭐⭐
    (async () => {
      try {
        const phoneKey = skKey(order.customerPhone || '');
        if (phoneKey) {
          const updates = {
            name: order.customerName || '',
            phone: order.customerPhone || '',
            lastOrderAt: Date.now(),
            totalOrders: admin.database.ServerValue.increment(1),
            totalSpent: admin.database.ServerValue.increment(order.totalAmount || 0),
          };
          await db.ref(`customerProfiles/${branch}/${phoneKey}`).update(updates);
        }
      } catch (profileErr) {
        console.error('עדכון כרטיס לקוח נכשל (ההזמנה עצמה תקינה):', profileErr.message);
      }
    })();

  } catch (err) {
    console.error('POST /notify-new-order error:', err.message);
    res.status(200).json({ ok: false, error: err.message });
  }
});

// ================= עזר =================
function skKey(name) {
  return String(name).replace(/[.#$[\]/]/g, '_');
}

// ================= טיפול בשגיאות =================
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint לא נמצא' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'שגיאת שרת פנימית' });
});

// ---------- הפעלה ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Beit HaBira API רץ על פורט ${PORT}`);
});
