/** Exercise connectSlack's actual SDK construction; no network or real tokens. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {WebClient} from '@slack/web-api';
import {connectSlack} from '../src/slack-adapter.js';

test('production tool-read SDK wiring aborts HTTP and never retries the cancelled request', async t => {
  const original = WebClient.prototype.apiCall;
  let requests = 0, aborted = false;
  t.mock.method(WebClient.prototype, 'apiCall', async function(this: WebClient, method: string, args?: Record<string, unknown>) {
    if (method === 'auth.test') return {ok: true, user_id: 'UBOT', team: 'fixture'};
    assert.ok(['conversations.info', 'conversations.history', 'conversations.replies'].includes(method));
    assert.equal((this as any).retryConfig.retries, 0);
    assert.equal((this as any).rejectRateLimitedCalls, true);
    // Axios is private SDK machinery, deliberately accessed only in this test
    // to replace the network while retaining the real interceptors/retry path.
    (this as any).axios.defaults.adapter = async (config: any) => {
      requests++;
      if (method === 'conversations.info') return {data: {ok: true, channel: {id: 'C1'}}, status: 200, statusText: 'OK', headers: {}, config, request: {path: '/api/conversations.info'}};
      assert.ok(config.signal, 'production request interceptor must attach the deadline signal');
      return new Promise((_, reject) => config.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('synthetic cancellation'));
      }, {once: true}));
    };
    return original.call(this, method, args);
  });
  const adapter = await connectSlack({botToken: 'synthetic', appToken: 'synthetic'});
  t.after(() => adapter.stop());
  const output = await adapter.readHistory('C1', {maxMs: 100});
  assert.equal(output.pagination.stopReason, 'time_limit');
  assert.equal(aborted, true);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(requests, 2, 'only metadata + one history request; no delayed SDK retry');
});

test('production tool-read SDK refuses HTTP429 without sleeping or retrying', async t => {
  const original = WebClient.prototype.apiCall;
  let requests = 0;
  t.mock.method(WebClient.prototype, 'apiCall', async function(this: WebClient, method: string, args?: Record<string, unknown>) {
    if (method === 'auth.test') return {ok: true, user_id: 'UBOT', team: 'fixture'};
    assert.ok(['conversations.info', 'conversations.history', 'conversations.replies'].includes(method));
    assert.equal((this as any).retryConfig.retries, 0);
    assert.equal((this as any).rejectRateLimitedCalls, true);
    (this as any).axios.defaults.adapter = async (config: any) => {
      requests++;
      return {data: {ok: false, error: 'ratelimited'}, status: 429, statusText: 'Too Many Requests', headers: {'retry-after': '60'}, config};
    };
    return original.call(this, method, args);
  });
  const adapter = await connectSlack({botToken: 'synthetic', appToken: 'synthetic'});
  t.after(() => adapter.stop());
  const output = await adapter.readHistory('C1', {});
  assert.equal(output.pagination.stopReason, 'rate_limited');
  assert.equal(output.pagination.retryAfterSeconds, 60);
  assert.equal(requests, 1);
});
