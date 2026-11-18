import { SlackAccessDenied } from '../src/access-policy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { accessFixture, joined } from './adapterAccessFixture.js';
import { fetchSlackHistory } from '../src/content.js';
import { paginationLimits } from '../src/pagination.js';
import { startupSettings } from '../src/config.js';

function fixture(legacy: boolean, pages = 2) {
  return accessFixture({ legacy, pagination: { conversations: pages, users: pages, backscroll: pages } });
}
const ceiling = (end = 99) => {
  let n = 0;
  return { get n() { return n; }, next() { assert.ok(++n <= 5, 'emergency request ceiling'); return { next_cursor: n < end ? String(n) : '' }; } };
};
for (const legacy of [true, false]) {
  for (const kind of ['empty', 'unjoined', 'denied', 'joined'] as const) test(`bounded listing ${legacy} ${kind}`, async () => {
    const f = fixture(legacy); const c = ceiling();
    f.web.conversations.list = async () => ({ channels: kind === 'empty' ? [] : [{ ...joined(), is_member: kind !== 'unjoined' }], response_metadata: c.next() });
    if (kind === 'denied') f.state.infoError = new SlackAccessDenied('denied');
    const result = await f.adapter.listConversations() as any;
    assert.equal(c.n, 2); assert.deepEqual(result.truncation, { reason: 'page_limit', pages: 2, limit: 2 });
    if (kind === 'empty' || kind === 'unjoined' || (kind === 'denied' && !legacy)) assert.equal(result.conversations.length, 0);
    else assert.ok(result.conversations.length > 0);
  });
  for (const end of [1, 2, 3]) test(`listing boundary ${legacy} ${end}`, async () => {
    const f = fixture(legacy); const c = ceiling(end);
    f.web.conversations.list = async () => ({ channels: [], response_metadata: c.next() });
    const result = await f.adapter.listConversations() as any;
    assert.equal(c.n, Math.min(end, 2)); assert.equal(!!result.truncation, end > 2);
  });
  test(`bounded absent directory ${legacy}`, async () => {
    const f = fixture(legacy); const c = ceiling();
    f.web.users.list = async () => ({ members: [{ id:'U1', name:'other', deleted:true }, { id:'U2', name:'other', is_bot:true }], response_metadata:c.next() });
    assert.deepEqual(await f.adapter.findUsers('absent'), { matches:[], truncated:true, reason:'page_limit', pages:2, limit:2 });
    assert.equal(c.n,2);
  });
  for (const more of [true, false]) test(`directory existing match cap ${legacy} ${more}`, async () => {
    const f=fixture(legacy); let calls=0;
    f.web.users.list=async()=>{assert.equal(++calls,1); return { members:Array.from({length:more?26:25},(_,i)=>({id:`U${i}`,name:'match'})) };};
    const result:any=await f.adapter.findUsers('match');
    if (more) {assert.equal(result.truncated,true);assert.equal(result.reason,'match_limit');assert.equal(result.matches.length,25);}
    else {assert.ok(Array.isArray(result));assert.equal(result.length,25);}
  });
  test(`cycles win on page boundary ${legacy}`, async () => {
    const f=fixture(legacy);let n=0;
    f.web.conversations.list=async()=>{assert.ok(++n<=3);return {channels:[],response_metadata:{next_cursor:'same'}};};
    if (legacy) assert.equal((await f.adapter.listConversations()).truncation?.reason, 'page_limit');
    else await assert.rejects(f.adapter.listConversations(),/cursor cycle/);assert.equal(n,2);
    n=0;f.web.users.list=async()=>{assert.ok(++n<=3);return {members:[],response_metadata:{next_cursor:'same'}};};
    if (legacy) assert.equal((await f.adapter.findUsers('absent') as any).reason, 'page_limit');
    else await assert.rejects(f.adapter.findUsers('absent'),/cursor cycle/);assert.equal(n,2);
  });
  test(`backscroll adapter receives configuration ${legacy}`,async()=>{
    const f=fixture(legacy);const c=ceiling();
    f.web.conversations.history=async()=>({messages:[],response_metadata:c.next()});
    assert.deepEqual(await f.adapter.fetchHistory('C1'),{messages:[],truncated:true,stopReason:'page_limit'});assert.equal(c.n,2);
  });
}
for (const end of [1,2,3]) test(`helper empty-page boundary ${end}`,async()=>{
 const c=ceiling(end);
 const result=await fetchSlackHistory({conversations:{history:async()=>({messages:[],response_metadata:c.next()})}},
  {channel:'C1',maxMessages:100,maxPages:2} as any);
 assert.deepEqual(result,{messages:[],truncated:end>2,...(end>2?{stopReason:'page_limit'}:{})});assert.equal(c.n,Math.min(end,2));
});
test('helper cycle wins on page cap',async()=>{
 let n=0;const client={conversations:{history:async()=>{assert.ok(++n<=3);return {messages:[],response_metadata:{next_cursor:'same'}};}}};
 await assert.rejects(fetchSlackHistory(client,{channel:'C1',maxMessages:100,maxPages:2,rejectCursorCycles:true}),/cursor cycle/);
 assert.equal(n,2);
});
const names=['SLACK_CONVERSATION_PAGE_LIMIT','SLACK_USER_PAGE_LIMIT','SLACK_BACKSCROLL_PAGE_LIMIT'];
for (const name of names) {
 for (const value of ['', ' ', '01', '+1', '-1', '0', '1.0', '1e2', '0x10', '2x', '10001','9007199254740993','NaN','Infinity','secret-input']) {
  test(`pagination config refuses ${name} ${value}`,()=>{
   const result=startupSettings(['--stdio'],{SLACK_BOT_TOKEN:'synthetic',SLACK_APP_TOKEN:'synthetic',[name]:value});
   assert.deepEqual(result,{refusal:`${name} must be a decimal integer from 1 to 10000`});
  });
 }
}
test('pagination defaults and accepted boundaries',()=>{
 for (const [env,expected] of [[{}, {conversations:1000,users:1000,backscroll:100}],
  [Object.fromEntries(names.map(n=>[n,'1'])),{conversations:1,users:1,backscroll:1}],
  [Object.fromEntries(names.map(n=>[n,'10000'])),{conversations:10000,users:10000,backscroll:10000}]] as const) {
  const result:any=startupSettings(['--stdio'],{SLACK_BOT_TOKEN:'synthetic',SLACK_APP_TOKEN:'synthetic',...env});
  assert.deepEqual(paginationLimits(result.settings.pagination),expected);
 }
});

