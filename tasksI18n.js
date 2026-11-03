/**
 * תרגום התראות לשפת המשתמש (en/ar/ru/fr/es). עברית = ברירת מחדל.
 *   שפת המשתמש נשמרת ב-todoPrefs/<uid>/lang (נקבעת מהאפליקציה דרך /tasks/prefs).
 *   תוכן של משתמשים (שם משימה, שם רשימה, שם אדם) עטוף ב-U() ולא מתורגם.
 *   שאר הטקסט מתורגם לפי ביטויים קבועים (הארוך קודם).
 */
const LANGS = ['he', 'en', 'ar', 'ru', 'fr', 'es'];
const MARK = '⁣';
const U = (s) => MARK + String(s == null ? '' : s).replace(new RegExp(MARK, 'g'), '') + MARK;
// [עברית, en, ar, ru, fr, es]
const P = [
  [' ניסה/תה להצטרף, אבל הגעת ל-', ' tried to join, but you reached ', ' حاول/ت الانضمام، لكنك وصلت إلى ', ' пытается присоединиться, но достигнут лимит: ', ' a essayé de rejoindre, mais vous avez atteint ', ' intentó unirse, pero llegaste a '],
  [' משתתפים. אפשר להוסיף מקומות – פנה/י לרני', ' participants. To add places – contact Rani', ' مشاركين. لإضافة أماكن – تواصل مع راني', ' участников. Чтобы добавить места — напишите Рани', ' participants. Pour ajouter des places – contactez Rani', ' participantes. Para añadir plazas – contacta con Rani'],
  [' צירף/ה אותך. אפשר לצאת מהרשימה בכל רגע.', ' added you. You can leave the list at any time.', ' أضافك. يمكنك مغادرة القائمة في أي وقت.', ' добавил(а) вас. Вы можете выйти из списка в любой момент.', ' vous a ajouté. Vous pouvez quitter la liste à tout moment.', ' te añadió. Puedes salir de la lista cuando quieras.'],
  [' צירף/ה אותך. רשימות הארגון יופיעו אצלך.', ' added you. The organization\'s lists will appear for you.', ' أضافك. ستظهر لديك قوائم المؤسسة.', ' добавил(а) вас. Списки организации появятся у вас.', ' vous a ajouté. Les listes de l\'organisation apparaîtront chez vous.', ' te añadió. Las listas de la organización aparecerán para ti.'],
  [' עזב/ה את הארגון. משימות פתוחות שבאחריותו/ה עברו אליך.', ' left the organization. Their open tasks moved to you.', ' غادر/ت المؤسسة. انتقلت إليك مهامه المفتوحة.', ' покинул(а) организацию. Открытые задачи перешли к вам.', ' a quitté l\'organisation. Ses tâches ouvertes vous ont été transférées.', ' salió de la organización. Sus tareas abiertas pasaron a ti.'],
  ['הוסרת מהארגון. המשימות הפרטיות שלך נשארות אצלך.', 'You were removed from the organization. Your private tasks stay with you.', 'تمت إزالتك من المؤسسة. تبقى مهامك الخاصة لديك.', 'Вас удалили из организации. Личные задачи остаются у вас.', 'Vous avez été retiré de l\'organisation. Vos tâches privées restent chez vous.', 'Te quitaron de la organización. Tus tareas privadas siguen contigo.'],
  ['אפשר להתחיל – לחץ על המיקרופון ותגיד משימה', 'You can start – tap the microphone and say a task', 'يمكنك البدء – اضغط على الميكروفون وقل مهمة', 'Можно начинать — нажмите на микрофон и скажите задачу', 'Vous pouvez commencer – appuyez sur le micro et dites une tâche', 'Ya puedes empezar – pulsa el micrófono y di una tarea'],
  ['אפשר לצרף עובדים וליצור רשימות – 🏢 בכותרת', 'You can add employees and create lists – 🏢 at the top', 'يمكنك إضافة موظفين وإنشاء قوائم – 🏢 في الأعلى', 'Можно добавлять сотрудников и создавать списки — 🏢 вверху', 'Vous pouvez ajouter des employés et créer des listes – 🏢 en haut', 'Puedes añadir empleados y crear listas – 🏢 arriba'],
  ['תקופת הניסיון בתכל׳ס נגמרת מחר', 'Your Tachles trial ends tomorrow', 'تنتهي الفترة التجريبية في Tachles غدًا', 'Пробный период Tachles заканчивается завтра', 'Votre essai Tachles se termine demain', 'Tu prueba de Tachles termina mañana'],
  ['המנוי שלך בתכל׳ס נגמר מחר', 'Your Tachles subscription ends tomorrow', 'ينتهي اشتراكك في Tachles غدًا', 'Ваша подписка Tachles заканчивается завтра', 'Votre abonnement Tachles se termine demain', 'Tu suscripción de Tachles termina mañana'],
  ['כדי להמשיך להשתמש – פנה/י לרני', 'To keep using it – contact Rani', 'لمواصلة الاستخدام – تواصل مع راني', 'Чтобы продолжить — напишите Рани', 'Pour continuer – contactez Rani', 'Para seguir usándola – contacta con Rani'],
  ['אפשר להמשיך להשתמש באפליקציה', 'You can keep using the app', 'يمكنك مواصلة استخدام التطبيق', 'Можно продолжать пользоваться приложением', 'Vous pouvez continuer à utiliser l\'application', 'Puedes seguir usando la app'],
  ['✅ אושרת! ברוך הבא לתכל׳ס', '✅ You\'re approved! Welcome to Tachles', '✅ تمت الموافقة! مرحبًا بك في Tachles', '✅ Вас одобрили! Добро пожаловать в Tachles', '✅ Vous êtes approuvé ! Bienvenue sur Tachles', '✅ ¡Aprobado! Bienvenido a Tachles'],
  ['✅ תכל׳ס נפתחה', '✅ Tachles is open again', '✅ تم فتح Tachles', '✅ Tachles снова доступен', '✅ Tachles est de nouveau ouvert', '✅ Tachles está abierta de nuevo'],
  ['). סמן ✅ בוצע כדי להפסיק', '). Tap ✅ Done to stop', '). اضغط ✅ تم للإيقاف', '). Нажмите ✅ Выполнено, чтобы остановить', '). Appuyez sur ✅ Fait pour arrêter', '). Pulsa ✅ Hecha para parar'],
  ['הבקשה לארגון לא אושרה', 'The organization request was not approved', 'لم تتم الموافقة على طلب المؤسسة', 'Запрос на организацию не одобрен', 'La demande d\'organisation n\'a pas été approuvée', 'La solicitud de organización no fue aprobada'],
  [' מבקש/ת להצטרף. לאשר? ☰ ← לעסקים', ' asks to join. Approve? ☰ → Business', ' يطلب/تطلب الانضمام. موافقة؟ ☰ ← للأعمال', ' просит вступить. Одобрить? ☰ → Бизнес', ' demande à rejoindre. Approuver ? ☰ → Entreprise', ' pide unirse. ¿Aprobar? ☰ → Empresas'],
  ['הבקשה להצטרף לארגון לא אושרה', 'Your request to join the organization was declined', 'لم تتم الموافقة على طلب الانضمام إلى المؤسسة', 'Запрос на вступление в организацию отклонён', 'Votre demande pour rejoindre l\'organisation a été refusée', 'Tu solicitud para unirte a la organización fue rechazada'],
  [' הצטרף/ה לארגון בקישור', ' joined the organization via link', ' انضم/ت إلى المؤسسة عبر رابط', ' вступил(а) в организацию по ссылке', ' a rejoint l\'organisation par lien', ' se unió a la organización por enlace'],
  [' צירף/ה אותך לרשימה', ' added you to the list', ' أضافك إلى القائمة', ' добавил(а) вас в список', ' vous a ajouté à la liste', ' te añadió a la lista'],
  [' – צורפת לרשימה', ' – you were added to a list', ' – تمت إضافتك إلى قائمة', ' — вас добавили в список', ' – vous avez été ajouté à une liste', ' – te añadieron a una lista'],
  ['לפרטים – פנה לרני', 'For details – contact Rani', 'للتفاصيل – تواصل مع راني', 'Подробности — у Рани', 'Pour en savoir plus – contactez Rani', 'Para más detalles – contacta con Rani'],
  [' – הרשימה מלאה', ' – the list is full', ' – القائمة ممتلئة', ' — список заполнен', ' – la liste est pleine', ' – la lista está llena'],
  [' הצטרף/ה לרשימה', ' joined the list', ' انضم/ت إلى القائمة', ' присоединился(-ась) к списку', ' a rejoint la liste', ' se unió a la lista'],
  [' יצא/ה מהרשימה', ' left the list', ' غادر/ت القائمة', ' вышел(-ла) из списка', ' a quitté la liste', ' salió de la lista'],
  ['צורפת לרשימה "', 'You were added to the list "', 'تمت إضافتك إلى القائمة "', 'Вас добавили в список «', 'Vous avez été ajouté à la liste "', 'Te añadieron a la lista "'],
  ['צורפת לארגון "', 'You were added to the organization "', 'تمت إضافتك إلى المؤسسة "', 'Вас добавили в организацию «', 'Vous avez été ajouté à l\'organisation "', 'Te añadieron a la organización "'],
  ['הארגון "', 'The organization "', 'المؤسسة "', 'Организация «', 'L\'organisation "', 'La organización "'],
  ['" אושר', '" was approved', '" تمت الموافقة عليها', '» одобрена', '" a été approuvée', '" fue aprobada'],
  ['תזכורת למחר: ', 'Reminder for tomorrow: ', 'تذكير لغد: ', 'Напоминание на завтра: ', 'Rappel pour demain : ', 'Recordatorio para mañana: '],
  ['עדיין לא בוצע: ', 'Not done yet: ', 'لم تُنجز بعد: ', 'Ещё не выполнено: ', 'Pas encore fait : ', 'Aún no hecha: '],
  ['רשימה חדשה: ', 'New list: ', 'قائمة جديدة: ', 'Новый список: ', 'Nouvelle liste : ', 'Nueva lista: '],
  ['הגיע הזמן: ', 'Time\'s up: ', 'حان الوقت: ', 'Пора: ', 'C\'est l\'heure : ', 'Es la hora: '],
  [' (באיחור: ', ' (late: ', ' (متأخرة: ', ' (опоздание: ', ' (en retard : ', ' (retraso: '],
  [' – באחריותך', ' – assigned to you', ' – بمسؤوليتك', ' — на вас', ' – à votre charge', ' – a tu cargo'],
  [' הוסיף/ה: ', ' added: ', ' أضاف/ت: ', ' добавил(а): ', ' a ajouté : ', ' añadió: '],
  [' (באחריות ', ' (assigned to ', ' (بمسؤولية ', ' (ответственный: ', ' (à la charge de ', ' (a cargo de '],
  ['רשימה משותפת', 'Shared list', 'قائمة مشتركة', 'Общий список', 'Liste partagée', 'Lista compartida'],
  ['עכשיו - ', 'Now - ', 'الآن - ', 'Сейчас - ', 'Maintenant - ', 'Ahora - '],
  ['נקבע ל-', 'Scheduled for ', 'مقررة في ', 'Назначено на ', 'Prévu à ', 'Programada a las '],
  ['שעתיים', '2 hours', 'ساعتين', '2 часа', '2 heures', '2 horas'],
  [' שעות', ' hours', ' ساعات', ' ч', ' heures', ' horas'],
  [' ימים', ' days', ' أيام', ' дн.', ' jours', ' días'],
  [' בשעה ', ' at ', ' الساعة ', ' в ', ' à ', ' a las '],
  ['בשעה ', 'at ', 'الساعة ', 'в ', 'à ', 'a las '],
  ['היום ', 'Today ', 'اليوم ', 'Сегодня ', 'Aujourd\'hui ', 'Hoy '],
  ['בעוד ', 'In ', 'بعد ', 'Через ', 'Dans ', 'En '],
  [' דק׳', ' min', ' د', ' мин', ' min', ' min'],
  [' שע׳', ' h', ' س', ' ч', ' h', ' h'],
  ['רשימה', 'List', 'قائمة', 'Список', 'Liste', 'Lista'],
  ['מנהל', 'Manager', 'المدير', 'Менеджер', 'Le responsable', 'El gerente'],
  ['שעה', '1 hour', 'ساعة', '1 час', '1 heure', '1 hora'],
  ['מחר', 'Tomorrow', 'غدًا', 'Завтра', 'Demain', 'Mañana'],
].sort((a, b) => b[0].length - a[0].length);
const ACT = { // כפתורי ההתראה (נשלחים ל-Service Worker)
  he: ['✅ בוצע', '⏰ עוד 30 דק׳', '✅ סומן כבוצע', '⏰ אזכיר שוב בעוד 30 דקות'],
  en: ['✅ Done', '⏰ 30 more min', '✅ Marked as done', '⏰ I\'ll remind you again in 30 minutes'],
  ar: ['✅ تم', '⏰ 30 د أخرى', '✅ تم وضع علامة تم', '⏰ سأذكّرك بعد 30 دقيقة'],
  ru: ['✅ Выполнено', '⏰ Ещё 30 мин', '✅ Отмечено как выполненное', '⏰ Напомню через 30 минут'],
  fr: ['✅ Fait', '⏰ Encore 30 min', '✅ Marquée comme faite', '⏰ Je vous le rappelle dans 30 minutes'],
  es: ['✅ Hecha', '⏰ 30 min más', '✅ Marcada como hecha', '⏰ Te lo recuerdo en 30 minutos'],
};

function tr(lang, str) {
  const s = String(str == null ? '' : str);
  const li = LANGS.indexOf(lang);
  if (li <= 0) return s.split(MARK).join('');
  return s.split(MARK).map((part, i) => {
    if (i % 2 === 1) return part; // תוכן משתמש
    let out = part;
    for (const row of P) if (out.includes(row[0])) out = out.split(row[0]).join(row[li]);
    return out;
  }).join('');
}

module.exports = { LANGS, U, tr, ACT, MARK };
