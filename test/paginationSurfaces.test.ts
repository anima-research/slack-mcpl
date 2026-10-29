import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SlackMcplServer, backscrollBlock } from '../src/server.js';
import { connectSlack } from '../src/slack-adapter.js';
import { accessFixture, joined } from './adapterAccessFixture.js';
import { connectHost, initialize, FULL_GRANT, until, MENTION_EVENT } from './harness.js';
import { fakeSlackApi } from './slackApi.js';

const call = async(h:ReturnType<typeof connectHost>, name:string, args={}) => {
 const response:any=await h.host.sendRequest('tools/call',{name,arguments:args});
 assert.notEqual(response.isError,true,JSON.stringify(response));return response;
};
const value=(r:any)=>JSON.parse(r.content[0].text);
for(const legacy of [true,false])test(`partial tool and registration signals ${legacy}`,async(t)=>{
 const logs:string[]=[];t.mock.method(console,'error',(...args:unknown[])=>logs.push(args.join(' ')));
 const f=accessFixture({legacy,pagination:{conversations:2,users:2}});let requests=0,complete=false;
 f.web.conversations.list=async(args)=>{assert.ok(++requests<=10);return {channels:args.cursor?[]:[joined()],response_metadata:{next_cursor:complete?'':args.cursor?'second':'first'}};};
 f.web.users.list=async(args)=>{assert.ok(++requests<=10);return {members:[],response_metadata:{next_cursor:args.cursor?'second':'first'}};};
 const server=new SlackMcplServer(f.adapter);const h=connectHost(server);t.after(()=>h.close());await initialize(h,true);
 await h.host.sendRequest(method.FEATURE_SETS_UPDATE,{effectiveCapabilities:['tools']});
 const listed=await call(h,'list_channels');assert.match(JSON.stringify(listed),/Incomplete conversation listing/);assert.equal(value(listed).length,1);
 const users=value(await call(h,'find_user',{query:'absent'}));assert.equal(users.found,false);assert.equal(users.truncated,true);assert.equal(users.stopReason,'page_limit');assert.doesNotMatch(users.note,/No users matched/);
 assert.equal(Object.hasOwn(users,'users'),false);
 assert.match(users.note,/For "absent", find_user matches part of a username, real name or display name, ignoring case, and leaves out bots and deactivated accounts. Try a shorter part or another spelling\.$/);
 await h.host.sendRequest(method.FEATURE_SETS_UPDATE,{effectiveCapabilities:FULL_GRANT});
 await until(()=>(server as any).registering===undefined,'registration');
 assert.equal(h.hostSaw.filter(r=>r.method===method.CHANNELS_REGISTER).length,1);
 assert.equal(logs.filter(l=>l.includes('Conversation registration incomplete:')).length,1);
 const refresh=value(await call(h,'refresh_channels'));assert.equal(refresh.truncated,true);assert.equal(refresh.visible,1);assert.deepEqual(refresh.added,[]);
 assert.equal(refresh.registration.enumerationIncomplete,true);assert.match(refresh.note,/incomplete scan/);assert.doesNotMatch(refresh.note,/No new conversations:/);
 complete=true;const full=value(await call(h,'refresh_channels'));assert.equal(full.truncated,undefined);assert.equal(full.registration,undefined);
 assert.match(full.note,/No new conversations:/);assert.equal((server as any).registrationIncomplete,undefined);
});
test('partial zero-descriptor registration has status, but no register request',async(t)=>{
 t.mock.method(console,'error',()=>{});const f=accessFixture({legacy:true,pagination:{conversations:1}});let calls=0;
 f.web.conversations.list=async()=>{assert.ok(++calls<=2);return {channels:[],response_metadata:{next_cursor:'next'}};};
 const server=new SlackMcplServer(f.adapter),h=connectHost(server);t.after(()=>h.close());await initialize(h,true);
 await h.host.sendRequest(method.FEATURE_SETS_UPDATE,{effectiveCapabilities:FULL_GRANT});await until(()=>(server as any).registering===undefined,'registration');
 assert.equal(h.hostSaw.length,0);assert.equal((server as any).registrationIncomplete.pages,1);
 const result=value(await call(h,'refresh_channels'));assert.equal(result.visible,0);assert.equal(result.truncated,true);assert.equal(result.registration.enumerationIncomplete,true);
 await h.host.sendRequest(method.FEATURE_SETS_UPDATE,{effectiveCapabilities:['tools']});assert.equal((server as any).registrationIncomplete,undefined);
});
test('stale truncated background enumeration cannot overwrite newer complete status or announce',async(t)=>{
 const logs:string[]=[];t.mock.method(console,'error',(...a:unknown[])=>logs.push(a.join(' ')));
 const f=accessFixture({legacy:true});let release!:(x:any)=>void;let calls=0;
 f.adapter.listConversations=async()=>{assert.ok(++calls<=2);return calls===1?new Promise(r=>{release=r;}):{conversations:[],leftOut:[]};};
 const server=new SlackMcplServer(f.adapter),h=connectHost(server);t.after(()=>h.close());await initialize(h,true);
 await h.host.sendRequest(method.FEATURE_SETS_UPDATE,{effectiveCapabilities:FULL_GRANT});await until(()=>!!release,'first listing');
 await h.host.sendRequest(method.FEATURE_SETS_UPDATE,{effectiveCapabilities:['tools']});
 await h.host.sendRequest(method.FEATURE_SETS_UPDATE,{effectiveCapabilities:FULL_GRANT});await until(()=>(server as any).registering===undefined,'new listing');
 release({conversations:[{id:'C1',kind:'channel',name:'room',isMember:true}],leftOut:[],truncation:{reason:'page_limit',pages:1,limit:1}});
 await new Promise(r=>setImmediate(r));assert.equal((server as any).registrationIncomplete,undefined);assert.equal(h.hostSaw.length,0);assert.equal(logs.some(l=>l.includes('registration incomplete')),false);
});
for(const source of ['empty','bot','message_limit','complete'] as const)test(`real incoming backscroll ${source}`,async(t)=>{
 t.mock.method(console,'error',()=>{});const f=accessFixture({legacy:true,pagination:{backscroll:1}});let calls=0;
 f.web.conversations.history=async()=>{assert.equal(++calls,1);return {messages:source==='empty'?[]:Array.from({length:source==='message_limit'?50:1},(_,i)=>({ts:`${100-i}.0`,user:source==='bot'?'UBOT':'U1',text:'context'})),response_metadata:{next_cursor:source==='complete'?'':'next'}};};
 const server=new SlackMcplServer(f.adapter),h=connectHost(server);t.after(()=>h.close());await initialize(h,true);
 await h.host.sendRequest(method.FEATURE_SETS_UPDATE,{effectiveCapabilities:FULL_GRANT});await until(()=>(server as any).registering===undefined,'registration');
 await f.emit(MENTION_EVENT);await until(()=>h.hostSaw.some(r=>r.method===method.PUSH_EVENT),'incoming');
 const received=JSON.stringify(h.hostSaw.filter(r=>r.method===method.PUSH_EVENT));
 if(source==='complete')assert.doesNotMatch(received,/truncated|incomplete/);
 else {assert.match(received,/truncated=\\"true\\"/);assert.match(received,/Backscroll is incomplete/);if(source==='empty'||source==='bot')assert.match(received,/count=\\"0\\"/);}
 assert.equal(h.hostSaw.filter(r=>r.method===method.PUSH_EVENT).length,1);
});
test('complete backscroll tag bytes remain unchanged',()=>{
 assert.equal(backscrollBlock([],{isDM:false}),'<backscroll count="0">\n</backscroll>');
});
test('real HTTP client and server honor startup-parsed caps without a lookahead request',async(t)=>{
 t.mock.method(console,'error',()=>{});const api=await fakeSlackApi();t.after(()=>api.close());let pages=0;
 api.answerFor('auth.test',{body:{ok:true,user_id:'UBOT',team:'test',response_metadata:{scopes:['channels:read','users:read']}}});
 api.answerFor('conversations.list',{body:()=>{if(++pages>3)return {ok:false,error:'emergency_ceiling'};return {ok:true,channels:[],response_metadata:{next_cursor:String(pages)}};}});
 const {startupSettings}=await import('../src/config.js');
 const result=startupSettings(['--stdio'],{SLACK_BOT_TOKEN:'synthetic',SLACK_APP_TOKEN:'synthetic',SLACK_CONVERSATION_PAGE_LIMIT:'2'});assert.ok('settings' in result);
 const adapter=await connectSlack(result.settings,api.url);const server=new SlackMcplServer(adapter),h=connectHost(server);t.after(()=>h.close());await initialize(h,false);
 const response=await call(h,'list_channels');assert.match(JSON.stringify(response),/Incomplete conversation listing/);assert.equal(pages,2);
 assert.deepEqual(api.calls,['auth.test','conversations.list','conversations.list']);assert.equal(api.sent[1].get('limit'),'200');assert.equal(api.sent[2].get('cursor'),'1');
});

