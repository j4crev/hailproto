// Local-only visual fixture provider. Never imports production configuration or credentials.
// Build first, then: bun scripts/preview-design.ts. All changes disappear on restart.
import {createWebCryptoSigner, signPayload, encodeBase64Url, type HailGrant, type HailSenderProfile} from '@hailproto/codec';
import {uuidV7} from '../../server/src/identity/uuid-v7.js';

const port = Number(process.env.HAIL_DESIGN_PORT || 4173);
const origin = `http://localhost:${port}`;
const did = 'did:plc:' + 'a'.repeat(24);
const address = 'jamie@haili.example.com';
const session = 'hails_' + 'D'.repeat(43);
const started = Date.now();
const date = (hours: number) => new Date(started - hours * 3600000).toISOString();
const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const signer = createWebCryptoSigner(did + '#hail-identity', keys.privateKey);
const digest = async (bytes: Uint8Array) => encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))));
const png = new Uint8Array(await Bun.file(new URL('./fixtures/design-header.png', import.meta.url)).arrayBuffer());
const image = {version:1, assets:[{id:'hero', role:'header', media_type:'image/png', loading:'bundled', size:png.length, width:960, height:320,
  data:encodeBase64Url(png), digest:{algorithm:'sha-256', value:await digest(png)}}]};
const block = (text: string, style = 'normal') => ({_type:'block', _key:crypto.randomUUID(), style, markDefs:[], children:[{_type:'span', _key:crypto.randomUUID(), text, marks:[]}]});
const body = (title: string, text: string, illustrated = false) => ({version:1, profile:illustrated?'spt-3':'spt-2', ...(illustrated?{assets:image}:{}),
  blocks:[...(illustrated?[{_type:'spt.image', asset:'hero', alt:'Fieldnotes autumn collection. A little room to grow. 20% off this weekend.'}]:[]),
    ...(title?[block(title, 'h1')]:[]), ...text.split('\n\n').map(text => block(text))]});
const senders = [
  {did:'did:plc:'+'b'.repeat(24),address:'hello@fieldnotes.example.com'},
  {did:'did:plc:'+'c'.repeat(24),address:'essays@quietinternet.example.com'},
  {did:'did:plc:'+'d'.repeat(24),address:'studio@north.example.com'},
  {did:'did:plc:'+'e'.repeat(24),address:'alex@connections.example.com'},
];
const connectionId = uuidV7();
const messages = [
  {sender:senders[0], title:'Your weekend, a little greener', text:'Hello Jamie,\n\nA change of season is a good excuse to make a little space. A sunny windowsill. A quieter corner. Something green beside your morning coffee.\n\nOur autumn collection brings together planters and everyday essentials made to stay with you. Take 20% off this weekend, with our thanks.\n\nUntil next time,\nThe Fieldnotes team',image:true,hours:1},
  {sender:senders[1], title:'What happens when we slow down?',text:'On making space for the things that deserve our attention—and letting the rest pass by.\n\nThis week, a small experiment: leave one afternoon unplanned. See what happens when there is nothing to catch up on.',hours:18},
  {sender:senders[2], title:'A new chapter in the studio',text:'Sketches, experiments, and a first look at what we are making next.\n\nWe have spent the last few weeks exploring a new collection. Here is a little of the thinking behind it.',hours:24,read:true},
  {sender:senders[3], title:'Saturday at the market?',text:'Would you like to meet around ten? There is a new coffee stand I think you would like.',hours:2,connection:true},
  {sender:senders[3], title:'The photos turned out beautifully',text:'Thanks again for sending them over. That last one is my favorite.',hours:40,connection:true,read:true},
].map(m => ({messageId:uuidV7(),sender:m.sender.did,senderAddress:m.sender.address,recipient:did,category:m.connection?null:'general',
  kind:m.connection?'connection':'subscription',isRead:!!m.read,deliveredAt:date(m.hours),body:body(m.title,m.text,!!m.image),
  ...(m.connection?{connection:{id:connectionId,epoch:1,active:true}}:{reply:{allowed:true,until:Math.floor(started/1000)+6*86400},replyAvailable:true})}));
// A second incoming reply makes the unread-count preview observable.
const firstConnection=messages[3];
const secondConnection={...firstConnection,messageId:uuidV7(),deliveredAt:date(1),body:body('Saturday at the market?','There is also a new bakery next door. We could stop there afterward.'),isRead:false};
messages.push(secondConnection);
const sent = [{messageId:uuidV7(),sender:did,recipient:senders[3].did,recipientAddress:senders[3].address,category:null,kind:'message',createdAt:date(5),state:'delivered',revision:2,reason:null,retryAt:null,
  recipientSummary:{count:1,address:senders[3].address,did:senders[3].did},body:body('See you Saturday','Ten sounds good! Looking forward to catching up.')}];
