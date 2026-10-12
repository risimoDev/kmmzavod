import { detectImapHost, extractVerificationCode } from '../src/imap-client';

const ok = (c: boolean, m: string) => console.log(c ? 'PASS' : 'FAIL', m);

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

console.log('All IMAP tests completed successfully!');
