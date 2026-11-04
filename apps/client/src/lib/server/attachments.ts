import {parseAttachments} from '@racrproto/client-support/attachments';
import type {AccountApiClient} from '@racrproto/client-support/account-api';
export async function formAttachments(form:FormData,client:Pick<AccountApiClient,'request'>){
  const saved=parseAttachments(JSON.parse(String(form.get('savedAttachments')||'[]')));
  const files=form.getAll('attachment').filter((f):f is File=>f instanceof File&&typeof f.name==='string'&&f.name!=='');
  if(files.some(f=>f.size===0))throw new Error('Attachments must not be empty.');
  if(files.length+saved.length>20||files.reduce((n,f)=>n+f.size,0)+saved.reduce((n,f)=>n+f.size,0)>25*1024*1024)throw new Error('Attach at most 20 files totaling 25 MiB.');
  for(const file of files){
    if(!/\.(pdf|txt|log|png|jpg|jpeg|webp)$/i.test(file.name))throw new Error('Choose PNG, JPEG, WebP, PDF, TXT, or LOG files.');
    saved.push(parseAttachments([await client.request('/attachments',{filename:file.name,data:Buffer.from(await file.arrayBuffer()).toString('base64url')})])[0]!);
  }
  return saved;
}
