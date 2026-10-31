import {expect,it} from 'vitest';
import {groupConnectionMessages,type ConnectionNode} from '../src/accounts/connection-threads.js';
const node=(messageId:string,options:Partial<ConnectionNode>={}):ConnectionNode=>({sender:'me',messageId,recipient:'peer',sent:true,visible:true,isRead:true,at:'2026-01-01T00:00:00.000Z',parentSender:null,parentId:null,batch:null,...options});
it('groups multiple reply sources through a private send batch and shows the oldest unread',()=>{
  const groups=groupConnectionMessages([
    node('a',{batch:'batch',recipient:'alex'}),node('b',{batch:'batch',recipient:'maya'}),
    node('c',{sender:'alex',sent:false,isRead:false,parentSender:'me',parentId:'a',at:'2026-01-02T00:00:00.000Z'}),
    node('d',{sender:'maya',sent:false,isRead:false,parentSender:'me',parentId:'b',at:'2026-01-03T00:00:00.000Z'}),
    node('other',{sender:'alex',sent:false,isRead:false}),
  ]);
  expect(groups).toHaveLength(2);
  const group=groups.find(g=>g.unread===2)!;
  expect(group.representative?.messageId).toBe('c');
  expect(group.activity).toBe('2026-01-03T00:00:00.000Z');
  expect(group.messages).toHaveLength(3);
  expect(group.messages.filter(m=>m.sent)).toHaveLength(1);
});
it('retains deleted connectors without displaying or counting them; all-read uses latest received',()=>{
  const groups=groupConnectionMessages([node('a'),node('b',{sender:'alex',sent:false,visible:false,isRead:false,parentSender:'me',parentId:'a'}),
    node('c',{sender:'me',parentSender:'alex',parentId:'b'}),node('d',{sender:'alex',sent:false,parentSender:'me',parentId:'c',at:'2026-01-02T00:00:00.000Z'})]);
  expect(groups).toHaveLength(1);expect(groups[0]!.unread).toBe(0);expect(groups[0]!.messages).toHaveLength(3);expect(groups[0]!.representative?.messageId).toBe('d');
});
it('does not group missing parents or coincidentally shared recipient batch values; handles cycles',()=>{
  expect(groupConnectionMessages([node('a',{sent:false,batch:'x',parentSender:'missing',parentId:'z'}),node('b',{sent:false,batch:'x',parentSender:'missing',parentId:'z'})])).toHaveLength(2);
  expect(groupConnectionMessages([node('a',{parentSender:'me',parentId:'b'}),node('b',{parentSender:'me',parentId:'a'})])).toHaveLength(1);
});
it('does not truncate large conversations before choosing the oldest unread',()=>{
  const nodes=Array.from({length:200},(_,i)=>node(String(i),{sent:false,isRead:i===0,parentSender:i?'me':null,parentId:i?String(i-1):null,at:new Date(Date.UTC(2026,0,1,0,i)).toISOString()}));
  const [group]=groupConnectionMessages(nodes);expect(group!.unread).toBe(199);expect(group!.representative!.messageId).toBe('1');expect(group!.messages).toHaveLength(200);
});