test('scope restarts consume the invocation budget, never mixing stale rows',async()=>{
 const f=accessFixture({legacy:true,scopes:['channels:read'],pagination:{conversations:2}});let n=0;
 f.web.conversations.list=async()=>{assert.ok(++n<=3);return {channels:[joined(`C${n}`)],response_metadata:{scopes:n===1?['groups:read']:['im:read'],next_cursor:String(n)}};};
 const result=await f.adapter.listConversations();assert.equal(n,2);assert.deepEqual(result.conversations.map(c=>c.id),['C2']);assert.equal(result.truncation?.pages,2);
});
test('retries are not pages and successful pages do not reset the budget',async()=>{
 const f=fixture(true);let calls=0;const waits:number[]=[];
 f.web.conversations.list=async()=>{assert.ok(++calls<=5);if(calls%2)throw Object.assign(new Error('rate'),{code:'slack_webapi_rate_limited_error',retryAfter:1});return {channels:[],response_metadata:{next_cursor:String(calls)}};};
 const result=await f.adapter.listConversations(false,async(_w,n)=>{waits.push(n);});
 assert.equal(calls,4);assert.deepEqual(waits,[1,1]);assert.equal(result.truncation?.pages,2);
});
test('configured one-page cap still freshly admits every final-page candidate with its own retries',async()=>{
 const f=fixture(false,1);let list=0;const attempts=new Map<string,number>();
 f.web.conversations.list=async()=>{assert.equal(++list,1);return {channels:[joined('C1'),joined('C2')],response_metadata:{next_cursor:'next'}};};
 f.web.conversations.info=async({channel})=>{const n=(attempts.get(channel)??0)+1;attempts.set(channel,n);assert.ok(n<=5);
  if(n<5)throw Object.assign(new Error('rate'),{code:'slack_webapi_rate_limited_error',retryAfter:1});return {channel:joined(channel)};};
 const waits:number[]=[];const result=await f.adapter.listConversations(false,async(_w,n)=>{waits.push(n);});
 assert.deepEqual(result.conversations.map(c=>c.id),['C1','C2']);assert.deepEqual(waits,[1,2,3,4,1,2,3,4]);assert.equal(result.truncation?.pages,1);
});
for(const size of [15,200]) test(`helper service page size ${size} preserves newest subset oldest-first`,async()=>{
 let calls=0;const result=await fetchSlackHistory({conversations:{history:async(args)=>{
  assert.ok(++calls<=4);const count=Math.min(size,args.limit!);return {messages:Array.from({length:count},(_,i)=>({ts:String(1000-(calls-1)*size-i)})),response_metadata:{next_cursor:String(calls)}};
 }}},{channel:'C1',maxMessages:40,maxPages:3});
 assert.equal(result.truncated,true);assert.equal(result.messages.length,40);assert.equal(result.messages[0].ts,'961');assert.equal(result.messages.at(-1)?.ts,'1000');
});
test('item cap keeps its cycle precedence',async()=>{
 let n=0;const result=await fetchSlackHistory({conversations:{history:async()=>{assert.ok(++n<=2);return {messages:[{ts:String(3-n)}],response_metadata:{next_cursor:'same'}};}}},{channel:'C1',maxMessages:2,maxPages:2});
 assert.equal(result.truncated,true);assert.equal(result.stopReason,'message_limit');assert.equal(n,2);
});
test('library settings refuse invalid values without echo',()=>{
 for(const value of [0,-1,1.5,10001,NaN,Infinity,null,'2']){
  for (const field of ['conversations', 'users', 'backscroll'] as const) {
   assert.throws(()=>accessFixture({legacy:true,pagination:{[field]:value as number}}),{message:`pagination.${field} must be a decimal integer from 1 to 10000`});
  }
 }
});
for(const maxScanned of [1,3])test(`public history reader already stops at ${maxScanned} scanned with no matches`,async()=>{
 const f=fixture(true);let n=0;
 f.web.conversations.history=async()=>{assert.ok(++n<=maxScanned+1);return {messages:[{ts:`${100-n}.0`,text:'other'}],has_more:true,response_metadata:{next_cursor:String(n)}};};
 const result=await f.adapter.readHistory('C1',{channelId:'C1',maxScanned,textContains:'missing'});
 assert.equal(n,maxScanned);assert.equal(result.pagination.scanComplete,false);assert.equal(result.pagination.stopReason,'scan_limit');assert.ok(result.pagination.nextCursor);
});
test('public history reader stops on first empty distinct-cursor page',async()=>{
 const f=fixture(true);let n=0;
 f.web.conversations.history=async()=>{assert.equal(++n,1);return {messages:[],has_more:true,response_metadata:{next_cursor:'distinct'}};};
 await assert.rejects(f.adapter.readHistory('C1',{channelId:'C1'}),/held no message/);
});
for(const legacy of [true,false])test(`last permitted page retains its eligible rows ${legacy}`,async()=>{
 const f=fixture(legacy);let n=0;
 f.web.conversations.list=async()=>{assert.ok(++n<=3);return {channels:[joined(`C${n}`)],response_metadata:{next_cursor:String(n)}};};
 f.web.conversations.info=async({channel})=>({channel:joined(channel)});
 const result=await f.adapter.listConversations();assert.deepEqual(result.conversations.map(c=>c.id),['C1','C2']);assert.equal(result.truncation?.pages,2);
});
for(const path of ['conversations','users','backscroll'] as const)test(`default ${path} bound stops distinct cursors`,async()=>{
 const f=accessFixture({legacy:true});let n=0;const next=()=>{assert.ok(++n<=1002);return {next_cursor:String(n)};};
 f.web.conversations.list=async()=>({channels:[],response_metadata:next()});f.web.users.list=async()=>({members:[],response_metadata:next()});f.web.conversations.history=async()=>({messages:[],response_metadata:next()});
 const result:any=path==='conversations'?await f.adapter.listConversations():path==='users'?await f.adapter.findUsers('absent'):await f.adapter.fetchHistory('C1');
 assert.equal(n,path==='backscroll'?100:1000);assert.ok(result.truncated||result.truncation);
});
test('directory page cap retains partial matches; next cursor at exact match limit is incomplete',async()=>{
 const f=fixture(true);let n=0;
 f.web.users.list=async()=>{assert.ok(++n<=3);return {members:[{id:`U${n}`,name:'match'}],response_metadata:{next_cursor:String(n)}};};
 const partial:any=await f.adapter.findUsers('match');assert.deepEqual(partial.matches.map((u:any)=>u.userId),['U1','U2']);assert.deepEqual({truncated:partial.truncated,reason:partial.reason,pages:partial.pages,limit:partial.limit},{truncated:true,reason:'page_limit',pages:2,limit:2});
 n=0;const matched:any=await f.adapter.findUsers('match',1);assert.equal(n,1);assert.deepEqual({truncated:matched.truncated,reason:matched.reason,pages:matched.pages,limit:matched.limit},{truncated:true,reason:'match_limit',pages:1,limit:1});
});

