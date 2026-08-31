// Unified Service Worker: handles BOTH basic PWA caching AND Firebase Cloud Messaging (push notifications).
// Merged into one file on purpose - two separate service workers competing for the same scope
// causes one of them to get stuck "waiting" and never activate (this was the actual bug).
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyA1Pq3qi361K9xDwv6v4Q44d_nLgpZBtRs",
  authDomain: "orders-app-78c0f.firebaseapp.com",
  databaseURL: "https://orders-app-78c0f-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "orders-app-78c0f",
  storageBucket: "orders-app-78c0f.firebasestorage.app",
  messagingSenderId: "1057881600020",
  appId: "1:1057881600020:web:2deed7103137123f6d7701",
  measurementId: "G-K6WQE3FCS6"
});

const messaging = firebase.messaging();

// Shows the notification when the message arrives in the background (app closed / not focused)
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'Beit HaBira VeHaYayin';
  const body = (payload.notification && payload.notification.body) || 'New order received';
  self.registration.showNotification(title, {
    body,
    icon: '/retail/icon-192.png',
    dir: 'rtl',
  });
});

// Basic PWA caching (previously in the separate sw.js) - network-first, since prices/promos must stay live
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => self.clients.claim());
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
