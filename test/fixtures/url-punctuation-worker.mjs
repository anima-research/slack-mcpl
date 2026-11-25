import { parentPort } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';
const { renderMessageText } = await tsImport('../../src/message-text.ts', import.meta.url);
parentPort.once('message', size => {
  const text = 'http://a' + '.'.repeat(size) + 'x';
  const result = renderMessageText({text, attachments: [{is_app_unfurl: true, text: 'PREVIEW'}]});
  parentPort.postMessage(result === text ? 'done' : 'wrong output');
});
parentPort.postMessage('ready');
