import {test} from 'node:test';
import assert from 'node:assert/strict';
import {purgeAllAndResetSettings} from '../core/destructive-safety.js';
import {writeBarrier} from '../utils/keyed-mutex.js';

test('C03 #218: global purge closes admission before cancelling jobs',async()=>{
    const settings={enabled:true,collection:'preserve'};let cancelled=false,requests=0;
    await assert.rejects(purgeAllAndResetSettings({contractVerified:true,settings,
        cancelJobs:()=>{assert.equal(writeBarrier.closed,true);cancelled=true;},
        awaitTrackedWrites:async()=>({uncertain:true}),
        requestPurge:async()=>{requests++;return {ok:true};},persistSettings:()=>{}
    }),/uncertain writes/);
    assert.equal(cancelled,true);assert.equal(requests,0);
    assert.deepEqual(settings,{enabled:true,collection:'preserve'});
    assert.equal(writeBarrier.closed,false);
});
test('C03 #218: blocked unknown-contract purge does not cancel healthy jobs or issue network requests',async()=>{
    let cancellations=0,network=0;
    await assert.rejects(purgeAllAndResetSettings({settings:{enabled:true},
        cancelJobs:()=>cancellations++,requestPurge:async()=>network++,persistSettings:()=>{}
    }),/no verified backend purge contract/);
    assert.equal(cancellations,0);assert.equal(network,0);
});
