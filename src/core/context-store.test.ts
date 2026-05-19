import { describe, it, expect } from 'vitest';
import { ContextStore } from './context-store.js';

describe('ContextStore', () => {
  it('starts at 0% usage', () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    expect(store.getUsagePercent()).toBe(0);
    expect(store.getTurnCount()).toBe(0);
  });

  it('accumulates input tokens from assistant messages', () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    store.addUserMessage('hello');
    store.addAssistantMessage('hi there', { inputTokens: 10_000, outputTokens: 20 });
    expect(store.getUsagePercent()).toBe(5); // 10000 / 200000 * 100
  });

  it('sets nearLimit flag at warning threshold', () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    store.addUserMessage('x');
    store.addAssistantMessage('y', { inputTokens: 181_000, outputTokens: 0 }); // 90.5%
    const snap = store.getSnapshot();
    expect(snap.nearLimit).toBe(true);
    expect(snap.overLimit).toBe(false);
  });

  it('sets overLimit flag at auto-prompt threshold', () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    store.addUserMessage('x');
    store.addAssistantMessage('y', { inputTokens: 196_001, outputTokens: 0 }); // >98%
    const snap = store.getSnapshot();
    expect(snap.nearLimit).toBe(true);
    expect(snap.overLimit).toBe(true);
  });

  it('includes system message in getMessages()', () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'be helpful');
    const msgs = store.getMessages();
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toBe('be helpful');
  });

  it('counts turns correctly', () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 's');
    store.addUserMessage('a');
    store.addAssistantMessage('b', { inputTokens: 100, outputTokens: 5 });
    store.addUserMessage('c');
    store.addAssistantMessage('d', { inputTokens: 200, outputTokens: 5 });
    expect(store.getTurnCount()).toBe(2);
  });
});