test('match-limit tool exposes users and incomplete status, not an array property',async(t)=>{
 const f=accessFixture({legacy:true});let calls=0;
 f.web.users.list=async()=>{assert.equal(++calls,1);return {members:Array.from({length:26},(_,i)=>({id:`U${i}`,name:'match'}))};};
 const h=connectHost(new SlackMcplServer(f.adapter));t.after(()=>h.close());await initialize(h,false);
 const result=value(await call(h,'find_user',{query:'match'}));assert.equal(result.users.length,25);assert.equal(result.found,true);assert.equal(result.truncated,true);assert.equal(result.stopReason,'match_limit');assert.match(result.note,/narrower query/);
});
test('partial refresh keeps scope and unnamed-DM notes; closed connection keeps incomplete marker',async(t)=>{
 t.mock.method(console,'error',()=>{});const f=accessFixture({legacy:true});const server=new SlackMcplServer(f.adapter),h=connectHost(server);t.after(()=>h.close());await initialize(h,true);
 await h.host.sendRequest(method.FEATURE_SETS_UPDATE,{effectiveCapabilities:FULL_GRANT});await until(()=>(server as any).registering===undefined,'registration');
 const partial:any={conversations:[{id:'D1',kind:'dm',name:'U1',userId:'U1',isMember:true,nameWait:{method:'users.info',seconds:1,why:'limited'}}],leftOut:['private_channel'],truncation:{reason:'page_limit',pages:1,limit:1}};
 f.adapter.listConversations=async()=>partial;
 const result=value(await call(h,'refresh_channels'));assert.equal(result.truncated,true);assert.match(result.note,/Left out 1 DM/);assert.match(result.note,/private channels/);assert.match(result.note,/^No conversation was registered\./);assert.match(result.note,/Incomplete conversation listing/);
 let release!:(r:any)=>void;f.adapter.listConversations=()=>new Promise(r=>{release=r;});
 const pending=(server as any).refreshChannels();await h.close();release(partial);const closed=await pending;
 assert.equal(closed.truncated,true);assert.deepEqual(closed.added,[]);assert.match(closed.note,/connection closed/);assert.match(closed.note,/Incomplete conversation listing/);
});
test('host rejection does not turn a partial enumeration into complete status',async(t)=>{
 t.mock.method(console,'error',()=>{});const f=accessFixture({legacy:true,pagination:{conversations:1}});let calls=0;
 f.web.conversations.list=async()=>{assert.ok(++calls<=2);return {channels:[joined()],response_metadata:{next_cursor:'next'}};};
 const server=new SlackMcplServer(f.adapter),h=connectHost(server);t.after(()=>h.close());h.host.removeAllListeners('request');
 h.host.on('request',req=>h.host.sendResponse(req.id,{results:[{id:'slack:C1',accepted:false}]}));await initialize(h,true);
 await h.host.sendRequest(method.FEATURE_SETS_UPDATE,{effectiveCapabilities:FULL_GRANT});await until(()=>(server as any).registering===undefined,'registration');
 assert.equal((server as any).registrationIncomplete.pages,1);
 const listed:any=await h.host.sendRequest(method.CHANNELS_LIST);assert.equal(listed.channels.length,0);
});