test('page cap refreshes scopes widened during final candidate admission without discarding rows', async () => {
 const f=accessFixture({scopes:['channels:read'],pagination:{conversations:1}});
 f.web.conversations.list=async()=>({channels:[joined()],response_metadata:{next_cursor:'next'}});
 f.web.conversations.info=async()=> {
  // A real metadata response reports the newly granted scopes at its own issue serial.
  return {channel:joined(),response_metadata:{scopes:['channels:read', 'im:read', 'groups:read']}};
 };
 const result=await f.adapter.listConversations();
 assert.deepEqual(result.conversations.map(c=>c.id),['C1']);
 assert.ok(!result.leftOut.includes('private_channel'));
 assert.equal(result.truncation?.reason,'page_limit');
});

for (const legacy of [true, false]) {
 test(`scope restart after final no-cursor admission preserves rows (legacy=${legacy})`, async () => {
  const f=accessFixture({legacy,scopes:['channels:read','im:read'],pagination:{conversations:1}});
  f.web.conversations.list=async()=>({channels:legacy
   ? [{id:'D1',is_im:true,user:'U1'}] : [joined()]});
  const granted=['channels:read', 'im:read', 'groups:read'];
  f.web.conversations.info=async()=>({channel:joined(),response_metadata:{scopes:granted}});
  f.web.users.info=async()=>{
   // Legacy mode still accumulates reports explicitly; policy uses the response boundary.
   if(legacy)(f.adapter as any).takeScopes(granted);
   return {user:{id:'U1',name:'one'}};
  };
  const result=await f.adapter.listConversations();
  assert.deepEqual(result.conversations.map(c=>c.id),[legacy?'D1':'C1']);
  assert.equal(result.truncation?.reason,'page_limit');
  assert.ok(!result.leftOut.includes('private_channel'));
 });
 test(`scope restart from final page response preserves prior rows (legacy=${legacy})`, async () => {
  const f=accessFixture({legacy,scopes:['channels:read'],pagination:{conversations:2}});
  let pages=0;
  f.web.conversations.list=async()=>++pages===1
   ? {channels:[joined()],response_metadata:{next_cursor:'next'}}
   : {channels:[joined('C2')],response_metadata:{scopes:['channels:read','groups:read']}};
  f.web.conversations.info=async({channel})=>({channel:joined(channel)});
  const result=await f.adapter.listConversations();
  assert.equal(pages,2);
  assert.deepEqual(result.conversations.map(c=>c.id),['C1','C2']);
  assert.equal(result.truncation?.reason,'page_limit');
  assert.ok(!result.leftOut.includes('private_channel'));
 });
}

