# תכל׳ס (אפליקציית המשימות) – מודולי השרת בריפו הזה

הקבצים `taskReminders.js`, `tasksGcal.js`, `tasksStats.js`, `tasksAccess.js`, `tasksHealth.js`, `tasksBackup.js` (גיבוי לילי ב-03:00 ל-todoBackup, 30 יום) שייכים לאפליקציית המשימות **תכל׳ס** (beit-habira.com/tasks).

📘 המסמך הטכני המלא (ארכיטקטורה, נתונים, נתיבים, העלאה, בדיקות, תקלות):
https://github.com/ranizik/beit-habira-push/blob/main/TECHNICAL.md

- נרשמים ב-`server.js` לפני `app.use(requireApiKey)`, ומאומתים ב-Firebase ID token.
- בדיקת בריאות: `GET /tasks/health`.
- בדיקות אוטומטיות: `npm test` (`tests/tasks-server.test.js`, Firebase/FCM/Google מדומים). רצות ב-GitHub Actions בכל push, ו-Render מעלה לאוויר רק אחרי שהן עוברות (Auto-Deploy: After CI Checks Pass). **כל באג שמתקנים – להוסיף לו בדיקה.**

© 2026 רני איציק. כל הזכויות שמורות.
