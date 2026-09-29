/* Service Worker – ausschließlich für Timer-Benachrichtigungen.
 *
 * Bewusst OHNE fetch-Handler: Der Worker cacht nichts. Die App hatte schon
 * einmal das Problem, dass neues HTML auf alte JavaScript-Dateien traf und die
 * Seite leer blieb; ein cachender Worker wäre genau dieselbe Falle, nur
 * hartnäckiger. Ausgeliefert wird weiterhin allein über Netlify.
 *
 * Android erlaubt Benachrichtigungen aus einer Webseite nur über einen Service
 * Worker – der Notification-Konstruktor ist dort gesperrt. Deshalb existiert
 * diese Datei überhaupt.
 */

const geplant = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("message", event => {
  const data = event.data || {};

  if (data.type === "timer") {
    const wartezeit = data.at - Date.now();
    if (wartezeit <= 0) return zeigen(data);
    // waitUntil hält den Worker am Leben, solange das Versprechen offen ist.
    // Bei langen Zeiten kann das System ihn trotzdem beenden – dann greift die
    // Nachholprüfung in der Seite, sobald sie wieder sichtbar wird.
    event.waitUntil(new Promise(fertig => {
      const handle = setTimeout(() => { geplant.delete(data.id); zeigen(data); fertig(); }, wartezeit);
      geplant.set(data.id, () => { clearTimeout(handle); fertig(); });
    }));
  }

  if (data.type === "abbrechen") {
    geplant.get(data.id)?.();
    geplant.delete(data.id);
  }
});

function zeigen(data) {
  return self.registration.showNotification("Timer abgelaufen", {
    body: data.label,
    tag: "timer-" + data.id,
    renotify: true,
    requireInteraction: true,
    vibrate: [400, 200, 400, 200, 600],
    icon: data.icon,
    badge: data.icon,
    silent: false,
  });
}

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true })
    .then(liste => {
      const offen = liste.find(c => "focus" in c);
      return offen ? offen.focus() : self.clients.openWindow("/");
    }));
});