for (const legacy of [false, true]) test(`exact final page retains eligible rows: legacy=${legacy}`, async () => {
  const f = fixture(legacy);
  let listing = 0;
  f.web.conversations.list = async () => ({ channels: [joined(`C${++listing}`)], response_metadata: { next_cursor: listing === 1 ? 'next' : '' } });
  f.web.conversations.info = async ({ channel }) => ({ channel: joined(channel) });
  const listed = await f.adapter.listConversations();
  assert.deepEqual(listed.conversations.map(c => c.id), ['C1', 'C2']);
  assert.equal(listed.truncation, undefined);
  let directory = 0;
  f.web.users.list = async () => ({ members: [{ id: `U${++directory}`, name: 'match' }], response_metadata: { next_cursor: directory === 1 ? 'next' : '' } });
  const users = await f.adapter.findUsers('match');
  assert.ok(Array.isArray(users));
  assert.deepEqual(users.map(u => u.userId), ['U1', 'U2']);
  let history = 0;
  const result = await fetchSlackHistory({ conversations: { history: async () => ({ messages: [{ ts: `${3 - ++history}.0` }], response_metadata: { next_cursor: history === 1 ? 'next' : '' } }) } }, { channel: 'C1', maxMessages: 100, maxPages: 2 });
  assert.deepEqual(result.messages.map(m => m.ts), ['1.0', '2.0']);
  assert.equal(result.truncated, false);
});

