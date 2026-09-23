/* 晤 · With You 的 Service Worker —— 只干一件事：接住推送，弹出来。
   必须放在网站根目录，作用域才覆盖整个 app。 */
self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let d = { title: "晤", body: "他想起你了。", url: "/" };
  try { if (event.data) d = { ...d, ...event.data.json() }; }
  catch { if (event.data) d.body = event.data.text(); }
  event.waitUntil(self.registration.showNotification(d.title || "晤", {
    body: d.body || "",
    icon: "/icon-180.png",
    badge: "/icon-180.png",
    /* 同一个 tag 会把上一条顶掉 —— 他连着说几句的时候不刷屏 */
    tag: "wu-message",
    renotify: true,
    data: { url: d.url || "/" },
  }));
});

/* 点通知：已经开着就把那个窗口拉到前面，没开着才新开 */
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if (c.url.includes(self.registration.scope) && "focus" in c) {
        if ("navigate" in c && url !== "/") await c.navigate(url).catch(() => {});
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
