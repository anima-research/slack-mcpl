import test from 'node:test';
import assert from 'node:assert/strict';
import { accessFixture, joined } from './adapterAccessFixture.js';
import { fetchSlackHistory } from '../src/content.js';
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
    if (kind === 'denied') f.state.infoError = new Error('denied');
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
    await assert.rejects(f.adapter.listConversations(),/cursor cycle/);assert.equal(n,2);
    n=0;f.web.users.list=async()=>{assert.ok(++n<=3);return {members:[],response_metadata:{next_cursor:'same'}};};
    await assert.rejects(f.adapter.findUsers('absent'),/cursor cycle/);assert.equal(n,2);
  });
  test(`backscroll adapter receives configuration ${legacy}`,async()=>{
    const f=fixture(legacy);const c=ceiling();
    f.web.conversations.history=async()=>({messages:[],response_metadata:c.next()});
    assert.deepEqual(await f.adapter.fetchHistory('C1'),{messages:[],truncated:true});assert.equal(c.n,2);
  });
}
for (const end of [1,2,3]) test(`helper empty-page boundary ${end}`,async()=>{
 const c=ceiling(end);
 const result=await fetchSlackHistory({conversations:{history:async()=>({messages:[],response_metadata:c.next()})}},
  {channel:'C1',maxMessages:100,maxPages:2} as any);
 assert.deepEqual(result,{messages:[],truncated:end>2});assert.equal(c.n,Math.min(end,2));
});
test('helper cycle wins on new cap, existing message stop wins on cycle',async()=>{
 let n=0;const client={conversations:{history:async()=>{assert.ok(++n<=3);return {messages:[],response_metadata:{next_cursor:'same'}};}}};
 await assert.rejects(fetchSlackHistory(client,{channel:'C1',maxMessages:100,maxPages:2} as any),/cursor cycle/);
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
  assert.deepEqual(result.settings.pagination,expected);
 }
});

test('scope restarts consume the invocation budget, never mixing stale rows',async()=>{
 const f=accessFixture({legacy:true,scopes:['channels:read'],pagination:{conversations:2}});let n=0;
 f.web.conversations.list=async()=>{assert.ok(++n<=3);return {channels:[joined(`C${n}`)],response_metadata:{scopes:n===1?['groups:read']:['im:read'],next_cursor:String(n)}};};
 const result=await f.adapter.listConversations();assert.equal(n,2);assert.deepEqual(result.conversations,[]);assert.equal(result.truncation?.pages,2);
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
test('item cap keeps its cycle precedence and exact page exhaustion stays complete',async()=>{
 let n=0;const result=await fetchSlackHistory({conversations:{history:async()=>{assert.ok(++n<=2);return {messages:[{ts:String(3-n)}],response_metadata:{next_cursor:'same'}};}}},{channel:'C1',maxMessages:2,maxPages:2});
 assert.equal(result.truncated,true);assert.equal(n,2);
});
test('library settings refuse invalid values without echo',()=>{
 for(const value of [0,-1,1.5,10001,NaN,Infinity,null,'2']){
  assert.throws(()=>accessFixture({legacy:true,pagination:{conversations:value as number}}),{message:'SLACK_CONVERSATION_PAGE_LIMIT must be a decimal integer from 1 to 10000'});
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
 const partial:any=await f.adapter.findUsers('match');assert.deepEqual(partial.matches.map((u:any)=>u.userId),['U1','U2']);assert.equal(partial.reason,'page_limit');
 n=0;const matched:any=await f.adapter.findUsers('match',1);assert.equal(n,1);assert.equal(matched.reason,'match_limit');
});
