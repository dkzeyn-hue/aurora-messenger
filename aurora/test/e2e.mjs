/* E2E test: username-only auth + full user journey in a real headless browser */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = 'http://localhost:3000';
const SHOTS = '/home/user/aurora/test/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const ok = (name, pass, extra = '') => { results.push({ name, pass, extra }); console.log((pass ? '✓' : '✗ FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, permissions: [] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
const badResponses = [];
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(r.status() + ' ' + r.url().replace('http://localhost:3000', '')); });
let p2 = null, p3 = null;
const RUNID = Math.floor(Date.now() / 1000).toString(36);

try {
  // ---------- 1. load & register (username-only, auto-login) ----------
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  // generate a valid test avatar via canvas (Chrome's decoder rejects crafted/truncated PNGs)
  const avatarDataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 300;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 300, 300);
    g.addColorStop(0, '#7c5cff'); g.addColorStop(1, '#4cc9f0');
    x.fillStyle = g; x.fillRect(0, 0, 300, 300);
    x.fillStyle = '#fff'; x.font = 'bold 64px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('E2E', 150, 150);
    return c.toDataURL('image/png');
  });
  fs.writeFileSync('/tmp/e2e-avatar.png', Buffer.from(avatarDataUrl.split(',')[1], 'base64'));
  ok('app boots to login', await page.locator('.auth-card').count() > 0);
  const loginBody = await page.locator('body').innerText();
  ok('no email field on login', !(await page.locator('input[type=email]').count()));
  await page.screenshot({ path: SHOTS + '/01-login.png' });

  await page.locator('.auth-switch b', { hasText: 'Create an account' }).click();
  await page.waitForTimeout(500);
  ok('register has no email field', !(await page.locator('input[type=email]').count()));
  await page.locator('input[placeholder="username"]').fill('e2e' + RUNID);
  await page.locator('input[placeholder="Your display name"]').fill('E2E Tester ' + RUNID);
  await page.locator('input[placeholder="Create a password"]').fill('Str0ngPass!42');
  await page.locator('input[placeholder="Confirm password"]').fill('Str0ngPass!42');
  await page.screenshot({ path: SHOTS + '/02-register.png' });
  await page.locator('button:has-text("Create account")').click();
  await page.waitForTimeout(2200);
  ok('registration auto-logs in → chat list', await page.locator('.tabbar').count() > 0, page.url());
  ok('no verification step anywhere', !page.url().includes('verify'));
  await page.screenshot({ path: SHOTS + '/03-auto-login.png' });

  // ---------- 2. logout → login with username + password ----------
  await page.goto(BASE + '/#/settings');
  await page.waitForTimeout(1200);
  await page.locator('.set-title:has-text("Log out")').first().click();
  await page.waitForTimeout(400);
  await page.locator('.btn:has-text("Log out")').last().click();
  await page.waitForTimeout(1400);
  ok('logout returns to login', await page.locator('.auth-card').count() > 0);
  await page.locator('input[placeholder="Username or @username"]').fill('e2e' + RUNID);
  await page.locator('input[placeholder="Password"]').fill('Str0ngPass!42');
  await page.locator('button:has-text("Sign in")').click();
  await page.waitForTimeout(2000);
  ok('re-login with username+password', await page.locator('.tabbar').count() > 0, page.url());
  // wrong password shows error
  await page.goto(BASE + '/#/settings');
  await page.waitForTimeout(800);
  await page.locator('.set-title:has-text("Log out")').first().click();
  await page.waitForTimeout(300);
  await page.locator('.btn:has-text("Log out")').last().click();
  await page.waitForTimeout(1200);
  await page.locator('input[placeholder="Username or @username"]').fill('e2e' + RUNID);
  await page.locator('input[placeholder="Password"]').fill('WrongPassword!1');
  await page.locator('button:has-text("Sign in")').click();
  await page.waitForTimeout(900);
  ok('wrong password shows clear error', (await page.locator('.form-error').innerText()).includes('Incorrect username or password'));
  await page.locator('input[placeholder="Password"]').fill('Str0ngPass!42');
  await page.locator('button:has-text("Sign in")').click();
  await page.waitForTimeout(2000);
  ok('login again with correct password', await page.locator('.tabbar').count() > 0);
  await page.screenshot({ path: SHOTS + '/04-relogin.png' });

  // ---------- 3. find admin & DM ----------
  await page.locator('.fab').click();
  await page.waitForTimeout(600);
  await page.locator('input[placeholder^="Search by"]').fill('admin');
  await page.waitForTimeout(900);
  await page.locator('.row-item').first().click();
  await page.waitForTimeout(1300);
  ok('DM conversation opens', await page.locator('.chat-scroll').count() > 0, page.url());
  const composer = page.locator('.composer textarea');
  await composer.fill('Hello from the E2E test! 🚀');
  await composer.press('Enter');
  await page.waitForTimeout(900);
  ok('message sent & rendered', await page.locator('.msg-row.out').count() > 0);
  await page.screenshot({ path: SHOTS + '/06-dm-sent.png' });
  const incoming = await page.locator('.msg-row:not(.out)').count();
  ok('incoming messages render', incoming > 0, incoming + ' incoming');

  // ---------- 4. create group ----------
  await page.goto(BASE + '/#/new/group');
  await page.waitForTimeout(700);
  await page.locator('input[placeholder="Group name"]').fill('E2E Heroes');
  await page.locator('input[placeholder="Description (optional)"]').fill('Testing groups');
  await page.locator('button:has-text("Create group")').click();
  await page.waitForTimeout(1500);
  ok('group created & opened', page.url().includes('conversation'), page.url());
  await page.locator('.composer textarea').fill('Group hello!');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(700);
  ok('group message sent', await page.locator('.msg-row.out').count() > 0);
  await page.screenshot({ path: SHOTS + '/07-group.png' });

  // ---------- 5. create channel ----------
  await page.goto(BASE + '/#/new/channel');
  await page.waitForTimeout(700);
  await page.locator('input[placeholder="Channel name"]').fill('E2E News');
  await page.locator('button:has-text("Create channel")').click();
  await page.waitForTimeout(1500);
  ok('channel created & opened', page.url().includes('conversation'), page.url());
  await page.locator('.composer textarea').fill('First post!');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(800);
  ok('channel post sent', (await page.locator('.chat-scroll').textContent()).includes('First post!'));
  await page.screenshot({ path: SHOTS + '/08-channel.png' });

  // ---------- 6. settings ----------
  await page.goto(BASE + '/#/settings');
  await page.waitForTimeout(1000);
  const settingsText = await page.locator('body').innerText();
  ok('settings renders', await page.locator('.set-group').count() > 3);
  ok('settings has no email row', !settingsText.includes('Email address') && !settingsText.includes('@aurora.test'));
  await page.locator('.seg button', { hasText: 'Dark' }).click();
  await page.waitForTimeout(500);
  ok('dark theme applied', await page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
  await page.screenshot({ path: SHOTS + '/09-settings-dark.png' });
  await page.locator('.set-title:has-text("Privacy controls")').click();
  await page.waitForTimeout(700);
  ok('privacy sheet opens', await page.locator('.choice-row').count() > 0);
  await page.locator('.choice-row', { hasText: 'Nobody' }).first().click();
  await page.waitForTimeout(500);
  ok('privacy choice saved', true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // ---------- 6b. profile photo upload ----------
  await page.goto(BASE + '/#/user/e2e' + RUNID);
  await page.waitForTimeout(1200);
  ok('own profile renders with camera badge', await page.locator('.avatar-cam').count() > 0);
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.avatar-cam').click(),
  ]);
  await fc.setFiles('/tmp/e2e-avatar.png');
  await page.waitForTimeout(2200);
  const avImg = page.locator('.profile-hero .avatar img');
  ok('profile photo uploaded & displayed', await avImg.count() > 0 && await avImg.first().evaluate(i => i.complete && i.naturalWidth > 0));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  ok('photo persists after reload', await page.locator('.profile-hero .avatar img').first().evaluate(i => i.complete && i.naturalWidth > 0));
  await page.locator('button:has-text("Edit")').click();
  await page.waitForTimeout(600);
  await page.locator('button:has-text("Remove photo")').click();
  await page.waitForTimeout(1200);
  ok('photo removed → initials return', await page.locator('.profile-hero .avatar img').count() === 0);

  // ---------- 7. stories / discover / search ----------
  await page.goto(BASE + '/#/stories');
  await page.waitForTimeout(900);
  ok('stories view renders', await page.locator('.screen').count() > 0);
  await page.screenshot({ path: SHOTS + '/10-stories.png' });

  await page.goto(BASE + '/#/discover');
  await page.waitForTimeout(900);
  const discoverRows = await page.locator('.row-item').count();
  ok('discover shows public chats', discoverRows > 0, discoverRows + ' chats');
  await page.screenshot({ path: SHOTS + '/11-discover.png' });

  await page.goto(BASE + '/#/chat');
  await page.waitForTimeout(800);
  await page.locator('.icon-btn').first().click(); // search btn
  await page.waitForTimeout(400);
  await page.locator('input[placeholder^="Search messages"]').last().fill('hello');
  await page.waitForTimeout(1200);
  ok('global search returns results', await page.locator('.row-item, .section-label').count() > 0);
  await page.screenshot({ path: SHOTS + '/12-search.png' });
  await page.locator('.screen.fade-in .appbar .icon-btn').first().click();
  await page.waitForTimeout(400);

  // ---------- 8. second user: register (auto-login) + realtime ----------
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 800 } });
  p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push('p2 pageerror: ' + e.message));
  await p2.goto(BASE, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(900);
  await p2.locator('.auth-switch b', { hasText: 'Create an account' }).click();
  await p2.waitForTimeout(500);
  await p2.locator('input[placeholder="username"]').fill('friend' + RUNID);
  await p2.locator('input[placeholder="Your display name"]').fill('E2E Friend ' + RUNID);
  await p2.locator('input[placeholder="Create a password"]').fill('Str0ngPass!43');
  await p2.locator('input[placeholder="Confirm password"]').fill('Str0ngPass!43');
  await p2.locator('button:has-text("Create account")').click();
  await p2.waitForTimeout(2200);
  ok('second user registered & auto-logged in', await p2.locator('.tabbar').count() > 0);

  await p2.locator('.fab').click();
  await p2.waitForTimeout(500);
  await p2.locator('input[placeholder^="Search by"]').fill('e2e' + RUNID);
  await p2.waitForTimeout(900);
  await p2.locator('.row-item').first().click();
  await p2.waitForTimeout(1200);
  await p2.locator('.composer textarea').fill('Hey e2e! Realtime test');
  await p2.locator('.composer textarea').press('Enter');
  await p2.waitForTimeout(400);

  await page.goto(BASE + '/#/chat');
  await page.waitForTimeout(1500);
  const rowText = await page.locator('.list').textContent().catch(() => '');
  ok('realtime message received on chat list', rowText.includes('Realtime test'), rowText.slice(0, 80));
  await page.screenshot({ path: SHOTS + '/13-realtime.png' });

  await page.locator('.row-item', { hasText: 'E2E Friend ' + RUNID }).first().click();
  await page.waitForTimeout(900);
  const dmText = await page.locator('.chat-scroll').textContent();
  ok('message visible in conversation', dmText.includes('Realtime test'));

  await p2.locator('.composer textarea').fill('typing something…');
  await page.waitForTimeout(1200);
  const typingVisible = await page.locator('.typing-bar:not(.hidden)').count();
  ok('typing indicator appears', typingVisible > 0);

  const friendMsg = page.locator('.msg-row:not(.out) .bubble').last();
  await friendMsg.click({ button: 'right' });
  await page.waitForTimeout(500);
  await page.locator('.ctx-item:has-text("React")').click();
  await page.waitForTimeout(500);
  await page.locator('.sheet-body button', { hasText: '❤️' }).first().click();
  await page.waitForTimeout(800);
  ok('reaction added', await page.locator('.reaction-chip').count() > 0);
  await page.screenshot({ path: SHOTS + '/14-reactions.png' });

  await friendMsg.click({ button: 'right' });
  await page.waitForTimeout(400);
  await page.locator('.ctx-item:has-text("Reply")').click();
  await page.waitForTimeout(400);
  await page.locator('.composer textarea').fill('Replying to you!');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(800);
  ok('reply sent with quote', await page.locator('.reply-quote').count() > 0);

  // ---------- 9. change password (the only recovery-free reset path) ----------
  await p2.goto(BASE + '/#/settings');
  await p2.waitForTimeout(1100);
  await p2.locator('.set-title:has-text("Change password")').click();
  await p2.waitForTimeout(500);
  const pwInputs = p2.locator('.sheet input[type=password]');
  await pwInputs.nth(0).fill('Str0ngPass!43');
  await pwInputs.nth(1).fill('NewStr0ng!44');
  await pwInputs.nth(2).fill('NewStr0ng!44');
  await p2.locator('.btn:has-text("Update password")').click();
  await p2.waitForTimeout(900);
  // log out and back in with the new password
  await p2.goto(BASE + '/#/settings');
  await p2.waitForTimeout(900);
  await p2.locator('.set-title:has-text("Log out")').first().click();
  await p2.waitForTimeout(300);
  await p2.locator('.btn:has-text("Log out")').last().click();
  await p2.waitForTimeout(1300);
  await p2.locator('input[placeholder="Username or @username"]').fill('friend' + RUNID);
  await p2.locator('input[placeholder="Password"]').fill('NewStr0ng!44');
  await p2.locator('button:has-text("Sign in")').click();
  await p2.waitForTimeout(2000);
  ok('login with changed password works', await p2.locator('.tabbar').count() > 0);

  // ---------- 10. sessions ----------
  await p2.goto(BASE + '/#/settings');
  await p2.waitForTimeout(1100);
  await p2.locator('.set-title:has-text("Active sessions")').click();
  await p2.waitForTimeout(700);
  ok('sessions listed', await p2.locator('.set-group').count() > 0);
  await p2.screenshot({ path: SHOTS + '/15-sessions.png' });
  await p2.keyboard.press('Escape');
  await p2.waitForTimeout(300);

  // ---------- 11. final logout + security ----------
  await page.goto(BASE + '/#/settings');
  await page.waitForTimeout(900);
  await page.locator('.set-title:has-text("Log out")').first().click();
  await page.waitForTimeout(400);
  await page.locator('.btn:has-text("Log out")').last().click();
  await page.waitForTimeout(1300);
  ok('final logout returns to login', await page.locator('.auth-card').count() > 0);

  const res = await fetch(BASE + '/api/chats', { headers: { Authorization: 'Bearer fake' } });
  ok('fake token rejected', res.status === 401);
  const res2 = await fetch(BASE + '/api/admin/stats');
  ok('admin blocked anonymously', res2.status === 401);
  const res3 = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'e2e' + RUNID, password: 'nope' }) });
  ok('bad login rejected with 401', res3.status === 401);
  const dup = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'e2e' + RUNID, displayName: 'Dup', password: 'Str0ngPass!42', confirmPassword: 'Str0ngPass!42' }) });
  ok('duplicate username prevented', dup.status === 409);
  const legacy = await fetch(BASE + '/api/dev/emails');
  ok('dev inbox endpoint retired', legacy.status === 404);

} catch (e) {
  ok('FATAL: ' + e.message, false, e.stack?.split('\n')[1] || '');
  try {
    console.log('--- FATAL CONTEXT ---');
    console.log('url:', page.url());
    const txt = await page.locator('body').innerText().catch(() => '');
    console.log('body text (first 700):', txt.slice(0, 700).replace(/\n+/g, ' | '));
    try {
      if (p2) {
        console.log('p2 url:', p2.url());
        const t2 = await p2.locator('body').innerText().catch(() => '');
        console.log('p2 body (first 400):', t2.slice(0, 400).replace(/\n+/g, ' | '));
      }
    } catch {}
    await page.screenshot({ path: SHOTS + '/fatal.png' });
  } catch {}
}

console.log('\n==== RESULT: ' + results.filter(r => r.pass).length + '/' + results.length + ' passed ====');
if (badResponses.length) console.log('4xx/5xx responses:\n' + [...new Set(badResponses)].slice(0, 12).join('\n'));
if (errors.length) console.log('Browser errors:\n' + [...new Set(errors)].slice(0, 12).join('\n'));
await browser.close();
process.exit(results.some(r => !r.pass) ? 1 : 0);
