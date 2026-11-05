import {emptyBody,parseBuilderDraft,pngAsset,type BuilderDraft} from '@racrproto/content-builder/core';
import type {DraftContent} from '@racrproto/client-support/drafts';
import {composeBlocks} from '../compose.js';

/** Convert only the editable document; loading never rewrites a stored draft. */
export async function builderDraft(content?:DraftContent):Promise<BuilderDraft> {
  if(!content)return {version:1,body:emptyBody()};
  if(content.builder)return parseBuilderDraft(content.builder);
  if(content.forward)throw new Error('Forward notes use the forward composer');
  const blocks=composeBlocks(content.title,content.text);
  if(!content.header)return parseBuilderDraft({version:1,body:{version:1,profile:'spt-2',blocks}});
  const asset=await pngAsset(new Uint8Array(Buffer.from(content.header,'base64url')));
  return parseBuilderDraft({version:1,body:{version:1,profile:'spt-3',assets:{version:1,assets:[asset]},
    blocks:[{_type:'spt.image',asset:asset.id,alt:content.alt,...(content.caption?{caption:content.caption}:{})},...blocks]}});
}
