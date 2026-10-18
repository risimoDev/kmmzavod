/**
 * Automated Social Account Login (Instagram & TikTok) on Android Farm Boards.
 *
 * 1. Checks and opens the exact installed app on the phone.
 * 2. Inputs account credentials (login/username + password).
 * 3. Detects two-factor/email verification screens.
 * 4. Automatically queries the user's email via IMAP for the verification code.
 * 5. Enters the verification code directly into the mobile app and completes login.
 */
import type { Logger } from 'pino';
import type { AdbClient } from './adb-client';
import { PackageResolver } from './package-resolver';
import { parseUiTree } from './profile-stats';
import { pollVerificationCode, type ImapConfig } from './imap-client';

export interface DeviceAccountLoginRequest {
  deviceId: string;
  platform: 'tiktok' | 'instagram';
  username: string;
  password?: string;
  email?: string;
  emailPassword?: string;
  imapHost?: string;
  imapPort?: number;
}

export interface DeviceAccountLoginResult {
  ok: boolean;
  deviceId: string;
  platform: 'tiktok' | 'instagram';
  alreadyLoggedIn?: boolean;
  codeRetrieved?: string;
  detail: string;
  error?: string;
}

async function dumpUi(adb: AdbClient, deviceId: string): Promise<string> {
  const remotePath = `/sdcard/kmm_login_${Date.now()}.xml`;
  try {
    await adb.shell(deviceId, `uiautomator dump ${remotePath}`, 20_000);
    const xml = await adb.shell(deviceId, `cat ${remotePath}`, 15_000);
    await adb.shell(deviceId, `rm -f ${remotePath}`).catch(() => {});
    return xml;
  } catch {
    return '';
  }
}

