import type { Logger } from 'pino';
import type { AdbClient } from './adb-client';
import type { PackageResolver } from './package-resolver';
import { profileMatchesUsername } from './profile-stats';
import { pollVerificationCode, isMicrosoftImap, type ImapConfig } from './imap-client';
import { authenticatorCode } from './totp';
import { byLabel, clickTarget, dumpScreen, editTexts, isVisible, label, sleep, tapEl, type UiScreen, type UiEl } from './ui-automation';

export interface DeviceAccountLoginRequest {
  deviceId: string;
  platform: 'tiktok' | 'instagram';
  username: string;
  password?: string;
  twoFactorSeed?: string;
  email?: string;
  emailPassword?: string;
  emailOAuthRefreshToken?: string;
  emailOAuthClientId?: string;
  imapHost?: string;
  imapPort?: number;
}

export interface DeviceAccountLoginResult {
  ok: boolean;
  deviceId: string;
  platform: DeviceAccountLoginRequest['platform'];
  alreadyLoggedIn?: boolean;
  detail: string;
  error?: string;
}

const LOGIN = /^(log in|log into your account|sign in|войти|вход|войти в аккаунт)$/i;
const LOGIN_METHOD = /^(?:use phone\s*\/\s*email\s*\/\s*username|use phone or email|email\s*\/\s*username|email or username|телефон\s*\/\s*почта\s*\/\s*имя пользователя|почта\s*\/\s*имя пользователя|войти через пароль|log in with password)$/i;
const SIGN_UP = /^(sign up(?: for tiktok)?|log in or sign up|create new account|регистрация|зарегистрироваться|создать аккаунт)$/i;
const PASSWORD = /password|пароль/i;
const USERNAME = /username|user_name|email|login|identifier|имя пользователя|электронная почта|логин|^почта$/i;
const CODE_FIELD = /code|код|pin|otp|security|verification/i;
const CODE_SCREEN = /enter (?:the |your )?(?:6.digit |security |verification |confirmation )?code|check your (?:email|inbox)|введите (?:проверочный |шестизначный )?код|код подтверждения|проверьте почту/i;
const AUTHENTICATOR = /authentication app|authenticator app|приложени[ея].{0,25}аутентификатор/i;
const EMAIL_CHALLENGE = /check your (?:email|inbox)|(?:sent|send).{0,45}(?:email|@)|код.{0,30}(?:отправлен|электронную почту)|проверьте почту/i;
const BLOCKER = /captcha|verify (?:to continue|you.re human)|security check|try again later|too many attempts|account (?:suspended|banned|locked)|капч[аиу]|слишком много попыток|аккаунт заблокирован|попробуйте позже/i;
const NETWORK = /no (?:internet|network) connection|network error|нет (?:сети|соединения)|ошибка сети/i;
const EDIT_PROFILE = /^(edit profile|редактировать профиль|изменить профиль)$/i;

const labels = (screen: UiScreen) => screen.els.map(label).join('\n');
const idLabel = (el: UiEl) => `${label(el)} ${el.resId.split('/').pop() ?? ''}`;
const button = (screen: UiScreen, pattern: RegExp) => {
  const el = byLabel(screen, pattern);
  return el && clickTarget(el).clickable ? el : undefined;
};

export function confirmedLoggedOut(screen: UiScreen): boolean {
  const text = labels(screen);
  if (NETWORK.test(text) || BLOCKER.test(text)) return false;
  if (button(screen, LOGIN_METHOD) && byLabel(screen, /^(?:log in to tiktok|вход в tiktok)$/i)) return true;
  if (!button(screen, LOGIN)) return false;
  return !!byLabel(screen, SIGN_UP) || editTexts(screen).some((el) => PASSWORD.test(idLabel(el))) ||
    /session (?:has )?expired|срок действия сессии ист[её]к/i.test(text);
}

function codeField(screen: UiScreen): UiEl | undefined {
  const fields = editTexts(screen);
  return fields.find((el) => CODE_FIELD.test(idLabel(el))) ??
    (fields.length === 1 && CODE_SCREEN.test(labels(screen)) ? fields[0] : undefined);
}

