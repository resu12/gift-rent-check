import test from 'node:test';
import assert from 'node:assert/strict';
import {createPullToRefresh} from './pullToRefresh.ts';
import type {PullPoint,PullRefreshState} from './pullToRefresh.ts';

function deferred<T>() {
  let resolve!:(value:T)=>void, reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const point=(y:number,x=30,id=1):PullPoint=>({id,x,y});
function fixture() {
  let allowed=true,top=true;
  const states:PullRefreshState[]=[],requests:ReturnType<typeof deferred<string>>[]=[];
  const controller=createPullToRefresh({allowed:()=>allowed,atTop:()=>top,
    refresh(){const request=deferred<string>();requests.push(request);return request.promise;},
    changed:state=>states.push({...state}),
  });
  const arm=()=>{controller.start([point(100)]);assert.equal(controller.move([point(212)]),true);};
  return {controller,states,requests,arm,state:()=>states.at(-1),setAllowed:(value:boolean)=>{allowed=value;},setTop:(value:boolean)=>{top=value;}};
}

test('pulling arms only at the threshold and sends one refresh on release, never while holding',async()=>{
  const f=fixture();f.controller.start([point(100)]);
  assert.equal(f.controller.move([point(107)]),false);assert.equal(f.state()?.phase,'idle');
  assert.equal(f.controller.move([point(108)]),true);assert.deepEqual(f.state(),{phase:'pulling',distance:4});
  f.controller.move([point(211)]);assert.equal(f.state()?.phase,'pulling');
  f.controller.move([point(212)]);assert.deepEqual(f.state(),{phase:'armed',distance:56});
  f.controller.move([point(1000)]);assert.deepEqual(f.state(),{phase:'armed',distance:76});
  assert.equal(f.requests.length,0,'holding and moving past the threshold never sends work');
  const release=f.controller.end();assert.equal(f.requests.length,1);assert.deepEqual(f.state(),{phase:'refreshing',distance:54});
  await f.controller.end();assert.equal(f.requests.length,1,'duplicate release cannot repeat the action');
  f.requests[0].resolve('Gifts refreshed.');await release;
  assert.deepEqual(f.state(),{phase:'notice',distance:54,message:'Gifts refreshed.'});
  await f.controller.end();assert.equal(f.requests.length,1);
});

test('reversing below the threshold disarms release without refreshing',async()=>{
  const f=fixture();f.arm();assert.equal(f.state()?.phase,'armed');
  f.controller.move([point(180)]);assert.equal(f.state()?.phase,'pulling');
  await f.controller.end();assert.equal(f.requests.length,0);assert.equal(f.state()?.phase,'idle');
  f.arm();f.controller.move([point(103)]);assert.equal(f.state()?.phase,'idle');
  await f.controller.end();assert.equal(f.requests.length,0);
});

test('a normal scroll begun mid-page cannot become a refresh when it later reaches the top',async()=>{
  const f=fixture();f.setTop(false);f.controller.start([point(100)]);
  f.setTop(true);assert.equal(f.controller.move([point(300)]),false);
  await f.controller.end();assert.equal(f.requests.length,0);
  f.arm();f.setTop(false);assert.equal(f.controller.move([point(260)]),false);
  f.setTop(true);assert.equal(f.controller.move([point(400)]),false);
  await f.controller.end();assert.equal(f.requests.length,0,'leaving the top cancels that touch sequence permanently');
});

test('horizontal gestures and upward scrolling cancel instead of switching into refresh',async()=>{
  for(const cancellation of [point(105,60),point(93),point(120,60)]) {
    const f=fixture();f.controller.start([point(100)]);
    assert.equal(f.controller.move([cancellation]),false);assert.equal(f.state()?.phase,'idle');
    assert.equal(f.controller.move([point(300)]),false);await f.controller.end();assert.equal(f.requests.length,0);
  }
});

test('multitouch or a changed touch identity cancels the whole gesture',async()=>{
  const f=fixture();f.controller.start([point(100),point(100,50,2)]);
  assert.equal(f.controller.move([point(300)]),false);await f.controller.end();assert.equal(f.requests.length,0);
  for(const points of [[point(220),point(220,50,2)],[point(220,30,2)],[]]) {
    f.arm();assert.equal(f.controller.move(points),false);
    assert.equal(f.controller.move([point(300)]),false);await f.controller.end();assert.equal(f.requests.length,0);
  }
});

test('excluded controls, a hidden view or an open modal cannot start or release a refresh',async()=>{
  const f=fixture();f.controller.start([point(100)],true);
  assert.equal(f.controller.move([point(300)]),false);await f.controller.end();assert.equal(f.requests.length,0);
  f.setAllowed(false);f.controller.start([point(100)]);f.setAllowed(true);
  assert.equal(f.controller.move([point(300)]),false);await f.controller.end();assert.equal(f.requests.length,0);
  f.arm();f.setAllowed(false);assert.equal(f.controller.move([point(300)]),false);
  f.setAllowed(true);await f.controller.end();assert.equal(f.requests.length,0);
  f.arm();f.setAllowed(false);await f.controller.end();assert.equal(f.requests.length,0);assert.equal(f.state()?.phase,'idle');
});

test('leaving the top immediately before release cancels an armed gesture',async()=>{
  const f=fixture();f.arm();f.setTop(false);await f.controller.end();assert.equal(f.requests.length,0);
});

test('a pending refresh blocks repeated gestures and dismissal until it settles',async()=>{
  const f=fixture();f.arm();const release=f.controller.end();assert.equal(f.requests.length,1);
  f.controller.start([point(100)]);assert.equal(f.controller.move([point(300)]),false);
  f.controller.dismiss();f.controller.cancel();await f.controller.end();
  assert.deepEqual(f.state(),{phase:'refreshing',distance:54});assert.equal(f.requests.length,1);
  f.requests[0].resolve('Saved data reloaded.');await release;f.controller.dismiss();assert.equal(f.state()?.phase,'idle');
  f.arm();const second=f.controller.end();assert.equal(f.requests.length,2);
  f.requests[1].resolve('Again.');await second;
});

for(const reason of ['page hidden','account or tab changed'])test(`${reason} resets the gesture and fences late notices without permitting overlapping refreshes`,async()=>{
  const f=fixture();f.arm();const release=f.controller.end();const noticeCount=f.states.filter(state=>state.phase==='notice').length;
  f.setAllowed(false);f.controller.reset();assert.equal(f.state()?.phase,'idle');
  f.setAllowed(true);f.controller.start([point(100)]);assert.equal(f.controller.move([point(300)]),false);
  await f.controller.end();assert.equal(f.requests.length,1);
  f.requests[0].resolve('Old account details must stay hidden.');await release;
  assert.equal(f.states.filter(state=>state.phase==='notice').length,noticeCount);assert.equal(f.state()?.phase,'idle');
  f.arm();const next=f.controller.end();assert.equal(f.requests.length,2);
  f.requests[1].resolve('Current data refreshed.');await next;assert.equal(f.state()?.message,'Current data refreshed.');
});

test('reset before release cancels without scheduling any refresh',async()=>{
  const f=fixture();f.arm();f.controller.reset();await f.controller.end();assert.equal(f.requests.length,0);assert.equal(f.state()?.phase,'idle');
});

test('dispose prevents all new refreshes and callbacks, including an outstanding result',async()=>{
  const f=fixture();f.arm();const release=f.controller.end();f.controller.dispose();const updates=f.states.length;
  f.controller.start([point(100)]);assert.equal(f.controller.move([point(300)]),false);await f.controller.end();
  f.controller.reset();f.controller.cancel();f.controller.dismiss();f.requests[0].resolve('Late result');await release;
  assert.equal(f.requests.length,1);assert.equal(f.states.length,updates);
  const untouched=fixture();untouched.controller.dispose();untouched.controller.start([point(100)]);
  assert.equal(untouched.controller.move([point(300)]),false);await untouched.controller.end();
  assert.equal(untouched.requests.length,0);assert.equal(untouched.states.length,0);
});

test('refresh rejection has fixed safe feedback and permits a later deliberate retry',async()=>{
  const f=fixture();f.arm();const release=f.controller.end();f.requests[0].reject(new Error('Private wallet cookie token'));await release;
  assert.deepEqual(f.state(),{phase:'notice',distance:54,message:'Refresh could not finish. Try again or check Status.'});
  assert.equal(JSON.stringify(f.states).includes('Private wallet'),false);
  f.arm();const retry=f.controller.end();assert.equal(f.requests.length,2);f.requests[1].resolve('Updated.');await retry;
});

test('synchronous failures use the same safe feedback without leaving the controller busy',async()=>{
  const states:PullRefreshState[]=[];let calls=0;
  const controller=createPullToRefresh({allowed:()=>true,atTop:()=>true,refresh:()=>{calls++;throw new Error('private');},changed:state=>states.push(state)});
  for(let i=0;i<2;i++){controller.start([point(100)]);controller.move([point(212)]);await controller.end();}
  assert.equal(calls,2);assert.equal(states.at(-1)?.phase,'notice');assert.equal(JSON.stringify(states).includes('private'),false);
});

test('invalid coordinates cancel safely without suppressing ordinary scrolling',async()=>{
  const f=fixture();f.controller.start([point(NaN)]);assert.equal(f.controller.move([point(300)]),false);await f.controller.end();
  f.arm();assert.equal(f.controller.move([point(Infinity)]),false);await f.controller.end();assert.equal(f.requests.length,0);
});
