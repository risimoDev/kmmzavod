import { ok, strictEqual } from 'node:assert';
import axios from 'axios';
import pino from 'pino';
import { extractJsonFromText, consultAiAutopilot, type AiAutopilotInput } from '../src/ai-autopilot';
import type { UiScreen } from '../src/ui-automation';
import { initialFlowState } from '../src/publish-flow';

const logger = pino({ level: 'silent' });

async function runTests() {
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
          pkg: 'com.zhiliaoapp.musically',
          focused: false,
          parent: null,
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
      apiKey: 'change_me',
      logger,
    };

    strictEqual(await consultAiAutopilot(input), null, 'returns null when apiKey is unconfigured');

    const originalAdapter = axios.defaults.adapter;
    axios.defaults.adapter = async (config) => ({
      config, headers: {}, status: 200, statusText: 'OK',
      data: { choices: [{ message: { content: '{"screenType":"compose","action":"tap","targetText":"Save to drafts"}' } }] },
    });
    try {
      const decision = await consultAiAutopilot({ ...input, apiKey: 'test-key' });
      strictEqual(decision?.action, 'require_human', 'a model cannot choose to save the current video as a draft');
      let checked = 0;
      axios.defaults.adapter = async (request) => ({
        config: request, headers: {}, status: 200, statusText: 'OK',
        data: { choices: [{ message: { content: JSON.stringify(++checked === 1
          ? { screenType: 'modal_dialog', action: 'tap', targetText: ['Not now'] }
          : { screenType: 'modal_dialog', action: 'tap', targetText: 'Not now', marks: null }) } }] },
      });
      const safeDecision = await consultAiAutopilot({ ...input, apiKey: 'test-key' });
      strictEqual(checked, 2, 'an invalid reply is rejected and the backup model is tried');
      strictEqual(safeDecision?.targetText, 'Not now');
      strictEqual(safeDecision?.marks, undefined);
    } finally {
      axios.defaults.adapter = originalAdapter;
    }
  }

  console.log('PASS: All basic ai-autopilot tests passed');
}

runTests().catch((err) => { console.error(err); process.exitCode = 1; });