test('policy malformed non-array directory response fails explicitly', async () => {
 const f=fixture(false);
 f.web.users.list=async()=>({members:'not-an-array' as any});
 await assert.rejects(f.adapter.findUsers('human'), /No users were returned: Slack returned an invalid directory/);
});

test('unset pagination keeps the legacy startup shape and adapter defaults', () => {
 const result = startupSettings(['--stdio'], { SLACK_BOT_TOKEN: 'synthetic', SLACK_APP_TOKEN: 'synthetic' });
 assert.ok('settings' in result);
 assert.equal(Object.hasOwn(result.settings, 'pagination'), false);
 assert.deepEqual(paginationLimits(result.settings.pagination), { conversations: 1000, users: 1000, backscroll: 100 });
});

test('page-cap scope withdrawal removes earlier admitted rows under the withdrawn grant', async () => {
 const f=accessFixture({scopes:['channels:read','groups:read'],pagination:{conversations:1}});
 f.web.conversations.list=async()=>({channels:[joined('G1'),joined('C1')],response_metadata:{next_cursor:'more'}});
 f.web.conversations.info=async({channel})=>({channel:{...joined(channel),is_private:channel==='G1'},response_metadata:{scopes:channel==='G1'?['channels:read','groups:read']:['channels:read']}});
 const result=await f.adapter.listConversations();
 assert.deepEqual(result.conversations.map(c=>c.id),['C1']);
 assert.deepEqual(result.leftOut,['private_channel','im']);
 assert.equal(result.truncation?.reason,'page_limit');
});