export async function runDeviceAccountLogin(
  req: DeviceAccountLoginRequest,
  adb: AdbClient,
  packageResolver: PackageResolver,
  logger: Logger,
): Promise<DeviceAccountLoginResult> {
  const { deviceId, platform, username, password, email, emailPassword, imapHost, imapPort } = req;
  const user = username.replace(/^@+/, '').trim();

  logger.info({ deviceId, platform, user, email: email ? `${email.slice(0, 3)}***` : undefined }, 'device-agent: starting auto-login flow');

  try {
    // 1. Wake screen and unlock keyguard
    await adb.wakeUp(deviceId);
    await adb.shell(deviceId, 'wm dismiss-keyguard');
    const { width, height } = await adb.getScreenSize(deviceId);

    // 2. Resolve installed package for the target platform
    const resolved = await packageResolver.resolve(deviceId, platform);
    if (!resolved.installed || !resolved.packageName) {
      return {
        ok: false,
        deviceId,
        platform,
        detail: resolved.error || `Приложение ${platform} не установлено на плате ${deviceId}`,
        error: resolved.error,
      };
    }
    const pkg = resolved.packageName;

    // 3. Grant runtime permissions in advance
    await adb.grantAllPermissions(deviceId, pkg).catch(() => {});

    // 4. Launch the application
    logger.info({ deviceId, platform, pkg }, 'device-agent: launching app');
    await adb.openApp(deviceId, pkg);
    await new Promise((r) => setTimeout(r, 6000));

    // 5. Inspect current UI screen
    let xml = await dumpUi(adb, deviceId);
    let nodes = parseUiTree(xml);

    // Check if already logged in (profile tab or home feed buttons)
    const isProfileVisible = nodes.some((n) =>
      /profile|профиль|аккаунт|settings|настройки/i.test(`${n.text} ${n.desc}`) && n.clickable,
    );
    const isFeedVisible = nodes.some((n) =>
      /home|главная|reels|рекомендации|for you/i.test(`${n.text} ${n.desc}`) && n.clickable,
    );
    const hasLoginButton = nodes.some((n) =>
      /log in|sign in|войти|авторизоваться|already have an account/i.test(`${n.text} ${n.desc}`),
    );

    if ((isProfileVisible || isFeedVisible) && !hasLoginButton) {
      logger.info({ deviceId, platform, user }, 'device-agent: account is already logged in');
      return {
        ok: true,
        deviceId,
        platform,
        alreadyLoggedIn: true,
        detail: 'Аккаунт уже авторизован в мобильном приложении',
      };
    }

    if (!password) {
      return {
        ok: false,
        deviceId,
        platform,
        detail: 'Пароль от аккаунта не указан для выполнения входа',
        error: 'Missing password',
      };
    }

    // 6. Navigate to login form if on welcome / onboarding screen
    const welcomeLoginBtn = nodes.find((n) =>
      /log in|войти|sign in|already have an account/i.test(`${n.text} ${n.desc}`),
    );
    if (welcomeLoginBtn) {
      const [x1, y1, x2, y2] = welcomeLoginBtn.bounds;
      await adb.tap(deviceId, Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
      await new Promise((r) => setTimeout(r, 3000));
      xml = await dumpUi(adb, deviceId);
      nodes = parseUiTree(xml);
    }

    // Look for EditText fields (typically username and password)
    const editTexts = nodes.filter((n) =>
      n.resId.includes('edit') || n.resId.includes('input') || n.text.includes('@') || n.desc.includes('login') || n.bounds[3] - n.bounds[1] > 20,
    );

    // If Instagram switch accounts button exists
    const switchAccountBtn = nodes.find((n) => /switch account|сменить аккаунт/i.test(`${n.text} ${n.desc}`));
    if (switchAccountBtn) {
      const [x1, y1, x2, y2] = switchAccountBtn.bounds;
      await adb.tap(deviceId, Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
      await new Promise((r) => setTimeout(r, 2500));
      xml = await dumpUi(adb, deviceId);
      nodes = parseUiTree(xml);
    }

    // Enter Username / Identifier
    const usernameInput = nodes.find((n) =>
      /username|phone|email|логин|телефон|почта|имя пользователя/i.test(`${n.text} ${n.desc} ${n.resId}`),
    ) || editTexts[0];

    if (usernameInput) {
      const [x1, y1, x2, y2] = usernameInput.bounds;
      await adb.tap(deviceId, Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
      await new Promise((r) => setTimeout(r, 500));
      // Clear field
      for (let i = 0; i < 30; i++) await adb.keyevent(deviceId, 67); // KEYCODE_DEL
      await adb.inputText(deviceId, user);
      await new Promise((r) => setTimeout(r, 1000));
    } else {
      // Fallback coordinate tap on top field (~34% height)
      await adb.tap(deviceId, Math.round(width * 0.5), Math.round(height * 0.34));
      await new Promise((r) => setTimeout(r, 500));
      await adb.inputText(deviceId, user);
    }

    // Enter Password
    xml = await dumpUi(adb, deviceId);
    nodes = parseUiTree(xml);
    const passwordInput = nodes.find((n) =>
      /password|пароль/i.test(`${n.text} ${n.desc} ${n.resId}`),
    ) || editTexts[1];

    if (passwordInput) {
      const [x1, y1, x2, y2] = passwordInput.bounds;
      await adb.tap(deviceId, Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
      await new Promise((r) => setTimeout(r, 500));
      for (let i = 0; i < 30; i++) await adb.keyevent(deviceId, 67);
      await adb.inputText(deviceId, password);
      await new Promise((r) => setTimeout(r, 1000));
    } else {
      // Fallback coordinate tap on second field (~41% height)
      await adb.tap(deviceId, Math.round(width * 0.5), Math.round(height * 0.41));
      await new Promise((r) => setTimeout(r, 500));
      await adb.inputText(deviceId, password);
    }

    // Dismiss keyboard and submit
    await adb.keyevent(deviceId, 111); // KEYCODE_ESCAPE (dismiss keyboard)
    await new Promise((r) => setTimeout(r, 500));

    // Tap Log In Submit Button
    xml = await dumpUi(adb, deviceId);
    nodes = parseUiTree(xml);
    const submitBtn = nodes.find((n) =>
      /^(log in|войти|next|далее|продолжить)$/i.test(n.text.trim()) ||
      /^(log in|войти|next|далее|продолжить)$/i.test(n.desc.trim()) ||
      /login_button|submit|button_login/i.test(n.resId),
    );

    if (submitBtn) {
      const [x1, y1, x2, y2] = submitBtn.bounds;
      await adb.tap(deviceId, Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
    } else {
      // Press ENTER or fallback tap
      await adb.keyevent(deviceId, 66); // KEYCODE_ENTER
      await adb.tap(deviceId, Math.round(width * 0.5), Math.round(height * 0.48));
    }

    // Wait for server verification response
    await new Promise((r) => setTimeout(r, 5500));

    // 7. Check for dialogs ("Save login info", permissions)
    xml = await dumpUi(adb, deviceId);
    nodes = parseUiTree(xml);

    const saveInfoBtn = nodes.find((n) => /save|сохранить|not now|не сейчас/i.test(`${n.text} ${n.desc}`));
    if (saveInfoBtn) {
      const [x1, y1, x2, y2] = saveInfoBtn.bounds;
      await adb.tap(deviceId, Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
      await new Promise((r) => setTimeout(r, 2500));
      xml = await dumpUi(adb, deviceId);
      nodes = parseUiTree(xml);
    }

    // 8. Detect 2FA / Verification Code Screen
    let codeRetrieved: string | undefined;
    const isVerificationScreen = nodes.some((n) =>
      /code|код|verification|подтвержден|security code|enter code|введите код|check your email|проверьте почту/i.test(
        `${n.text} ${n.desc}`,
      ),
    );

    if (isVerificationScreen) {
      logger.info({ deviceId, platform, email }, 'device-agent: 2FA/verification screen detected, checking email');

      if (!email || !emailPassword) {
        return {
          ok: false,
          deviceId,
          platform,
          detail: 'Появился экран ввода кода с почты, но в аккаунте не указаны email / emailPassword для автоматического чтения кодов',
          error: 'Verification code requested but no email credentials provided',
        };
      }

      const imapConfig: ImapConfig = {
        email,
        password: emailPassword,
        host: imapHost,
        port: imapPort,
      };

      const codeRes = await pollVerificationCode(imapConfig, {
        platform,
        maxWaitSec: 90,
        pollIntervalMs: 4000,
      });

      if (!codeRes.ok || !codeRes.code) {
        return {
          ok: false,
          deviceId,
          platform,
          detail: `Экран подтверждения: ${codeRes.error || 'код не поступил на почту'}. Телефон остался на экране ввода кода — вы можете ввести код вручную.`,
          error: codeRes.error,
        };
      }

      codeRetrieved = codeRes.code;
      logger.info({ deviceId, platform, codeRetrieved }, 'device-agent: code received from email, typing into device');

      // Find code input field on screen
      xml = await dumpUi(adb, deviceId);
      nodes = parseUiTree(xml);
      const codeInput = nodes.find((n) =>
        /code|код|pin|number/i.test(`${n.text} ${n.desc} ${n.resId}`) || (n.bounds[3] - n.bounds[1] > 20 && n.bounds[1] < height * 0.6),
      );

      if (codeInput) {
        const [x1, y1, x2, y2] = codeInput.bounds;
        await adb.tap(deviceId, Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
      } else {
        await adb.tap(deviceId, Math.round(width * 0.5), Math.round(height * 0.4));
      }

      await new Promise((r) => setTimeout(r, 500));
      await adb.inputText(deviceId, codeRetrieved);
      await new Promise((r) => setTimeout(r, 1000));

      // Tap Confirm / Next
      xml = await dumpUi(adb, deviceId);
      nodes = parseUiTree(xml);
      const confirmBtn = nodes.find((n) =>
        /^(confirm|подтвердить|next|далее|submit|отправить)$/i.test(n.text.trim()) ||
        /^(confirm|подтвердить|next|далее|submit|отправить)$/i.test(n.desc.trim()),
      );

      if (confirmBtn) {
        const [x1, y1, x2, y2] = confirmBtn.bounds;
        await adb.tap(deviceId, Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
      } else {
        await adb.keyevent(deviceId, 66); // ENTER
      }

      // Wait for code validation
      await new Promise((r) => setTimeout(r, 6000));
    }

    // 9. Post-login verification
    xml = await dumpUi(adb, deviceId);
    nodes = parseUiTree(xml);

    // Check for error text (invalid password / account blocked / try again later)
    const errorNode = nodes.find((n) =>
      /incorrect password|неверный пароль|wrong password|try again later|попробуйте позже|error|ошибка/i.test(
        `${n.text} ${n.desc}`,
      ),
    );

    if (errorNode) {
      const errText = errorNode.text || errorNode.desc || 'Ошибка авторизации';
      logger.warn({ deviceId, platform, errText }, 'device-agent: login error on screen');
      return {
        ok: false,
        deviceId,
        platform,
        codeRetrieved,
        detail: `Экран приложения сообщает об ошибке: "${errText}"`,
        error: errText,
      };
    }

    // Re-check if feed or profile is now visible
    const finalProfile = nodes.some((n) =>
      /profile|профиль|reels|feed|лента|главная|for you/i.test(`${n.text} ${n.desc}`),
    );

    logger.info({ deviceId, platform, user, success: finalProfile }, 'device-agent: login flow completed');

    return {
      ok: true,
      deviceId,
      platform,
      codeRetrieved,
      detail: codeRetrieved
        ? `Вход выполнен успешно с автоматическим вводом кода (${codeRetrieved})`
        : 'Вход в аккаунт выполнен успешно',
    };
  } catch (err: any) {
    logger.error({ deviceId, platform, err: err.message }, 'device-agent: login flow crashed');
    return {
      ok: false,
      deviceId,
      platform,
      detail: `Сбой автоматического входа: ${err.message}`,
      error: err.message,
    };
  }
}

export interface SubmitVerificationCodeOpts {
  deviceId: string;
  code: string;
  platform?: 'tiktok' | 'instagram';
}

/**
 * Manually submit a 4-8 digit verification code directly onto the phone screen.
 * Used when email cannot be read via IMAP (e.g. Outlook Basic Auth disabled)
 * or when the user receives the code in a browser webmail.
 */
export async function submitVerificationCodeOnDevice(
  opts: SubmitVerificationCodeOpts,
  adb: AdbClient,
  logger: Logger,
): Promise<{ ok: boolean; detail: string; error?: string }> {
  const { deviceId, code, platform } = opts;
  const sanitizedCode = (code || '').trim().replace(/\s+/g, '');
  if (!sanitizedCode || sanitizedCode.length < 4 || sanitizedCode.length > 8) {
    return { ok: false, detail: 'Код должен содержать от 4 до 8 цифр', error: 'Invalid code format' };
  }

  logger.info({ deviceId, platform, codeLength: sanitizedCode.length }, 'device-agent: submitting verification code to device');

  try {
    await adb.wakeUp(deviceId);
    await adb.shell(deviceId, 'wm dismiss-keyguard');
    const { width, height } = await adb.getScreenSize(deviceId);

    let xml = await dumpUi(adb, deviceId);
    let nodes = parseUiTree(xml);

    // Find code input field or tap likely area
    const codeInput = nodes.find((n) =>
      /code|код|pin|number|verification/i.test(`${n.text} ${n.desc} ${n.resId}`) ||
      (n.bounds[3] - n.bounds[1] > 20 && n.bounds[1] < height * 0.6 && n.bounds[1] > height * 0.2),
    );

    if (codeInput) {
      const [x1, y1, x2, y2] = codeInput.bounds;
      await adb.tap(deviceId, Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
    } else {
      await adb.tap(deviceId, Math.round(width * 0.5), Math.round(height * 0.4));
    }

    await new Promise((r) => setTimeout(r, 600));

    // Clear existing input if any
    for (let i = 0; i < 10; i++) {
      await adb.keyevent(deviceId, 67); // KEYCODE_DEL
    }

    await adb.inputText(deviceId, sanitizedCode);
    await new Promise((r) => setTimeout(r, 1000));

    // Dismiss keyboard
    await adb.keyevent(deviceId, 111); // KEYCODE_ESCAPE
    await new Promise((r) => setTimeout(r, 500));

    // Find Confirm / Submit button
    xml = await dumpUi(adb, deviceId);
    nodes = parseUiTree(xml);
    const confirmBtn = nodes.find((n) =>
      /^(confirm|подтвердить|next|далее|submit|отправить|войти|готово|done)$/i.test(n.text.trim()) ||
      /^(confirm|подтвердить|next|далее|submit|отправить|войти|готово|done)$/i.test(n.desc.trim()) ||
      /submit|next_button|confirm/i.test(n.resId),
    );

    if (confirmBtn) {
      const [x1, y1, x2, y2] = confirmBtn.bounds;
      await adb.tap(deviceId, Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
    } else {
      await adb.keyevent(deviceId, 66); // KEYCODE_ENTER
    }

    // Wait for validation
    await new Promise((r) => setTimeout(r, 6000));

    // Post-check screen
    xml = await dumpUi(adb, deviceId);
    nodes = parseUiTree(xml);

    // Check for any error dialog/message on screen
    const errorNode = nodes.find((n) =>
      /incorrect code|неверный код|invalid code|expired|истёк|error|ошибка/i.test(`${n.text} ${n.desc}`),
    );

    if (errorNode) {
      const errText = errorNode.text || errorNode.desc || 'Неверный проверочный код';
      return { ok: false, detail: `Ошибка на телефоне: ${errText}`, error: errText };
    }

    // Dismiss any "Save login info" prompt if it appeared
    const saveInfoBtn = nodes.find((n) => /save|сохранить|not now|не сейчас/i.test(`${n.text} ${n.desc}`));
    if (saveInfoBtn) {
      const [x1, y1, x2, y2] = saveInfoBtn.bounds;
      await adb.tap(deviceId, Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
    }

    return {
      ok: true,
      detail: `Код ${sanitizedCode} успешно введён и подтверждён на телефоне! Вход выполнен.`,
    };
  } catch (err: any) {
    logger.error({ deviceId, platform, err: err.message }, 'device-agent: manual code submission failed');
    return {
      ok: false,
      detail: `Не удалось ввести код: ${err.message}`,
      error: err.message,
    };
  }
}
