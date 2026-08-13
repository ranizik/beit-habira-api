# Beit HaBira - Integration API

שכבת API שמחברת בין אפליקציית ההזמנות (Firebase) לבין מנוע הקופות.

## Endpoints

- `GET /health` — בדיקת תקינות (ללא אימות)
- `GET /products?branch=telmond` — כל המוצרים עם ברקוד, מחיר, מלאי
- `PUT /products/:barcode/price` — עדכון מחיר למוצר בודד
- `POST /products/prices/bulk` — עדכון מחירים מרובה
- `GET /orders?branch=shfayim&format=maneo` — הזמנות (אופציונלי בפורמט ייצוא למנוע)

כל בקשה (מלבד `/health`) דורשת header:
```
x-api-key: <API_KEY>
```

## Environment Variables (מוגדרים ב-Render)

| Key | תיאור |
|---|---|
| `FIREBASE_KEY` | תוכן קובץ ה-Service Account JSON כמחרוזת אחת |
| `FIREBASE_DB_URL` | כתובת ה-Realtime Database |
| `API_KEY` | מפתח סודי לאימות בקשות |

## הרצה מקומית

```bash
npm install
npm start
```
