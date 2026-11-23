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
/* 실행 계정: 배포 때 GitHub Actions가 열쇠 파일의 계정(client_email)을 FN_SA로 넘겨줌 (기본 Compute 계정이 없는 프로젝트라서) */
const fn = () => { const f = functions.region(REGION); return process.env.FN_SA ? f.runWith({ serviceAccount: process.env.FN_SA }) : f; };
const GAME = { ladder: '사다리타기', roulette: '돌림판', snail: '달팽이 경주', marble: '구슬 떨어뜨리기', draw: '제비뽑기' };
/* 시험 기간: 커피내기 결과 알림은 이 계정(로그인 이름)의 기기에만. '' 이면 원래대로 참가자에게 */
const CF_NOTIFY_ONLY = '';
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

exports.coffeeNotify = fn().firestore.document('settings/coffee').onWrite(async ch => {
  const before = (ch.before.exists && ch.before.data().log) || [];
  const after = (ch.after.exists && ch.after.data().log) || [];
  const old = new Set(before.map(r => r && r.at));
  const fresh = after.filter(r => r && !old.has(r.at) && Date.now() - r.at < 15 * 60 * 1000);
  if (!fresh.length) return;
  const snap = await db.collection('settings').where('kind', '==', 'push').get();
  for (const r of fresh) {
    const names = new Set(r.names || []);
    const list = [];
    snap.forEach(d => { const t = d.data(); if (!t.token || t.coffee === false) return;
      if (CF_NOTIFY_ONLY ? t.acct === CF_NOTIFY_ONLY : (t.name && names.has(t.name))) list.push({ id: d.id, token: t.token }); });
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

exports.pushWelcome = fn().firestore.document('settings/{id}').onWrite(async (ch, ctx) => {
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

/* ---------- 직원 계정 (로그인 준비) ----------
 * accounts: 앱에서 부르는 함수 하나. action 으로 구분.
 *  status  : 계정이 하나라도 있는지 (처음 관리자 만들기 화면용)
 *  setup   : 계정이 하나도 없을 때만 첫 관리자 만들기
 *  list / create / resetPw / setActive / setAdmin / rename / remove : 관리자만
 *  pwChanged : 본인이 비밀번호를 바꿨다고 표시
 * 계정 정보는 Firestore accounts/<uid> (앱의 임시 규칙으로는 못 읽는 곳), 비밀번호는 Firebase 로그인 시스템에만.
 */
const EMAIL_DOMAIN = 'staff.hanbit-schedule.app';
const HE = (code, msg) => new functions.https.HttpsError(code, msg);
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const idOk = id => /^[a-z0-9][a-z0-9._-]{2,19}$/.test(id) || (id.length <= 80 && EMAIL_RE.test(id));
const loginEmail = id => id.includes('@') ? id : `${id}@${EMAIL_DOMAIN}`;
const pwOk = pw => typeof pw === 'string' && pw.length >= 6 && pw.length <= 64;

async function createAccount(data, makeAdmin, byUid) {
  const name = String(data.name || '').trim(), id = String(data.id || '').trim().toLowerCase(), pw = data.pw;
  if (!name || name.length > 20) throw HE('invalid-argument', '이름을 확인해 주세요');
  if (!idOk(id)) throw HE('invalid-argument', '아이디는 회사 메일 주소이거나, 영문 소문자·숫자 3~20자예요');
  if (!pwOk(pw)) throw HE('invalid-argument', '비밀번호는 6자 이상이에요');
  const dup = await db.collection('accounts').where('id', '==', id).limit(1).get();
  if (!dup.empty) throw HE('already-exists', '이미 있는 아이디예요');
  let u;
  try { u = await admin.auth().createUser({ email: loginEmail(id), password: pw, displayName: name }); }
  catch (e) {
    if (e && e.code === 'auth/email-already-exists') throw HE('already-exists', '이미 있는 아이디예요');
    if (e && /configuration-not-found|operation-not-allowed/.test(e.code || '')) throw HE('failed-precondition', 'Firebase에서 이메일/비밀번호 로그인을 먼저 켜 주세요');
    throw HE('internal', '계정을 만들지 못했어요: ' + ((e && e.message) || e));
  }
  if (makeAdmin) await admin.auth().setCustomUserClaims(u.uid, { admin: true });
  const row = { name, id, admin: !!makeAdmin, active: true, mustChange: !!byUid, createdAt: Date.now(), by: byUid || '' };
  await db.collection('accounts').doc(u.uid).set(row);
  return { uid: u.uid, ...row };
}

exports.accounts = fn().https.onCall(async (data, context) => {
  data = data || {};
  const a = String(data.action || '');
  const col = db.collection('accounts');
  const me = context.auth && context.auth.uid;
  const isAdmin = !!(context.auth && context.auth.token && context.auth.token.admin);

  if (a === 'status') { const s = await col.limit(1).get(); return { hasAny: !s.empty }; }
  if (a === 'setup') {
    const s = await col.limit(1).get();
    if (!s.empty) throw HE('failed-precondition', '이미 관리자 계정이 있어요. 관리자에게 계정을 받아 주세요');
    return createAccount(data, true, '');
  }
  if (a === 'pwChanged') {
    if (!me) throw HE('unauthenticated', '로그인이 필요해요');
    await col.doc(me).set({ mustChange: false, pwAt: Date.now() }, { merge: true });
    return { ok: true };
  }
  if (!isAdmin) throw HE('permission-denied', '관리자만 할 수 있어요');

  if (a === 'list') {
    const s = await col.get();
    return { list: s.docs.map(d => ({ uid: d.id, ...d.data() })).sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0)) };
  }
  if (a === 'create') return createAccount(data, !!data.admin, me);

  const uid = String(data.uid || '');
  const ref = col.doc(uid);
  const doc = uid ? await ref.get() : null;
  if (!doc || !doc.exists) throw HE('not-found', '계정을 찾지 못했어요');
  const now = Date.now();
  const otherAdmins = async () => (await col.where('admin', '==', true).get()).docs.filter(d => d.id !== uid && d.data().active !== false).length;

  if (a === 'resetPw') {
    if (!pwOk(data.pw)) throw HE('invalid-argument', '비밀번호는 6자 이상이에요');
    await admin.auth().updateUser(uid, { password: data.pw });
    await ref.set({ mustChange: true, updatedAt: now }, { merge: true });
    return { ok: true };
  }
  if (a === 'setActive') {
    const on = !!data.active;
    if (!on && uid === me) throw HE('failed-precondition', '내 계정은 막을 수 없어요');
    if (!on && doc.data().admin && !(await otherAdmins())) throw HE('failed-precondition', '관리자가 한 명은 있어야 해요');
    await admin.auth().updateUser(uid, { disabled: !on });
    if (!on) await admin.auth().revokeRefreshTokens(uid);
    await ref.set({ active: on, updatedAt: now }, { merge: true });
    return { ok: true };
  }
  if (a === 'setAdmin') {
    const on = !!data.admin;
    if (!on && !(await otherAdmins())) throw HE('failed-precondition', '관리자가 한 명은 있어야 해요');
    await admin.auth().setCustomUserClaims(uid, on ? { admin: true } : {});
    await ref.set({ admin: on, updatedAt: now }, { merge: true });
    return { ok: true };
  }
  if (a === 'rename') {
    const name = String(data.name || '').trim();
    if (!name || name.length > 20) throw HE('invalid-argument', '이름을 확인해 주세요');
    await admin.auth().updateUser(uid, { displayName: name });
    await ref.set({ name, updatedAt: now }, { merge: true });
    return { ok: true };
  }
  if (a === 'remove') {
    if (uid === me) throw HE('failed-precondition', '내 계정은 지울 수 없어요');
    if (doc.data().admin && !(await otherAdmins())) throw HE('failed-precondition', '관리자가 한 명은 있어야 해요');
    await admin.auth().deleteUser(uid).catch(e => { if (!(e && e.code === 'auth/user-not-found')) throw e; });
    await ref.delete();
    return { ok: true };
  }
  throw HE('invalid-argument', '알 수 없는 요청이에요');
});
