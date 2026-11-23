/* 한빛 일정 알림 프로그램 (Firebase Functions, 서울 리전)
 * - coffeeNotify: 커피내기 결과가 저장되면 그 판 참가자 중 알림을 켠 사람에게만 알림
 * - pushWelcome:  기기에서 알림을 켜면(처음 등록) / 「시험 알림」을 누르면 그 기기로 알림
 * 알림 받을 기기: Firestore settings/push_… 문서 {kind:'push', token, name, dev, coffee}
 */
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
const REGION = 'asia-northeast3';
const GAME = { ladder: '사다리타기', roulette: '돌림판', snail: '달팽이 경주', marble: '구슬 떨어뜨리기', draw: '제비뽑기' };
const DEAD = /registration-token-not-registered|invalid-registration-token|invalid-argument/;

async function sendTo(list, data) {
  /* list: [{id, token}] · data 값은 모두 글자 */
  if (!list.length) return 0;
  const res = await admin.messaging().sendEachForMulticast({
    tokens: list.map(x => x.token),
    data,
    webpush: { headers: { Urgency: 'high', TTL: '3600' } }
  });
  await Promise.all(res.responses.map((r, i) => {
    const code = (r.error && r.error.code) || '';
    if (!r.success && DEAD.test(code)) return db.doc('settings/' + list[i].id).delete().catch(() => {});
    if (!r.success) functions.logger.warn('send fail', list[i].id, code);
    return null;
  }));
  return res.successCount;
}

exports.coffeeNotify = functions.region(REGION).firestore.document('settings/coffee').onWrite(async ch => {
  const before = (ch.before.exists && ch.before.data().log) || [];
  const after = (ch.after.exists && ch.after.data().log) || [];
  const old = new Set(before.map(r => r && r.at));
  const fresh = after.filter(r => r && !old.has(r.at) && Date.now() - r.at < 15 * 60 * 1000);
  if (!fresh.length) return;
  const snap = await db.collection('settings').where('kind', '==', 'push').get();
  for (const r of fresh) {
    const names = new Set(r.names || []);
    const list = [];
    snap.forEach(d => { const t = d.data(); if (t.token && t.coffee !== false && t.name && names.has(t.name)) list.push({ id: d.id, token: t.token }); });
    const who = (r.losers || []).join(', ');
    const n = await sendTo(list, {
      title: '☕ 커피내기 결과가 나왔어요!',
      body: `${who} 님이 커피를 사요 🎉 · ${GAME[r.game] || '커피내기'} ${(r.names || []).length}명 중 ${r.k}명${r.by ? ' · ' + r.by + ' 진행' : ''}`,
      url: `./#v=coffee&cf=${r.at}`,
      tag: 'coffee-' + r.at
    });
    functions.logger.info('coffee', r.at, 'targets', list.length, 'sent', n);
  }
});

exports.pushWelcome = functions.region(REGION).firestore.document('settings/{id}').onWrite(async (ch, ctx) => {
  if (!String(ctx.params.id).startsWith('push_') || !ch.after.exists) return;
  const a = ch.after.data(), b = ch.before.exists ? ch.before.data() : null;
  if (!a.token) return;
  const isNew = !b || b.token !== a.token;
  const isTest = a.testAt && (!b || b.testAt !== a.testAt);
  if (!isNew && !isTest) return;
  await sendTo([{ id: ctx.params.id, token: a.token }], {
    title: isTest ? '🔔 시험 알림이에요' : '🔔 알림이 켜졌어요',
    body: `${a.name ? a.name + ' 님, ' : ''}이 기기(${a.dev || '기기'})로 한빛 일정 알림이 와요.`,
    url: './#v=menu',
    tag: 'welcome'
  });
});