async function screenFor(adb: AdbClient, deviceId: string, pkg: string): Promise<UiScreen | null> {
  const screen = await dumpScreen(adb, deviceId, 1);
  return screen?.pkg === pkg ? screen : null;
}

async function verifyOwnProfile(adb: AdbClient, deviceId: string, pkg: string, platform: DeviceAccountLoginRequest['platform'], username: string): Promise<boolean> {
  const { height } = await adb.getScreenSize(deviceId);
  let screen = await screenFor(adb, deviceId, pkg);
  if (!screen) return false;
  const profile = screen.els.find((el) => isVisible(el) && el.bounds[1] > height * 0.75 &&
    (/^(?:profile|профиль|аккаунт)$/i.test(label(el)) || /:id\/(?:profile_tab|tab_profile)$/.test(el.resId)) && clickTarget(el).clickable);
  if (profile && !byLabel(screen, EDIT_PROFILE)) {
    await tapEl(adb, deviceId, profile);
    await sleep(1300);
    screen = await screenFor(adb, deviceId, pkg);
  }
  return Boolean(screen && byLabel(screen, EDIT_PROFILE) && profileMatchesUsername(screen.xml, height, username, platform));
}

async function enterText(adb: AdbClient, deviceId: string, field: UiEl, value: string): Promise<void> {
  await tapEl(adb, deviceId, field);
  if (field.text) {
    await adb.fastShell(deviceId, `input keyevent 123; input keyevent ${'67 '.repeat(Math.min(field.text.length, 256)).trim()}`);
  }
  await adb.inputText(deviceId, value, true);
}

async function submitCode(adb: AdbClient, deviceId: string, pkg: string, field: UiEl, code: string): Promise<void> {
  await enterText(adb, deviceId, field, code);
  const screen = await screenFor(adb, deviceId, pkg);
  if (!screen || !codeField(screen)) return;
  const confirm = button(screen, /^(?:confirm|next|continue|submit|done|подтвердить|далее|продолжить|отправить|готово)$/i);
  if (confirm) await tapEl(adb, deviceId, confirm);
}

export function mailboxConfig(req: DeviceAccountLoginRequest): ImapConfig | undefined {
  if (!req.email) return undefined;
  const host = req.imapHost;
  const port = req.imapPort;
  if (isMicrosoftImap(req.email, host)) {
    if (!req.emailOAuthRefreshToken || !req.emailOAuthClientId) return undefined;
    return { email: req.email, host: 'outlook.office365.com', port: 993, oauthRefreshToken: req.emailOAuthRefreshToken, oauthClientId: req.emailOAuthClientId };
  }
  return req.emailPassword ? { email: req.email, host, port, password: req.emailPassword } : undefined;
}

export function findTikTokResetSettings(screen: UiScreen): UiEl | undefined {
  if (!byLabel(screen, /^(?:settings|настройки)$/i)) return undefined;
  return button(screen, /^(?:reset settings|сбросить настройки|сброс настроек)$/i);
}

export async function resetTikTokModSettings(adb: AdbClient, deviceId: string, pkg: string): Promise<boolean> {
  if (!/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(pkg)) return false;
  await adb.openApp(deviceId, pkg);
  await sleep(1400);
  let screen = await screenFor(adb, deviceId, pkg);
  if (!screen) return false;
  let reset = findTikTokResetSettings(screen);
  if (!reset) {
    const settings = button(screen, /^(?:settings|настройки)$/i);
    if (!settings) return false;
    await tapEl(adb, deviceId, settings);
    await sleep(800);
    screen = await screenFor(adb, deviceId, pkg);
    if (!screen) return false;
    reset = findTikTokResetSettings(screen);
  }
  if (!reset) return false;
  await tapEl(adb, deviceId, reset);
  await sleep(800);
  screen = await screenFor(adb, deviceId, pkg);
  if (!screen) return false;
  if (/(?:settings (?:have been )?reset|настройки сброшены)/i.test(labels(screen))) return true;
  const confirm = button(screen, /^(?:reset|confirm|ok|сбросить|подтвердить|ок)$/i);
  if (!confirm || !byLabel(screen, /^(?:reset settings[?]?|сбросить настройки[?]?|сброс настроек)$/i) ||
    !button(screen, /^(?:cancel|отмена)$/i)) return false;
  await tapEl(adb, deviceId, confirm);
  await sleep(800);
  const after = await screenFor(adb, deviceId, pkg);
  return Boolean(after && !button(after, /^(?:cancel|отмена)$/i));
}

