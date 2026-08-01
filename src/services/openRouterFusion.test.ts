import test from 'node:test';
import assert from 'node:assert/strict';
import { toOpenRouterBody, OPENROUTER_DEEPSEEK_MODEL, buildDeepSeekTransport } from './deepseekTransport';

// The DeepSeek-native body every fusion call site builds.
const nativeBody = JSON.stringify({
  model: 'deepseek-v4-pro',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
  thinking: { type: 'disabled' },
  temperature: 0.2,
  max_tokens: 4000,
});

test('the model is namespaced for OpenRouter', () => {
  const out = JSON.parse(toOpenRouterBody(nativeBody));
  assert.equal(out.model, OPENROUTER_DEEPSEEK_MODEL);
  assert.equal(OPENROUTER_DEEPSEEK_MODEL, 'deepseek/deepseek-v4-flash-0731');
});

test('DeepSeek-only params do not leak to OpenRouter', () => {
  const out = JSON.parse(toOpenRouterBody(nativeBody));
  // `thinking` is DeepSeek's own parameter; OpenRouter expresses it as
  // `reasoning`. Passing the wrong one silently turns a fast draft into a
  // reasoning run, or gets rejected outright.
  assert.equal(out.thinking, undefined);
  assert.deepEqual(out.reasoning, { enabled: false });
});

test('everything else is passed through untouched', () => {
  const out = JSON.parse(toOpenRouterBody(nativeBody));
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(out.stream, false);
  assert.equal(out.temperature, 0.2);
  assert.equal(out.max_tokens, 4000);
});

test('a body without thinking gains no reasoning key', () => {
  const out = JSON.parse(toOpenRouterBody(JSON.stringify({ model: 'deepseek-v4-pro', messages: [] })));
  assert.equal(out.reasoning, undefined);
  assert.equal(out.model, OPENROUTER_DEEPSEEK_MODEL);
});

test('thinking that is enabled is not silently disabled', () => {
  const out = JSON.parse(toOpenRouterBody(JSON.stringify({
    model: 'deepseek-v4-pro', messages: [], thinking: { type: 'enabled' },
  })));
  assert.equal(out.thinking, undefined, 'the DeepSeek-only key is still removed');
  assert.equal(out.reasoning, undefined, 'but we do not claim reasoning is off');
});

test('malformed input is returned unchanged rather than throwing', () => {
  assert.equal(toOpenRouterBody('not json'), 'not json');
});

test('a direct DeepSeek key always wins over OpenRouter', () => {
  const t = buildDeepSeekTransport('sk-deepseek', 'sk-or-key');
  assert.ok(t);
  assert.equal(t.provider, 'deepseek');
  assert.equal(t.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(t.rewriteBody(nativeBody), nativeBody, 'native body passes through untouched');
});

test('OpenRouter is used only when there is no DeepSeek key', () => {
  const t = buildDeepSeekTransport('', 'sk-or-key', 'https://example.app');
  assert.ok(t);
  assert.equal(t.provider, 'openrouter');
  assert.equal(t.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(t.key, 'sk-or-key');
  assert.equal(t.extraHeaders['HTTP-Referer'], 'https://example.app');
  assert.equal(JSON.parse(t.rewriteBody(nativeBody)).model, OPENROUTER_DEEPSEEK_MODEL);
});

test('whitespace-only keys do not count as configured', () => {
  assert.equal(buildDeepSeekTransport('   ', '  '), null);
  assert.equal(buildDeepSeekTransport('', ''), null);
  // A blank DeepSeek key must fall through to OpenRouter, not disable fusion.
  assert.equal(buildDeepSeekTransport('  ', 'sk-or-key')?.provider, 'openrouter');
});