test('unsubscribed ambient after shutdown is filtered, not counted as lost delivery', async t => {
 const f=accessFixture(); f.adapter.setAmbientMessageFilter(()=>false);
 const logs:string[]=[];t.mock.method(console,'error',(...args:unknown[])=>{logs.push(args.join(' '));});
 await f.adapter.stop();f.calls.length=0;logs.length=0;
 await f.emit({type:'message',channel:'C1',user:'U1',ts:'1.0',text:'ambient'});
 assert.deepEqual(f.calls,[]);assert.deepEqual(logs,[]);
 await f.emit({type:'message',channel:'C1',user:'U1',ts:'2.0',text:'<@UBOT> hello'});
 assert.match(logs.join('\n'),/message dropped \(shutdown\): 1/);
 assert.deepEqual(f.calls,[]);
});


test('policy directory rejects malformed rows instead of claiming complete search', async () => {
  const f = fixture(false);
  f.web.users.list = async () => ({});
  await assert.rejects(f.adapter.findUsers('human'), /invalid directory/);
  for (const row of [{ id: 'U1', name: 123 }, { id: 42, name: 'human' }, { id: 'U2', profile: { display_name: [] } }]) {
    f.web.users.list = async () => ({ members: [row, { id: 'U3', name: 'human' }] as any });
    await assert.rejects(f.adapter.findUsers('human'), /malformed directory row/);
  }
});

for (const legacy of [true, false]) test(`nullable optional directory profile remains searchable: legacy=${legacy}`, async () => {
  const f = fixture(legacy);
  f.web.users.list = async () => ({ members: [{ id: 'U123', name: 'human', profile: null }] as any });
  assert.deepEqual(await f.adapter.findUsers('human'), [{ userId: 'U123', username: 'human', realName: undefined, displayName: undefined }]);
});

test('unset directory preserves main missing-page and nonstandard-ID behavior', async () => {
  const f = fixture(true);
  f.web.users.list = async () => ({});
  assert.deepEqual(await f.adapter.findUsers('human'), []);
  f.web.users.list = async () => ({ members: [{ id: 'nonstandard-id', name: 'human' }] });
  assert.deepEqual(await f.adapter.findUsers('human'), [{ userId: 'nonstandard-id', username: 'human', realName: undefined, displayName: undefined }]);
});

for (const maxPages of [0, -1, 1.5, NaN, Infinity, 10001]) test(`exported helper rejects maxPages ${maxPages} before requests`, async () => {
  let calls = 0;
  const client = { conversations: { history: async () => { calls++; return { messages: [] }; } } };
  await assert.rejects(fetchSlackHistory(client, { channel: 'C1', maxMessages: 10, maxPages }), /^Error: maxPages must be a decimal integer from 1 to 10000$/);
  assert.equal(calls, 0);
});

for (const legacy of [true, false]) test(`listing and directory reject nonadjacent cursor cycles ${legacy}`, async () => {
  const f = fixture(legacy, 3);
  let pages = 0;
  const cursor = () => { assert.ok(++pages <= 3); return { next_cursor: ['a', 'b', 'a'][pages - 1] }; };
  f.web.conversations.list = async () => ({ channels: [], response_metadata: cursor() });
  if (legacy) assert.equal((await f.adapter.listConversations()).truncation?.reason, 'page_limit');
  else await assert.rejects(f.adapter.listConversations(), /cursor cycle/);
  assert.equal(pages, 3);
  pages = 0;
  f.web.users.list = async () => ({ members: [], response_metadata: cursor() });
  if (legacy) assert.equal((await f.adapter.findUsers('absent') as any).reason, 'page_limit');
  else await assert.rejects(f.adapter.findUsers('absent'), /cursor cycle/);
  assert.equal(pages, 3);
});

