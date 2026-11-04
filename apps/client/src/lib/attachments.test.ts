import {expect,it,vi} from 'vitest';
import {formAttachments} from './server/attachments.js';
import {parseAttachments} from '@racrproto/client-support/attachments';
import {parseDraftContent} from '@racrproto/client-support/drafts';
const file={filename:'test.log',media_type:'text/plain',size:3,digest:{algorithm:'sha-256',value:'A'.repeat(43)}};
it('uploads file bytes separately and preserves previously saved references',async()=>{
 const form=new FormData();form.set('savedAttachments',JSON.stringify([file]));form.append('attachment',new File(['log'],'test.log'));
 const request=vi.fn(async()=>file);
 expect(await formAttachments(form,{request} as never)).toEqual([file,file]);
 expect(request).toHaveBeenCalledWith('/attachments',{filename:'test.log',data:'bG9n'});
});
it('preflights the aggregate before any upload and validates draft metadata',async()=>{
 const form=new FormData();form.set('savedAttachments',JSON.stringify([{...file,size:25*1024*1024}]));form.append('attachment',new File(['x'],'test.txt'));
 const request=vi.fn();await expect(formAttachments(form,{request} as never)).rejects.toThrow('25 MiB');expect(request).not.toHaveBeenCalled();
 expect(()=>parseAttachments([{...file,filename:'../test.log'}])).toThrow();
 const content={audience:'connections',category:'',connections:[],title:'',text:'',alt:'',caption:'',allowReply:false,header:null,forward:null,attachments:[file]};
 expect(parseDraftContent(content).attachments).toEqual([file]);
 expect(()=>parseDraftContent({...content,attachments:[{...file,media_type:'text/html'}]})).toThrow();
});
it('uploads PNG attachments with their original filename',async()=>{
 const form=new FormData();form.append('attachment',new File(['fixture'],'screen.PNG',{type:'image/png'}));
 const png={...file,filename:'screen.PNG',media_type:'image/png',size:7};
 const request=vi.fn(async()=>png);expect(await formAttachments(form,{request} as never)).toEqual([png]);
 expect(request).toHaveBeenCalledWith('/attachments',{filename:'screen.PNG',data:'Zml4dHVyZQ'});
});
it.each([['photo.jpg','image/jpeg'],['photo.JPEG','image/jpeg'],['photo.webp','image/webp']])('uploads %s attachments',async(filename,media_type)=>{
 const form=new FormData();form.append('attachment',new File(['fixture'],filename,{type:media_type}));
 const metadata={...file,filename,media_type,size:7};const request=vi.fn(async()=>metadata);
 expect(await formAttachments(form,{request} as never)).toEqual([metadata]);
 expect(request).toHaveBeenCalledWith('/attachments',{filename,data:'Zml4dHVyZQ'});
});
it('keeps browser metadata validation aligned with the protocol codec',async()=>{
 const {fromDiagnosticJson,encodePayload}=await import('@racrproto/codec');
 const candidates=[
  [file],[],[{...file,size:25*1024*1024}],[{...file,size:25*1024*1024+1}],
  Array(21).fill(file),[{...file,extra:true}],[{...file,size:1.5}],
  ...['.hidden.txt','../test.log','e\u0301.txt','bad\ud800.txt','x'.repeat(256)+'.txt','photo.png','test.LOG'].map(filename=>[{...file,filename}]),
  ...['A'.repeat(42)+'B','A'.repeat(42)+'_','A'.repeat(43)+'=','A'.repeat(42)+'8'].map(value=>[{...file,digest:{algorithm:'sha-256',value}}]),
  [{...file,digest:{...file.digest,extra:true}}],
 ];
 const accepts=(fn:()=>unknown)=>{try{fn();return true;}catch{return false;}};
 for(const attachments of candidates){
  const expected=attachments.length===0||accepts(()=>encodePayload('hail.body.spt-1',fromDiagnosticJson('hail.body.spt-1',{version:1,profile:'spt-1',blocks:[],attachments} as never)));
  expect(accepts(()=>parseAttachments(attachments)),JSON.stringify(attachments)).toBe(expected);
 }
});
it('ignores unselected multipart file controls while rejecting selected empty files',async()=>{
 const blank=new File([],'');
 // Bun represents filename="" multipart parts with an undefined name.
 Object.defineProperty(blank,'name',{value:undefined});
 const request=vi.fn(),form={get:()=>null,getAll:()=>[blank]} as unknown as FormData;
 expect(await formAttachments(form,{request} as never)).toEqual([]);expect(request).not.toHaveBeenCalled();
 const selected=new FormData();selected.append('attachment',new File([],'empty.txt'));
 await expect(formAttachments(selected,{request} as never)).rejects.toThrow('empty');
});
