import assert from 'node:assert/strict';
import { detectImapHost, extractVerificationCode, formatImapError, isRecentVerificationMessage } from '../src/imap-client';

const ok = (c: boolean, m: string) => { assert.ok(c, m); console.log('PASS', m); };

// 1. Host detection
ok(detectImapHost('test@mail.ru').host === 'imap.mail.ru', 'mail.ru detected');
ok(detectImapHost('user@yandex.ru').host === 'imap.yandex.ru', 'yandex.ru detected');
ok(detectImapHost('user@gmail.com').host === 'imap.gmail.com', 'gmail.com detected');
ok(detectImapHost('user@rambler.ru').host === 'imap.rambler.ru', 'rambler.ru detected');
ok(detectImapHost('user@outlook.com').host === 'outlook.office365.com', 'outlook.com detected');
ok(detectImapHost('user@customdomain.io').host === 'imap.customdomain.io', 'custom domain fallback');

// 2. Code extraction - Instagram
const igEmail1 = `
From: security@mail.instagram.com
Subject: 582 194 is your Instagram code
Hi user, someone tried to log in to your Instagram account. Here is your security code: 582194
`;
ok(extractVerificationCode(igEmail1, 'instagram') === '582194' || extractVerificationCode(igEmail1, 'instagram') === '582194', `Instagram code: ${extractVerificationCode(igEmail1, 'instagram')}`);

const igEmail2 = `
From: Instagram <no-reply@mail.instagram.com>
Subject: Код подтверждения Instagram
Ваш проверочный код: 719302. Введите его в приложении.
`;
ok(extractVerificationCode(igEmail2, 'instagram') === '719302', `Instagram RU code: ${extractVerificationCode(igEmail2, 'instagram')}`);

// 3. Code extraction - TikTok
const ttEmail1 = `
From: TikTok <no-reply@account.tiktok.com>
Subject: [TikTok] 940128 is your verification code
Use this code to verify your TikTok identity: 940128. Valid for 10 minutes.
`;
ok(extractVerificationCode(ttEmail1, 'tiktok') === '940128', `TikTok code: ${extractVerificationCode(ttEmail1, 'tiktok')}`);

const ttEmail2 = `
From: TikTok <no-reply@account.tiktok.com>
Subject: Verification Code
Код подтверждения для входа в аккаунт: 381920
`;
ok(extractVerificationCode(ttEmail2, 'tiktok') === '381920', `TikTok RU code: ${extractVerificationCode(ttEmail2, 'tiktok')}`);

// 4. Error formatting and permanent auth detection
const outlookErr = formatImapError('IMAP Error: Basic authentication is disabled.', 'lisaschrempf976239@outlook.com', 'outlook.office365.com');
ok(outlookErr.isPermanentAuth === true, 'Outlook basic auth disabled detected as permanent');
ok(outlookErr.message.includes('OAuth2'), 'Outlook message explains the OAuth2 requirement');

const mailruErr = formatImapError('IMAP Error: [AUTHENTICATIONFAILED] Invalid credentials', 'bot@mail.ru', 'imap.mail.ru');
ok(mailruErr.isPermanentAuth === true, 'Mail.ru invalid credentials detected as permanent');
ok(mailruErr.message.includes('Пароль для внешних приложений'), 'Mail.ru message contains external app password advice');

const requested = new Date('2026-11-28T12:30:00.300Z');
const message = (time: string, from: string) => `* 7 FETCH (UID 44 INTERNALDATE "28-Nov-2026 ${time} +0000" BODY[HEADER.FIELDS...] {40}\r\nFrom: ${from}\r\n)`;
ok(isRecentVerificationMessage(message('12:30:00', 'TikTok <no-reply@account.tiktok.com>'), 'tiktok', requested), 'accepts fresh TikTok mail at IMAP second precision');
ok(!isRecentVerificationMessage(message('12:29:59', 'no-reply@account.tiktok.com'), 'tiktok', requested), 'rejects stale mail');
ok(!isRecentVerificationMessage(message('12:30:04', '"tiktok.com" <no-reply@tiktok.com.example>'), 'tiktok', requested), 'rejects unrelated sender domains');
ok(!isRecentVerificationMessage(message('12:30:04', 'no-reply@mail.instagram.com'), 'tiktok', requested), 'rejects codes for another platform');
ok(extractVerificationCode('Your receipt #123456', 'tiktok', true) === null, 'ignores an unrelated six-digit number in automatic mode');
ok(extractVerificationCode('[TikTok] 940128 is your verification code', 'tiktok', true) === '940128', 'finds a marked login code');
