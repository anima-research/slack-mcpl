/** Test-only wrapper observes the real entry's connectSlack argument before delegation. */
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (!/\/src\/index\.(?:ts|js)(?:\?|$)/.test(context.parentURL ?? '') || !/\/slack-adapter\.(?:ts|js)(?:\?|$)/.test(specifier)) return resolved;
  const source = `
    import assert from 'node:assert/strict';
    import { connectSlack as realConnectSlack } from ${JSON.stringify(resolved.url)};
    export async function connectSlack(config) {
      assert.ok(config.accessPolicy);
      assert.deepEqual(config.dmUsers, ['UOTHER']);
      assert.deepEqual(config.sendChannels, ['COTHER']);
      assert.equal(config.disableDms, true);
      console.error('A4_ENTRY_INTERSECTION');
      return realConnectSlack(config);
    }
  `;
  return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
}