export async function runDeviceAccountLogin(
  req: DeviceAccountLoginRequest, adb: AdbClient, packageResolver: PackageResolver, logger: Logger,
): Promise<DeviceAccountLoginResult> {
  const { deviceId, platform, password } = req;
  const username = req.username.replace(/^@+/, '').trim();
  const fail = (detail: string): DeviceAccountLoginResult => ({ ok: false, deviceId, platform, detail });
  const finish = (alreadyLoggedIn = false): DeviceAccountLoginResult =>
    ({ ok: true, deviceId, platform, alreadyLoggedIn, detail: 'Вход подтверждён в собственном профиле' });
  if (!/^[a-z\d._]{1,100}$/i.test(username)) return fail('Укажите @username профиля для проверки входа');

  try {
    const resolved = await packageResolver.resolve(deviceId, platform);
    if (!resolved.installed || !resolved.packageName) return fail(resolved.error || 'Приложение не установлено');
    const pkg = resolved.packageName;
    await adb.wakeUp(deviceId);
    await adb.shell(deviceId, 'wm dismiss-keyguard');
    await adb.openApp(deviceId, pkg);
    await sleep(1600);
    const read = () => screenFor(adb, deviceId, pkg);
    let screen = await read();
    if (!screen) return fail('Не удалось прочитать экран входа');
    if (!confirmedLoggedOut(screen) && !codeField(screen)) {
      if (await verifyOwnProfile(adb, deviceId, pkg, platform, username)) return finish(true);
      screen = await read();
    }
    if (!screen || !confirmedLoggedOut(screen)) {
      return fail('Экран выхода из аккаунта не подтверждён. Проверьте открытый профиль или завершите вход вручную.');
    }
    if (!password) return fail('Укажите пароль для повторного входа');

    let submittedAfter: Date | undefined;
    let sentEmail = false;
    let selectedVerificationMethod = false;
    for (let step = 0; step < 7; step++) {
      if (!screen) return fail('Приложение не показало следующий экран входа');
      const text = labels(screen);
      if (NETWORK.test(text) || BLOCKER.test(text)) return fail('Вход остановлен из-за ошибки сети или запроса проверки на телефоне');
      if (/incorrect password|wrong password|неверный пароль|incorrect code|invalid code|неверный код/i.test(text)) {
        return fail('Приложение отклонило пароль или проверочный код');
      }

      const send = submittedAfter && !sentEmail && EMAIL_CHALLENGE.test(text) &&
        button(screen, /^(?:send code|отправить код|получить код)$/i);
      if (send) {
        sentEmail = true;
        submittedAfter = new Date();
        await tapEl(adb, deviceId, send);
        await sleep(1300);
        screen = await read();
        continue;
      }
      const field = codeField(screen);
      if (field) {
        let code: string;
        const totp = platform === 'instagram' && AUTHENTICATOR.test(text);
        if (totp && req.twoFactorSeed) {
          if (30_000 - Date.now() % 30_000 < 6_000) await sleep(30_000 - Date.now() % 30_000 + 200);
          code = authenticatorCode(req.twoFactorSeed);
        } else if (EMAIL_CHALLENGE.test(text) && submittedAfter) {
          const email = mailboxConfig(req);
          if (!email) return fail('Введите код из письма на плате. Для Outlook подключите IMAP через Microsoft OAuth2.');
          const result = await pollVerificationCode(email, { platform, maxWaitSec: 75, receivedAfter: submittedAfter });
          if (!result.ok || !result.code) return fail(result.error || 'Код не получен. Введите его на плате.');
          code = result.code;
        } else {
          return fail('Приложение запросило подтверждение. Введите код на плате.');
        }
        const current = await read();
        const currentField = current && codeField(current);
        if (!currentField) return fail('Экран ввода кода изменился');
        await submitCode(adb, deviceId, pkg, currentField, code);
        break;
      }

      const fields = editTexts(screen);
      const pass = fields.find((el) => PASSWORD.test(idLabel(el)));
      const login = fields.find((el) => el !== pass && USERNAME.test(idLabel(el))) ??
        (pass && fields.length === 2 ? fields.find((el) => el !== pass) : undefined);
      const submit = button(screen, LOGIN);
      if (pass && login && submit && !submittedAfter) {
        await enterText(adb, deviceId, login, username);
        const updated = await read();
        const passwordField = updated && editTexts(updated).find((el) => PASSWORD.test(idLabel(el)));
        if (!passwordField) return fail('Поле пароля больше не видно');
        await enterText(adb, deviceId, passwordField, password);
        const filled = await read();
        const submitButton = filled && button(filled, LOGIN);
        if (!submitButton) return fail('Кнопка входа недоступна');
        submittedAfter = new Date();
        await tapEl(adb, deviceId, submitButton);
      } else if (!submittedAfter) {
        const next = button(screen, LOGIN_METHOD) ?? submit;
        if (!next) return fail('Форма входа не распознана');
        await tapEl(adb, deviceId, next);
      } else if (!selectedVerificationMethod && /verification method|verify your identity|способ подтверждения|подтвердите личность/i.test(text)) {
        const preferred = platform === 'instagram' && req.twoFactorSeed
          ? /^(?:authentication app|authenticator app|приложение-аутентификатор)$/i
          : /^(?:email|verify by email|email verification|электронная почта|по почте)$/i;
        const method = button(screen, preferred);
        if (!method) break;
        selectedVerificationMethod = true;
        await tapEl(adb, deviceId, method);
      } else {
        break;
      }
      await sleep(1300);
      screen = await read();
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(1400);
      screen = await read();
      if (!screen) continue;
      const later = button(screen, /^(?:not now|не сейчас)$/i);
      if (later && /save (?:your )?login|сохранить данные для входа/i.test(labels(screen))) {
        await tapEl(adb, deviceId, later);
        await sleep(700);
      }
      if (await verifyOwnProfile(adb, deviceId, pkg, platform, username)) return finish();
    }
    return fail('Вход в ожидаемый профиль не подтверждён. Проверьте экран на плате.');
  } catch {
    logger.warn({ deviceId, platform }, 'device-agent: auto-login stopped');
    return fail('Сбой автоматического входа. Проверьте экран на плате.');
  }
}

