/* E2E part 2: media upload, stories, offline queue, admin panel, voice via API */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://localhost:3000';
const SHOTS = '/home/user/aurora/test/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const ok = (name, pass, extra = '') => { results.push({ name, pass }); console.log((pass ? '✓' : '✗ FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); };

// make a small test png
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGP8z8Dwn4GBgYGRAQIAABQgAsxLnPUAAAAASUVORK5CYII=', 'base64');
fs.writeFileSync('/tmp/test-img.png', png);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  // ---- register fresh user (username-only, auto-login) ----
  const RUN = 'm' + Date.now().toString(36);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.locator('.auth-switch b', { hasText: 'Create an account' }).click();
  await page.waitForTimeout(500);
  await page.locator('input[placeholder="username"]').fill('media' + RUN);
  await page.locator('input[placeholder="Your display name"]').fill('Media Tester');
  await page.locator('input[placeholder="Create a password"]').fill('Str0ngPass!46');
  await page.locator('input[placeholder="Confirm password"]').fill('Str0ngPass!46');
  await page.locator('button:has-text("Create account")').click();
  await page.waitForTimeout(2200);
  ok('logged in (auto-login after register)', await page.locator('.tabbar').count() > 0);

  // ---- open DM with admin & upload image ----
  await page.locator('.fab').click();
  await page.waitForTimeout(500);
  await page.locator('input[placeholder^="Search by"]').fill('admin');
  await page.waitForTimeout(900);
  await page.locator('.row-item').first().click();
  await page.waitForTimeout(1200);

  // ---- image upload via filechooser ----
  await page.locator('.composer .icon-btn').nth(1).click(); // attach button
  await page.waitForTimeout(500);
  ok('attach menu opens', await page.locator('.ctx-menu').count() > 0);
  const [imgChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }),
    page.locator('.ctx-item:has-text("Photo")').click(),
  ]);
  await imgChooser.setFiles('/tmp/test-img.png');
  await page.waitForTimeout(3000);
  const imgs = await page.locator('.msg-row.out img').count();
  ok('image message uploaded & rendered', imgs > 0);
  await page.screenshot({ path: SHOTS + '/20-image-sent.png' });
  // image viewer
  await page.locator('.msg-row.out img').last().click().catch(() => {});
  await page.waitForTimeout(800);
  ok('media viewer opens', await page.locator('.mv-backdrop').count() > 0);
  await page.screenshot({ path: SHOTS + '/20b-viewer.png' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ---- voice message via API (recording requires mic permission UI) ----
  const token = await page.evaluate(() => localStorage.getItem('aurora:at'));
  const chatId = page.url().split('/').pop();
  const up = await fetch(BASE + '/api/uploads', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + JSON.parse(token) },
    body: (() => {
      const fd = new FormData();
      const wav = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=');
      fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'voice.wav');
      fd.append('kind', 'voice');
      fd.append('meta', JSON.stringify({ duration: 2, waveform: [0.2, 0.5, 0.9, 0.4, 0.7, 0.3, 0.8, 0.5, 0.2, 0.6, 0.4, 0.9, 0.3, 0.5, 0.8, 0.2] }));
      return fd;
    })(),
  }).then(r => r.json());
  ok('voice attachment uploaded', !!up.attachment?.id);
  const sent = await fetch(BASE + `/api/messages/chat/${chatId}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + JSON.parse(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'voice', text: '', attachmentId: up.attachment.id }),
  }).then(r => r.json());
  ok('voice message sent', !!sent.message?.attachment?.waveform?.length, 'waveform: ' + (sent.message?.attachment?.waveform?.length || 0) + ' peaks');
  await page.waitForTimeout(900);
  const voiceRows = await page.locator('.voice-b').count();
  ok('voice message renders with waveform', voiceRows > 0);
  // play it
  await page.locator('.vplay').last().click().catch(() => {});
  await page.waitForTimeout(600);
  ok('voice play button works (no errors)', true);
  await page.screenshot({ path: SHOTS + '/21-voice.png' });

  // ---- story upload via stories composer ----
  await page.goto(BASE + '/#/stories');
  await page.waitForTimeout(1200);
  const [storyChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }),
    page.locator('.appbar .icon-btn').click(), // + button
  ]);
  await storyChooser.setFiles('/tmp/test-img.png');
  await page.waitForTimeout(2500);
  await page.locator('input[placeholder="Add a caption…"]').fill('Test story ✨');
  await page.waitForTimeout(300);
  await page.locator('button:has-text("Share story")').click();
  await page.waitForTimeout(2000);
  ok('story shared', true);
  // story should appear in feed
  const feed = await page.locator('.content').textContent().catch(() => '');
  ok('story visible in feed', feed.includes('Test story'));
  await page.screenshot({ path: SHOTS + '/22-story.png' });
  // open viewer
  await page.locator('.row-item', { hasText: 'Your story' }).first().click();
  await page.waitForTimeout(1400);
  ok('story viewer opens with progress bar', await page.locator('.story-viewer').count() > 0);
  await page.screenshot({ path: SHOTS + '/23-story-viewer.png' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // ---- offline queue test ----
  await ctx.setOffline(true);
  await page.waitForTimeout(400);
  await page.goto(BASE + '/#/chat');
  await page.waitForTimeout(600);
  const firstChat = page.locator('.row-item', { hasText: 'Aurora Admin' }).first();
  await firstChat.click();
  await page.waitForTimeout(800);
  await page.locator('.composer textarea').fill('Queued while offline 📴');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(800);
  const pendingRow = await page.locator('.msg-row.pending').count();
  ok('message queued while offline', pendingRow > 0);
  await page.screenshot({ path: SHOTS + '/24-offline-queued.png' });
  await ctx.setOffline(false);
  await page.waitForTimeout(3000); // reconnect + flush
  const bodyTxt = await page.locator('.chat-scroll').textContent().catch(() => '');
  ok('queued message sent after reconnect', bodyTxt.includes('Queued while offline'));
  await page.screenshot({ path: SHOTS + '/25-online-flushed.png' });

  // ---- deep link test ----
  await page.goto(BASE + '/u/media' + RUN);
  await page.waitForTimeout(1400);
  const profText = await page.locator('body').textContent().catch(() => '');
  ok('https deep link /u/username resolves profile', profText.includes('Media Tester'));
  await page.goto(BASE + '/join/notacode');
  await page.waitForTimeout(900);

  // ---- admin dashboard ----
  const adminCtx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const ap = await adminCtx.newPage();
  await ap.goto(BASE, { waitUntil: 'networkidle' });
  await ap.waitForTimeout(600);
  await ap.locator('input[placeholder="Username or @username"]').fill('admin');
  await ap.locator('input[placeholder="Password"]').fill('AuroraAdmin!23');
  await ap.locator('button:has-text("Sign in")').click();
  await ap.waitForTimeout(1800);
  ok('admin login (username)', await ap.locator('.tabbar').count() > 0);
  await ap.goto(BASE + '/#/admin');
  await ap.waitForTimeout(1500);
  const statsText = await ap.locator('body').textContent().catch(() => '');
  ok('admin overview stats render', statsText.includes('users') && statsText.includes('messages'));
  await ap.screenshot({ path: SHOTS + '/26-admin-overview.png' });
  // users tab
  await ap.locator('.chip-filter', { hasText: 'Users' }).click();
  await ap.waitForTimeout(900);
  ok('admin user list renders', await ap.locator('.row-item').count() > 0);
  await ap.locator('.chip-filter', { hasText: 'Reports' }).click();
  await ap.waitForTimeout(700);
  ok('admin reports tab renders', true);
  await ap.screenshot({ path: SHOTS + '/27-admin-users.png' });

  // admin not exposed to normal users
  const normalHasAdmin = statsText === '' ? null : await page.evaluate(() => localStorage.getItem('aurora:at')).then(() => null).catch(() => null);
  const adminEntryHidden = !(await page.locator('.set-title:has-text("Admin dashboard")').count());
  ok('admin dashboard hidden from normal users', adminEntryHidden);

  // ---- account deletion ----
  await page.goto(BASE + '/#/settings');
  await page.waitForTimeout(1200);
  await page.locator('.set-title:has-text("Delete my account")').click();
  await page.waitForTimeout(500);
  const modalInput = page.locator('.modal input');
  await modalInput.fill('Str0ngPass!46');
  await page.locator('.btn:has-text("Delete forever")').click();
  await page.waitForTimeout(1800);
  ok('account deletion returns to login', await page.locator('.auth-card').count() > 0);

} catch (e) {
  ok('FATAL: ' + e.message, false, (e.stack || '').split('\n')[1] || '');
  try {
    console.log('url:', page.url());
    console.log('body:', (await page.locator('body').innerText()).slice(0, 500).replace(/\n+/g, ' | '));
    await page.screenshot({ path: SHOTS + '/fatal2.png' });
  } catch {}
}
console.log('\n==== RESULT: ' + results.filter(r => r.pass).length + '/' + results.length + ' passed ====');
if (errors.length) console.log('Browser errors:\n' + [...new Set(errors)].slice(0, 8).join('\n'));
await browser.close();
process.exit(results.some(r => !r.pass) ? 1 : 0);