const grants = await Promise.all(senders.slice(0,3).map(async sender => {
  const payload: HailGrant = {type:'hail.grant',version:1,grant_id:uuidV7(),revision:1,previous:null,grantor:did,grantee:sender.did,
    scope:[{type:'categories',values:['general']}],status:'active',issued_at:Math.floor(started/1000),updated_at:Math.floor(started/1000),expires_at:null,
    consent_context:{grantee_address:sender.address,address_binding_hash:{algorithm:'sha-256',value:new Uint8Array(32)},sender_profile_hash:{algorithm:'sha-256',value:new Uint8Array(32)}},key_id:did+'#hail-identity'};
  const bytes = await signPayload('hail.grant',payload,signer);
  return {payload,representation:{type:'hailp.grant',version:1,cose:encodeBase64Url(bytes),digest:await digest(bytes),localRole:'grantor'}};
}));
const profile: HailSenderProfile = {type:'hail.sender-profile',version:2,did,revision:1,display_name:'Jamie Davis',description:'Notes from the neighborhood.',offers_uncategorized:false,
  categories:[{id:'essays',label:'Essays',description:'Occasional thoughts and discoveries.'},{id:'general',label:'General'}],updated_at:Math.floor(started/1000),key_id:did+'#hail-messaging'};
const profileBytes = await signPayload('hail.sender-profile',profile,createWebCryptoSigner(profile.key_id,keys.privateKey));
const profileResponse = {type:'hailp.sender-profile',version:1,revision:1,cose:encodeBase64Url(profileBytes),digest:await digest(profileBytes)};
const trash = new Map<string,string>();
const deleted = new Set<string>();
const preferences = {theme:'system',showHeaderImages:true,trashEnabled:true};
const json = (data: unknown, status = 200) => Response.json(data,{status,headers:{'Cache-Control':'no-store','Content-Type':'application/json'}});
const reserve = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const guiPort = reserve.port!;reserve.stop(true);
let gui: ReturnType<typeof Bun.spawn> | undefined;
const server = Bun.serve({hostname:'127.0.0.1',port,async fetch(request) {
  const url = new URL(request.url), path = decodeURIComponent(url.pathname);
  // Binding and Host checks keep this unauthenticated fixture off the network.
  if(![`localhost:${port}`,`127.0.0.1:${port}`].includes(url.host))return new Response('Local preview only',{status:403});
  if(request.headers.has('origin') && request.headers.get('origin')!==origin)return new Response('Local preview only',{status:403});
  if(!path.startsWith('/api/')) {
    const headers = new Headers(request.headers);
    headers.set('cookie',`hail_session=${session}`);
    // Bun fetch decompresses responses; request identity so forwarded asset headers match their bytes.
    headers.set('accept-encoding','identity');
    try {return await fetch(`http://127.0.0.1:${guiPort}${url.pathname}${url.search}`,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer(),redirect:'manual'});}
    catch {return new Response('Local preview is starting. Refresh in a moment.',{status:503});}
  }
  const input = request.method==='POST' ? await request.json().catch(()=>({})) as Record<string,any> : {};
  if(path==='/api/v1/account/message-preferences') {
    if(request.method==='POST') {
      if(['system','light','dark'].includes(input.theme))preferences.theme=input.theme;
      if(typeof input.showHeaderImages==='boolean')preferences.showHeaderImages=input.showHeaderImages;
      if(typeof input.trashEnabled==='boolean'){preferences.trashEnabled=input.trashEnabled;if(!input.trashEnabled){for(const id of trash.keys())deleted.add(id);trash.clear();}}
    }
    return json(preferences);
  }
  const action = path.match(/^\/api\/v1\/account\/inbox\/([^/]+)\/([^/]+)\/(mark-read|mark-unread|delete)$/);
  if(action && request.method==='POST') {
    const m = messages.find(m=>m.sender===action[1]&&m.messageId===action[2]);if(!m)return json({},404);
    if(action[3]==='delete'){if(preferences.trashEnabled)trash.set(m.messageId,new Date().toISOString());else deleted.add(m.messageId);return json({state:preferences.trashEnabled?'trashed':'deleted'});}
    m.isRead=action[3]==='mark-read';return json({messageId:m.messageId,isRead:m.isRead});
  }
  if(path==='/api/v1/account/trash/restore'&&request.method==='POST')return json({restored:(input.messages??[]).filter((m:{messageId:string})=>trash.delete(m.messageId)).length});
  // Sending, passkey ceremonies, profile edits and destructive account actions are not simulated.
  if(request.method!=='GET')return json({error:'This local design preview supports reading, appearance preferences, and message selection/deletion/restoration only.'},501);
  if(path==='/api/v1/account')return json({type:'hailp.account',version:1,provider:origin,accountId:'019a15fd-2bd0-7433-8afa-bd0355e0608d',address,did,migrationState:null,custodyProfile:'managed',
    monitorVerificationMode:'reduced-assurance-alpha-v1',managedProfileVersion:'hail-managed-custody-v1',identityPublicKey:null,ownerRecoveryPublicKey:null,scopes:['account:read','grants:read','messages:read','messages:write']});
  if(path==='/api/v1/account/inbox')return json({messages:messages.filter(m=>(url.searchParams.get('kind')==='connections')===(m.kind==='connection')&&!trash.has(m.messageId)&&!deleted.has(m.messageId)),next:null});
  if(path==='/api/v1/account/trash')return json({messages:messages.filter(m=>trash.has(m.messageId)).map(m=>({...m,trashedAt:trash.get(m.messageId)})),next:null});
  if(path.startsWith('/api/v1/account/inbox/')){const m=messages.find(m=>path===`/api/v1/account/inbox/${m.sender}/${m.messageId}`&&!deleted.has(m.messageId));return m?json({...m,trashedAt:trash.get(m.messageId)??null}):json({},404);}
  if(path.startsWith('/api/v1/account/threads/')){
    const root=messages.find(m=>path===`/api/v1/account/threads/${m.sender}/${m.messageId}`&&!trash.has(m.messageId)&&!deleted.has(m.messageId));
    if(!root)return json({},404);
    const related=root.messageId===firstConnection.messageId||root.messageId===secondConnection.messageId;
    const incoming=(related?[firstConnection,secondConnection]:[root]).filter(m=>!trash.has(m.messageId)&&!deleted.has(m.messageId)).map(m=>({sender:m.sender,messageId:m.messageId,sent:false,isRead:m.isRead,createdAt:m.deliveredAt,
      preview:'Saturday at the market?',inReplyTo:m.messageId===secondConnection.messageId?{sender:firstConnection.sender,messageId:firstConnection.messageId}:null,parentAvailable:m.messageId===secondConnection.messageId&&!trash.has(firstConnection.messageId)&&!deleted.has(firstConnection.messageId)}));
    const replies=related?sent.map(m=>({sender:did,messageId:m.messageId,sent:true,isRead:true,createdAt:m.createdAt,preview:'Ten sounds good! Looking forward to catching up.',inReplyTo:{sender:firstConnection.sender,messageId:firstConnection.messageId},parentAvailable:incoming.some(m=>m.messageId===firstConnection.messageId)})):[];
    return json({messages:[...incoming,...replies],truncated:false});
  }
  if(path==='/api/v1/account/sent')return json({messages:sent,next:null});
  if(path.startsWith('/api/v1/account/sent/')){const m=sent.find(m=>m.messageId===path.split('/').at(-1));return m?json(m):json({},404);}
  if(path==='/api/v1/account/grants')return json({grants:grants.filter(g=>!url.searchParams.has('sender')||g.payload.grantee===url.searchParams.get('sender')).map(g=>({grantId:g.payload.grant_id,localRole:'grantor',grantee:g.payload.grantee,status:'active'})),next:null});
  if(path.startsWith('/api/v1/account/grants/')){const grant=grants.find(g=>g.payload.grant_id===path.split('/').at(-1));return grant?json(grant.representation):json({},404);}
  if(path==='/api/v1/account/profile')return json(profileResponse);
  if(path==='/api/v1/account/custom-domains')return json({provider:origin,domains:[]});
  if(path==='/api/v1/account/connections')return json({preview:true,codes:[],connections:[{id:connectionId,did:senders[3].did,address:senders[3].address,connectedAt:date(240),remote:true}],pendingConnections:[]});
  if(path==='/api/v1/account/publications/audiences')return json({maxRecipients:100,categories:[{category:'general',subscribers:12},{category:'essays',subscribers:8}]});
  if(path==='/api/v1/account/connection-messages/targets')return json({maxRecipients:100,connections:[{connectionId,recipientDid:senders[3].did,epoch:1,address:senders[3].address}]});
  if(path==='/api/v1/auth/passkeys')return json({recentlyVerified:false,sessions:[],passkeys:[]});
  if(path==='/api/v1/registration')return json({mode:'invite',signupAvailable:false});
  return json({},404);
}});
try {
  gui = Bun.spawn(['bun','build/index.js'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,HOST:'127.0.0.1',PORT:String(guiPort),ORIGIN:origin,
    HAIL_GUI_API_ORIGIN:origin,HAIL_GUI_ORIGIN:origin,HAIL_GUI_PROVIDER:origin,HAIL_GUI_CREDENTIAL_FALLBACK:'false',HAIL_GUI_CREDENTIAL_FILE:'',HAIL_GUI_SIGNUP_PREVIEW:'false'},stdout:'inherit',stderr:'inherit'});
  console.info(`Haili design preview: ${origin}\nFictional account; no login needed. In-memory reading, theme, Trash and selection only. Restart to reset. Ctrl+C to stop.`);
  const stop=()=>{gui?.kill();server.stop(true);process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
  const code = await gui.exited;
  server.stop(true);process.exit(code);
} catch(error) {gui?.kill();server.stop(true);throw error;}