export interface SubmitVerificationCodeOpts {
  deviceId: string;
  code: string;
  platform?: 'tiktok' | 'instagram';
  username?: string;
}

export async function submitVerificationCodeOnDevice(
  opts: SubmitVerificationCodeOpts, adb: AdbClient, packageResolver: PackageResolver, logger: Logger,
): Promise<{ ok: boolean; detail: string; error?: string }> {
  const { deviceId, platform, username } = opts;
  const code = opts.code.trim().replace(/\s+/g, '');
  if (!platform || !username || !/^\d{4,8}$/.test(code)) {
    return { ok: false, detail: 'Для подтверждения нужны платформа, @username и код из 4–8 цифр' };
  }
  try {
    const resolved = await packageResolver.resolve(deviceId, platform);
    const pkg = resolved.packageName;
    const screen = pkg && await screenFor(adb, deviceId, pkg);
    const field = screen && codeField(screen);
    if (!pkg || !field) return { ok: false, detail: 'Экран ввода кода на плате не найден' };
    await submitCode(adb, deviceId, pkg, field, code);
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(1500);
      if (await verifyOwnProfile(adb, deviceId, pkg, platform, username)) {
        return { ok: true, detail: 'Вход подтверждён в собственном профиле' };
      }
    }
    return { ok: false, detail: 'Код введён. Вход в ожидаемый профиль пока не подтверждён.' };
  } catch {
    logger.warn({ deviceId, platform }, 'device-agent: manual verification stopped');
    return { ok: false, detail: 'Не удалось подтвердить вход на плате' };
  }
}