for (const legacy of [true, false]) test(`directory match cap wins over a same-page cap and repeated cursor ${legacy}`, async () => {
  const f = fixture(legacy, 2);
  let calls = 0;
  f.web.users.list = async () => ({
    members: ++calls === 1 ? [] : [{ id: 'U1', name: 'match' }],
    response_metadata: { next_cursor: 'same' },
  });
  const result = await f.adapter.findUsers('match', 1);
  assert.deepEqual(result, { matches: [{ userId: 'U1', username: 'match', realName: undefined, displayName: undefined }], truncated: true, reason: 'match_limit', pages: 2, limit: 1 });
  assert.equal(calls, 2);
});


test('policy withdrawal to no readable types returns the policy no-types result', async () => {
 const f=accessFixture({scopes:['channels:read']});
 let pages=0;
 f.web.conversations.list=async()=>{
  assert.equal(++pages,1);
  return {channels:[],response_metadata:{scopes:['chat:write'],next_cursor:'more'}};
 };
 const result=await f.adapter.listConversations();
 assert.deepEqual(result.conversations,[]);
 assert.ok(result.leftOut.includes('public_channel'));
 assert.equal(pages,1);
});

test('invalid embedded pagination containers fail clearly before authentication', async () => {
 const { connectSlack } = await import('../src/slack-adapter.js');
 for (const pagination of [null, false, 2, '', []]) {
  await assert.rejects(connectSlack({ botToken: 'test', appToken: 'test', pagination } as any),
   { message: 'pagination must be an object containing page limits' });
 }
});

test('capped backscroll retains both nonempty final-page rows in order', async () => {
  let pages = 0;
  const result = await fetchSlackHistory({ conversations: { history: async () => ({
    messages: [{ ts: `${3 - ++pages}.0`, user: 'U1', text: `human page ${pages}` }],
    response_metadata: { next_cursor: `page-${pages}` },
  }) } }, { channel: 'C1', maxMessages: 20, maxPages: 2 });
  assert.deepEqual(result, { messages: [
    { ts: '1.0', user: 'U1', text: 'human page 2' },
    { ts: '2.0', user: 'U1', text: 'human page 1' },
  ], truncated: true, stopReason: 'page_limit' });
});


for (const legacy of [true, false]) for (const kind of ['conversations', 'users', 'backscroll'] as const)
  test(`ordinary later-page failure does not return collected ${kind}: legacy=${legacy}`, async t => {
    const f = fixture(legacy); t.after(() => f.adapter.stop());
    let pages = 0;
    const page = async () => {
      if (++pages === 2) throw new Error('upstream later page failed');
      assert.equal(pages, 1);
      return { channels: [joined()], members: [{ id: 'U1', name: 'match' }], messages: [{ ts: '1.0', user: 'U1', text: 'retained' }], response_metadata: { next_cursor: 'next' } };
    };
    f.web.conversations.list = page; f.web.users.list = page; f.web.conversations.history = page;
    await assert.rejects(kind === 'conversations' ? f.adapter.listConversations() : kind === 'users' ? f.adapter.findUsers('match') : f.adapter.fetchHistory('C1'), /upstream later page failed/);
    assert.equal(pages, 2);
  });
for (const kind of ['conversations', 'users', 'backscroll'] as const)
  test(`malformed later ${kind} page fails instead of returning collected rows`, async t => {
    const f = fixture(false); t.after(() => f.adapter.stop());
    let pages = 0;
    const page = async () => {
      assert.ok(++pages <= 2);
      return pages === 1 ? { channels: [joined()], members: [{ id: 'U1', name: 'match' }], messages: [{ ts: '1.0', user: 'U1', text: 'retained' }], response_metadata: { next_cursor: 'next' } }
        : { channels: 42, members: 42, messages: 42 } as never;
    };
    f.web.conversations.list = page; f.web.users.list = page; f.web.conversations.history = page;
    await assert.rejects(kind === 'conversations' ? f.adapter.listConversations() : kind === 'users' ? f.adapter.findUsers('match') : f.adapter.fetchHistory('C1'), /malformed|invalid|iterable/);
    assert.equal(pages, 2);
  });
