/**
 * Beit HaBira - Integration API
 * שכבת חיבור בין אפליקציית ההזמנות (Firebase) לבין מנוע הקופות
 *
 * Environment Variables נדרשים:
 *   FIREBASE_KEY     - תוכן קובץ ה-Service Account JSON (כמחרוזת אחת)
 *   FIREBASE_DB_URL  - כתובת ה-Realtime Database
 *   API_KEY          - מפתח סודי לאימות בקשות ל-API הזה
 */

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

// ---------- בדיקת משתני סביבה ----------
const REQUIRED_ENV = ['FIREBASE_KEY', 'FIREBASE_DB_URL', 'API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('❌ חסרים משתני סביבה:', missing.join(', '));
  process.exit(1);
}

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
  windowMs: 60 * 1000, // דקה
  max: 120, // עד 120 בקשות בדקה
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. נסה שוב בעוד רגע.' },
});
app.use(limiter);

// אימות API Key - חובה לכל בקשה (מלבד health check)
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

// ================= מוצרים =================

// GET /products - כל המוצרים (ברקוד, שם, מחיר, מחיר קרטון, מלאי, קטגוריה, ספק)
app.get('/products', async (req, res) => {
  try {
    const branch = req.query.branch; // אופציונלי: telmond / shfayim
    const data = await readRef(branch ? `suppliers/${branch}` : 'suppliers');
    if (!data) return res.json({ products: [] });

    const products = [];
    Object.entries(data).forEach(([supplierId, supplier]) => {
      const items = supplier.items || supplier.products || {};
      Object.entries(items).forEach(([itemId, item]) => {
        products.push({
          id: itemId,
          barcode: item.barcode || null,
          name: item.name || '',
          supplier: supplier.name || supplierId,
          unitPrice: item.price ?? null,
          cartonPrice: item.cartonPrice ?? null,
          cartonQty: item.cartonQty ?? null,
          stock: item.stock ?? null,
          category: item.category || null,
        });
      });
    });

    res.json({ count: products.length, products });
  } catch (err) {
    console.error('GET /products error:', err.message);
    res.status(502).json({ error: 'שגיאה בקריאת מוצרים', details: err.message });
  }
});

// PUT /products/:barcode/price - עדכון מחיר למוצר בודד לפי ברקוד
app.put('/products/:barcode/price', async (req, res) => {
  try {
    const { barcode } = req.params;
    const { price, branch } = req.body;

    if (price === undefined || isNaN(price)) {
      return res.status(400).json({ error: 'שדה price חסר או לא תקין' });
    }
    if (!barcode) {
      return res.status(400).json({ error: 'ברקוד חסר' });
    }

    const data = await readRef(branch ? `suppliers/${branch}` : 'suppliers');
    if (!data) return res.status(404).json({ error: 'לא נמצאו ספקים' });

    let found = false;
    const updates = {};

    Object.entries(data).forEach(([supplierId, supplier]) => {
      const items = supplier.items || supplier.products || {};
      Object.entries(items).forEach(([itemId, item]) => {
        if (item.barcode === barcode) {
          found = true;
          const base = branch ? `suppliers/${branch}` : 'suppliers';
          const itemsKey = supplier.items ? 'items' : 'products';
          updates[`${base}/${supplierId}/${itemsKey}/${itemId}/price`] = price;
        }
      });
    });

    if (!found) return res.status(404).json({ error: `מוצר עם ברקוד ${barcode} לא נמצא` });

    await db.ref().update(updates);
    res.json({ success: true, barcode, price });
  } catch (err) {
    console.error('PUT /products/:barcode/price error:', err.message);
    res.status(502).json({ error: 'שגיאה בעדכון מחיר', details: err.message });
  }
});

// POST /products/prices/bulk - עדכון מחירים מרובה
// body: { branch: "telmond", prices: [{ barcode, price }, ...] }
app.post('/products/prices/bulk', async (req, res) => {
  try {
    const { branch, prices } = req.body;
    if (!Array.isArray(prices) || prices.length === 0) {
      return res.status(400).json({ error: 'שדה prices חייב להיות מערך לא ריק' });
    }

    const data = await readRef(branch ? `suppliers/${branch}` : 'suppliers');
    if (!data) return res.status(404).json({ error: 'לא נמצאו ספקים' });

    const priceMap = new Map(prices.map((p) => [String(p.barcode), p.price]));
    const updates = {};
    const updatedBarcodes = [];

    Object.entries(data).forEach(([supplierId, supplier]) => {
      const itemsKey = supplier.items ? 'items' : 'products';
      const items = supplier[itemsKey] || {};
      Object.entries(items).forEach(([itemId, item]) => {
        if (item.barcode && priceMap.has(String(item.barcode))) {
          const base = branch ? `suppliers/${branch}` : 'suppliers';
          updates[`${base}/${supplierId}/${itemsKey}/${itemId}/price`] = priceMap.get(String(item.barcode));
          updatedBarcodes.push(item.barcode);
        }
      });
    });

    if (updatedBarcodes.length === 0) {
      return res.status(404).json({ error: 'אף אחד מהברקודים לא נמצא' });
    }

    await db.ref().update(updates);
    res.json({ success: true, updatedCount: updatedBarcodes.length, updatedBarcodes });
  } catch (err) {
    console.error('POST /products/prices/bulk error:', err.message);
    res.status(502).json({ error: 'שגיאה בעדכון מחירים מרובה', details: err.message });
  }
});

// ================= הזמנות =================

// GET /orders?format=maneo&branch=shfayim&from=...&to=...
app.get('/orders', async (req, res) => {
  try {
    const { branch, format, from, to } = req.query;
    if (!branch) return res.status(400).json({ error: 'פרמטר branch חובה' });

    const data = await readRef(`history/${branch}`);
    if (!data) return res.json({ orders: [] });

    let orders = Object.entries(data).map(([timestamp, order]) => ({
      timestamp: Number(timestamp),
      date: order.date || null,
      supplier: order.supplier || order.supplierName || null,
      items: order.items || [],
    }));

    if (from) orders = orders.filter((o) => o.timestamp >= Number(from));
    if (to) orders = orders.filter((o) => o.timestamp <= Number(to));

    if (format === 'maneo') {
      // פורמט ייצוא בסיסי לטעינה למנוע: ברקוד, כמות, מחיר יחידה, הנחה
      const rows = [];
      orders.forEach((order) => {
        (order.items || []).forEach((item) => {
          rows.push({
            barcode: item.barcode || '',
            quantity: item.qty ?? item.c ?? item.u ?? 0,
            unitPrice: item.price ?? 0,
            discount: item.discount ?? 0,
          });
        });
      });
      return res.json({ format: 'maneo', count: rows.length, rows });
    }

    res.json({ count: orders.length, orders });
  } catch (err) {
    console.error('GET /orders error:', err.message);
    res.status(502).json({ error: 'שגיאה בקריאת הזמנות', details: err.message });
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
