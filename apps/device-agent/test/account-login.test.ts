import assert from 'node:assert/strict';
import { test } from 'node:test';
import pino from 'pino';
import { confirmedLoggedOut, findTikTokResetSettings, mailboxConfig, runDeviceAccountLogin } from '../src/account-login';
import { authenticatorCode } from '../src/totp';
import type { AdbClient } from '../src/adb-client';
import type { PackageResolver } from '../src/package-resolver';
import type { UiEl, UiScreen } from '../src/ui-automation';

const element = (text: string, cls = 'android.widget.Button'): UiEl => ({
  text, cls, desc: '', pkg: 'test.app', resId: '', parent: null, enabled: true, focused: false,
  clickable: cls === 'android.widget.Button', bounds: [10, 20, 190, 60],
});
const screen = (...els: UiEl[]): UiScreen => ({ pkg: 'test.app', els, xml: '' });

test('TOTP matches RFC 6238 vectors with six digits', () => {
  const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(authenticatorCode(seed, 59_000), '287082');
  assert.equal(authenticatorCode(seed.toLowerCase(), 1_111_111_109_000), '081804');
  assert.throws(() => authenticatorCode('123456', 59_000), /Неверный ключ/);
});

test('only a confirmed login screen triggers recovery', () => {
  const login = element('Log in');
  const signup = element('Sign up');
  assert.equal(confirmedLoggedOut(screen(login, signup)), true);
  assert.equal(confirmedLoggedOut(screen(login, element('Password', 'android.widget.EditText'))), true);
  assert.equal(confirmedLoggedOut(screen(login)), false);
  assert.equal(confirmedLoggedOut(screen(login, signup, element('No internet connection'))), false);
  assert.equal(confirmedLoggedOut(screen(login, signup, element('Account suspended'))), false);
});

test('TikTok settings only targets Reset settings', () => {
  const settings = element('Settings', 'android.widget.TextView');
  const reset = element('Reset settings');
  const hardwareBan = element('Removing a hardware ban');
  assert.equal(findTikTokResetSettings(screen(settings, hardwareBan, reset)), reset);
  assert.equal(findTikTokResetSettings(screen(settings, hardwareBan)), undefined);
  assert.equal(findTikTokResetSettings(screen(reset)), undefined);
});

test('Outlook only uses explicitly supplied Microsoft mailbox OAuth credentials', () => {
  const req = { platform: 'tiktok' as const, deviceId: 'board', username: 'demo', email: 'owner@outlook.com', emailPassword: 'password' };
  assert.equal(mailboxConfig(req), undefined);
  assert.deepEqual(mailboxConfig({ ...req, emailOAuthRefreshToken: 'demo', emailOAuthClientId: 'demo-id' }), {
    email: 'owner@outlook.com', host: 'outlook.office365.com', port: 993, oauthRefreshToken: 'demo', oauthClientId: 'demo-id',
  });
  assert.equal(mailboxConfig({ ...req, email: 'owner@mail.ru' })?.password, 'password');
});

test('Instagram enters credentials and TOTP before confirming the matching own profile', async (t) => {
  const now = 59_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 40_000 });
  const pkg = 'com.instagram.android';
  const node = (text: string, position: number, cls = 'Button') =>
    `<node package="${pkg}" text="${text}" class="android.widget.${cls}" clickable="true" enabled="true" bounds="[0,${position}][100,${position + 20}]" />`;
  const xml = (children: string) =>
    `<?xml version="1.0"?><hierarchy><node package="${pkg}" bounds="[0,0][1080,2400]">${children}</node></hierarchy>`;
  const screens = [
    xml(node('Username', 90, 'EditText') + node('Password', 130, 'EditText') + node('Log in', 170)),
    xml(node('Enter security code from your authentication app', 90, 'TextView') + node('Security code', 130, 'EditText') + node('Confirm', 210)),
    xml(node('owner', 90, 'TextView') + node('Edit profile', 150)),
  ];
  let state = 0;
  const typed: string[] = [];
  const adb = {
    wakeUp: async () => {},
    shell: async () => '',
    openApp: async () => {},
    getScreenSize: async () => ({ width: 1080, height: 2400 }),
    fastShell: async (_id: string, command: string) => command.includes('uiautomator dump') ? screens[state] : '',
    tap: async (_id: string, _x: number, y: number) => {
      if ((state === 0 && y === 180) || (state === 1 && y === 220)) state++;
    },
    inputText: async (_id: string, text: string, sensitive: boolean) => {
      assert.equal(sensitive, true);
      typed.push(text);
    },
  } as unknown as AdbClient;
  const resolver = { resolve: async () => ({ installed: true, packageName: pkg }) } as unknown as PackageResolver;
  const login = runDeviceAccountLogin({
    deviceId: 'board', platform: 'instagram', username: 'owner', password: 'test-password',
    twoFactorSeed: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  }, adb, resolver, pino({ level: 'silent' }));
  let finished = false;
  void login.then(() => { finished = true; });
  for (let i = 0; i < 20 && !finished; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.runAll();
  }
  assert.equal(finished, true);
  assert.equal((await login).ok, true);
  assert.deepEqual(typed, ['owner', 'test-password', authenticatorCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', now)]);
});
