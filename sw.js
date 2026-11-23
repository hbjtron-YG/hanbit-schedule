/* 한빛 일정 알림 서비스 워커: Firebase 클라우드 메시징(웹 푸시)의 data 메시지를 받아 알림으로 보여 줌 */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{
  let p={};try{p=e.data?e.data.json():{}}catch(err){try{p={data:{body:e.data.text()}}}catch(e2){}}
  const d=p.data||p.notification||p||{};
  const title=d.title||'한빛 일정';
  const opt={body:d.body||'',icon:'icons/icon-192.png',badge:'icons/favicon-48.png',tag:d.tag||'hanbit',renotify:true,data:{url:d.url||'./'},lang:'ko'};
  e.waitUntil(self.registration.showNotification(title,opt));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=new URL((e.notification.data&&e.notification.data.url)||'./',self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    const c=list.find(w=>w.url.startsWith(self.registration.scope));
    if(c){c.postMessage({type:'open',url});return c.focus()}
    return self.clients.openWindow(url);
  }));
});