test('complete zero-match shape and guidance retain legacy bytes',async(t)=>{
 const f=accessFixture({legacy:true});let calls=0;
 f.web.users.list=async()=>{assert.equal(++calls,1);return {members:[]};};
 const h=connectHost(new SlackMcplServer(f.adapter));t.after(()=>h.close());await initialize(h,false);
 const result=value(await call(h,'find_user',{query:'absent'}));
 assert.deepEqual(result,{found:false,note:'No users matched "absent". find_user matches part of a username, real name or display name, ignoring case, and leaves out bots and deactivated accounts. Try a shorter part or another spelling.'});
});
for(const partial of [true,false])test(`closed refresh does not report or revive prior registration status: partial=${partial}`,async(t)=>{
 t.mock.method(console,'error',()=>{});
 const f=accessFixture({legacy:true,pagination:{conversations:1}});let calls=0;
 f.web.conversations.list=async()=>{assert.equal(++calls,1);return {channels:[],response_metadata:{next_cursor:'next'}};};
 const server=new SlackMcplServer(f.adapter),h=connectHost(server);t.after(()=>h.close());await initialize(h,true);
 await h.host.sendRequest(method.FEATURE_SETS_UPDATE,{effectiveCapabilities:FULL_GRANT});
 await until(()=>(server as any).registering===undefined,'partial registration');
 assert.deepEqual((server as any).registrationIncomplete,{reason:'page_limit',pages:1,limit:1});
 let release!:(r:any)=>void;let refreshCalls=0;
 f.adapter.listConversations=()=>{assert.equal(++refreshCalls,1);return new Promise(r=>{release=r;});};
 const pending=(server as any).refreshChannels();await h.close();
 assert.equal((server as any).registrationIncomplete,undefined);
 release({conversations:[{id:'C1',kind:'channel',name:'room',isMember:true}],leftOut:[],
   ...(partial?{truncation:{reason:'page_limit',pages:1,limit:1}}:{})});
 const closed=await pending;
 assert.equal(Object.hasOwn(closed,'registration'),false);
 assert.equal((server as any).registrationIncomplete,undefined);
 assert.equal(closed.visible,1);assert.deepEqual(closed.added,[]);
 assert.equal(closed.truncated,partial?true:undefined);
 assert.equal(closed.stopReason,partial?'page_limit':undefined);
 assert.match(closed.note,/^The host's connection closed while Slack was listing conversations; nothing was announced\./);
 if(partial)assert.match(closed.note,/Incomplete conversation listing/);
 else assert.equal(closed.note,"The host's connection closed while Slack was listing conversations; nothing was announced.");
 assert.equal(h.hostSaw.length,0);
});
