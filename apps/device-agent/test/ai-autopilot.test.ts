import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import pino from 'pino';
import { extractJsonFromText, consultAiAutopilot, type AiAutopilotInput } from '../src/ai-autopilot';
import type { UiScreen } from '../src/ui-automation';
import { initialFlowState } from '../src/publish-flow';

const logger = pino({ level: 'silent' });

function runTests() {
  console.log('Testing ai-autopilot...');

  // 1. Test extractJsonFromText
  {
    const pure = extractJsonFromText<{ action: string }>('{"action": "tap", "targetText": "Next"}');
    ok(pure !== null, 'pure JSON parsed');
    strictEqual(pure?.action, 'tap');

    const md = extractJsonFromText<{ action: string }>(
      '```json\n{\n  "action": "key_back",\n  "reason": "Закрыл баннер"\n}\n```'
    );
    ok(md !== null, 'markdown JSON parsed');
    strictEqual(md?.action, 'key_back');

    const mixed = extractJsonFromText<{ action: string }>(
      'Я рекомендую следующее действие:\n{"action": "abort", "reason": "Капча-пазл"}\nУдачи!'
    );
    ok(mixed !== null, 'mixed text with JSON parsed');
    strictEqual(mixed?.action, 'abort');

    const invalid = extractJsonFromText('не является json');
    strictEqual(invalid, null, 'invalid text returns null');
  }

  // 2. Test consultAiAutopilot without API key returns null safely
  {
    const dummyScreen: UiScreen = {
      pkg: 'com.zhiliaoapp.musically',
      xml: '<hierarchy></hierarchy>',
      els: [
        {
          cls: 'android.widget.Button',
          text: 'Не сейчас',
          desc: '',
          resId: 'com.zhiliaoapp.musically:id/close',
          bounds: [100, 200, 300, 250],
          clickable: true,
          enabled: true,
        },
      ],
    };

    const input: AiAutopilotInput = {
      platform: 'tiktok',
      deviceId: 'dummy-serial',
      stage: 'compose',
      st: initialFlowState(),
      hasCaption: false,
      screen: dummyScreen,
      screenSize: { width: 1080, height: 2400 },
      apiKey: '', // Empty key
      logger,
    };

    consultAiAutopilot(input).then((decision) => {
      strictEqual(decision, null, 'returns null when apiKey is empty');
      console.log('PASS: Empty API key handled gracefully');
    });
  }

  console.log('PASS: All basic ai-autopilot tests passed');
}

runTests();
