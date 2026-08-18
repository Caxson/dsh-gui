'use strict';

/* Pairing window. The QR and the payload are fetched on demand and cleared as
   soon as the window is hidden — the secret is in them, and leaving it on a
   screen someone might share is the realistic way it leaks. */

const el = (id) => document.getElementById(id);

let revealed = false;

function describe(s) {
  if (!s.enabled) return { text: '未开启', cls: 'off' };
  if (!s.connected) return { text: '正在连接中转…', cls: 'warn' };
  if (!s.peerPresent) return { text: '已就绪，等待手机连接', cls: 'warn' };
  if (!s.authenticated) return { text: '手机已连上，等待验证密钥', cls: 'warn' };
  return { text: '手机已连接', cls: 'on' };
}

function render(s) {
  const { text, cls } = describe(s);
  el('state').textContent = text;
  el('dot').className = `dot ${cls}`;
  el('toggle').textContent = s.enabled ? '关闭' : '开启';
  el('toggle').className = s.enabled ? '' : 'primary';
  el('relay').value = s.relayUrl || '';
  el('pair-card').classList.toggle('hidden', !s.enabled || !s.hasSecret);
  el('room').textContent = s.room ? `房间 ${s.room}` : '';
  if (!s.enabled) hideQr();
}

function hideQr() {
  revealed = false;
  el('qr-wrap').classList.add('hidden');
  el('qr').removeAttribute('src');
  el('reveal').textContent = '显示二维码';
}

async function showQr() {
  const { payload, qr } = await window.dshPairing.reveal();
  if (!payload) return;
  el('qr').src = qr;
  el('qr-wrap').classList.remove('hidden');
  el('reveal').textContent = '隐藏';
  revealed = true;
}

async function refresh() {
  render(await window.dshPairing.status());
}

el('toggle').addEventListener('click', async () => {
  const s = await window.dshPairing.status();
  render(s.enabled ? await window.dshPairing.disable() : await window.dshPairing.enable());
});

el('reveal').addEventListener('click', () => (revealed ? hideQr() : showQr()));

el('rotate').addEventListener('click', async () => {
  const warn = el('rotate-warn');
  // Two-step on purpose: rotating silently breaks a phone that is working, and
  // the person doing it should have seen that sentence before it happens.
  if (warn.classList.contains('hidden')) {
    warn.classList.remove('hidden');
    el('rotate').textContent = '确认更换';
    setTimeout(() => {
      warn.classList.add('hidden');
      el('rotate').textContent = '更换密钥';
    }, 6000);
    return;
  }
  warn.classList.add('hidden');
  el('rotate').textContent = '更换密钥';
  render(await window.dshPairing.rotate());
  if (revealed) await showQr();
});

el('copy').addEventListener('click', async () => {
  await window.dshPairing.copyPayload();
  el('copy').textContent = '已复制';
  setTimeout(() => { el('copy').textContent = '复制配对链接'; }, 1500);
});

el('relay-save').addEventListener('click', async () => {
  try {
    render(await window.dshPairing.setRelay(el('relay').value.trim()));
    el('relay-save').textContent = '已保存';
  } catch {
    el('relay-save').textContent = '地址无效';
  }
  setTimeout(() => { el('relay-save').textContent = '保存'; }, 1500);
});

window.dshPairing.onStatus(render);
// Hiding the window is the moment to take the secret off the screen: a window
// restored later should not still be showing it.
window.addEventListener('blur', () => { if (revealed) hideQr(); });

refresh();
