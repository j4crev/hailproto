<script lang="ts">
  import {onMount,untrack} from 'svelte';
  import {toPortable,fromPortable,emptyBody,validateBody,pngAsset,diagnostics,assertCapabilities,type BuilderDraft,type PortableBundle,type Diagnostic} from './core.js';
  import {renderBody} from './rendering.js';
  import Renderer from './Renderer.svelte';
  let {initial={version:1,body:emptyBody()},profiles=['spt-2','spt-3'],showPreview=true,revision=0,onchange=()=>{},onsave,onhandoff}: {
    initial?:BuilderDraft;profiles?:readonly string[];showPreview?:boolean;revision?:number;
    onchange?:(draft:BuilderDraft|null,issues:Diagnostic[])=>void;
    onsave?:(draft:BuilderDraft,expectedRevision:number)=>Promise<{revision:number}>;
    onhandoff?:(draft:BuilderDraft)=>void;
  }=$props();
  let bundle=$state<PortableBundle>(untrack(()=>toPortable(initial.body)));
  let issues=$state<Diagnostic[]>([]),notice=$state('');
  let draft=$state<BuilderDraft|null>(null),valid=$state<BuilderDraft|null>(null),hostRevision=$state(untrack(()=>revision)),saving=$state(false);
  let editorElement:HTMLDivElement;let dispose:(()=>void)|undefined;let mountText:typeof import('./editor.js').mountEditor;
  let generation=0,disposed=false;
  let narrow=$state(false),dark=$state(false),imagesUnavailable=$state(false);
  const header=$derived(bundle.blocks[0]?._type==='hailImage'?bundle.blocks[0]:null);
  const view=$derived(showPreview&&valid?renderBody(valid.body):null);
  $effect(()=>{hostRevision=revision;});
  function changed(){
    draft=null;valid=null;issues=[];
    try{
      const body=fromPortable($state.snapshot(bundle),{draft:true});assertCapabilities(body,profiles);draft={version:1,body};
      validateBody(body);valid=draft;
    }catch(error){issues=diagnostics(error);}
    onchange(draft?structuredClone($state.snapshot(draft)):null,$state.snapshot(issues));
  }
  function mount(){
    const mountedGeneration=++generation;
    dispose?.();dispose=mountText(editorElement,$state.snapshot(bundle.blocks.filter(b=>b._type==='block')),blocks=>{
      if(disposed||mountedGeneration!==generation)return;
      bundle={...bundle,blocks:[...(header?[header]:[]),...blocks]};changed();
    },message=>notice=message);
  }
  onMount(()=>{
    let cancelled=false;
    void import('./editor.js').then(module=>{
      if(cancelled)return;mountText=module.mountEditor;mount();changed();
    }).catch(error=>notice=String(error));
    return ()=>{cancelled=true;disposed=true;dispose?.();};
  });
  async function addImage(event:Event){
    const file=(event.currentTarget as HTMLInputElement).files?.[0];if(!file)return;
    try{
      const asset=await pngAsset(new Uint8Array(await file.arrayBuffer()));if(disposed)return;
      // Verify actual decoding in addition to authoritative structural/digest checks.
      const bitmap=await createImageBitmap(file);bitmap.close();if(disposed)return;
      bundle={...bundle,assets:[asset],blocks:[{_type:'hailImage',_key:crypto.randomUUID(),asset:asset.id,alt:''},...bundle.blocks.filter(b=>b._type==='block')]};changed();
    }catch(error){notice=error instanceof Error?error.message:'Invalid PNG';}
    (event.target as HTMLInputElement).value='';
  }
  function metadata(field:'alt'|'caption',value:string){if(!header)return;const updated={...header,[field]:value.normalize('NFC')};if(field==='caption'&&!value)delete updated.caption;bundle={...bundle,blocks:[updated,...bundle.blocks.slice(1)]};changed();}
  async function save(){
    if(!draft||!onsave||saving)return;saving=true;const snapshot=structuredClone($state.snapshot(draft));
    try{const result=await onsave(snapshot,hostRevision);if(!Number.isSafeInteger(result.revision)||result.revision<=hostRevision)throw Error('Host returned an invalid save revision');hostRevision=result.revision;notice='Draft saved.';}
    catch(error){notice=error instanceof Error?error.message:'Host save failed; your edits are retained.';}finally{saving=false;}
  }
</script>
<div class="content-builder">
  {#if notice}<p role="status">{notice}</p>{/if}
  <div class="builder-actions">
    {#if profiles.includes('spt-3')}<label>Header PNG <input aria-label="Header PNG" type="file" accept="image/png" onchange={addImage}/></label>{/if}
  </div>
  {#if header}<fieldset><legend>Bundled header</legend>
    <label>Image description <input aria-label="Image description" value={String(header.alt??'')} maxlength="1024" oninput={e=>metadata('alt',e.currentTarget.value)}/></label>
    <label>Caption <input aria-label="Image caption" value={String(header.caption??'')} maxlength="1024" oninput={e=>metadata('caption',e.currentTarget.value)}/></label>
    <button type="button" onclick={()=>{bundle={...bundle,assets:[],blocks:bundle.blocks.slice(1)};changed();}}>Remove header</button>
    <p>Static PNG: up to 192 KiB, 2400 × 1200, and 2 million pixels. A description is required.</p>
  </fieldset>{/if}
  <div class="editor" bind:this={editorElement}></div>
  {#if issues.length}<ul role="alert">{#each issues as issue}<li>{issue.message}</li>{/each}</ul>{/if}
  {#if showPreview}<section aria-label="Recipient preview">
    <div class="preview-controls"><h2>Recipient preview</h2><label><input type="checkbox" bind:checked={narrow}/> Narrow</label><label><input type="checkbox" bind:checked={dark}/> Dark</label><label><input type="checkbox" bind:checked={imagesUnavailable}/> Images unavailable</label></div>
    <div class="preview" class:narrow class:dark>{#if view}<Renderer blocks={view.blocks} header={view.header} {imagesUnavailable}/>{:else}<p>Fix the validation errors to preview or hand off this content.</p>{/if}</div>
  </section>{/if}
  {#if onsave||onhandoff}<div class="builder-actions">
    {#if onsave}<button type="button" disabled={!draft||saving} onclick={save}>{saving?'Saving…':'Save as Draft'}</button>{/if}
    {#if onhandoff}<button type="button" disabled={!valid} onclick={()=>{if(valid)onhandoff(structuredClone($state.snapshot(valid)));}}>Use this content</button>{/if}
  </div>{/if}
</div>
<style>
  .content-builder{font:16px/1.5 system-ui,sans-serif;color:var(--color-ink,#173a35);min-width:0}button,input{font:inherit;max-width:100%;box-sizing:border-box}button{padding:.45em .7em;cursor:pointer}button:disabled{cursor:default;opacity:.5}label{display:flex;gap:.4em;align-items:center;flex-wrap:wrap}fieldset{display:grid;gap:.75em;min-width:0;margin:1em 0}.builder-actions,.preview-controls{display:flex;flex-wrap:wrap;gap:.75em;align-items:center}.builder-actions{margin:1em 0}.builder-actions label{font-size:.85em}
  .editor{margin:1em 0;border:1px solid var(--color-line,#aabcb8);border-radius:.5em;padding:.75em;min-width:0}
  .editor :global(.builder-toolbar){display:flex;gap:.35em;flex-wrap:wrap;align-items:center;margin:-.25em -.25em 1em;padding-bottom:.65em;border-bottom:1px solid var(--color-line,#aabcb8)}
  .editor :global(.builder-tool-group){display:flex;align-items:center;gap:2px;padding-right:.35em;border-right:1px solid var(--color-line,#aabcb8)}
  .editor :global(.builder-toolbar button),.editor :global(.builder-toolbar select),.editor :global(.builder-toolbar summary){font:inherit;font-size:13px;color:var(--color-muted,#526964);background:transparent;border:0;border-radius:6px;min-width:36px;min-height:36px;padding:6px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:none}
  .editor :global(.builder-toolbar select){max-width:130px;padding-inline:8px}
  .editor :global(.builder-toolbar button:hover:not(:disabled)),.editor :global(.builder-toolbar summary:hover),.editor :global(.builder-toolbar select:hover){background:var(--color-brand-soft,#e4f2ec);color:var(--color-ink,#173a35)}
  .editor :global(.builder-toolbar button[aria-pressed=true]){background:var(--color-brand-soft,#e4f2ec);color:var(--color-brand-strong,#127365)}
  .editor :global(.builder-toolbar button:disabled){opacity:.35;cursor:default}
  .editor :global(.builder-toolbar :is(button,select,summary):focus-visible){outline:2px solid var(--color-brand,#127365);outline-offset:2px}
  .editor :global(.builder-toolbar strong),.editor :global(.builder-toolbar em){font-size:16px}
  .editor :global(.builder-code-icon){font-family:monospace;font-size:13px}
  .editor :global(.builder-more){position:relative;margin-left:auto}
  .editor :global(.builder-more summary){list-style:none}
  .editor :global(.builder-more summary::-webkit-details-marker){display:none}
  .editor :global(.builder-more[open] summary){background:var(--color-brand-soft,#e4f2ec);color:var(--color-ink,#173a35)}
  .editor :global(.builder-block-actions){position:absolute;right:0;top:calc(100% + 6px);z-index:10;display:grid;min-width:170px;padding:5px;border:1px solid var(--color-line,#aabcb8);border-radius:10px;background:var(--color-surface,#fff);box-shadow:0 8px 24px #0002}
  .editor :global(.builder-block-actions button){justify-content:flex-start;padding-inline:12px;white-space:nowrap}
  .editor :global([contenteditable=true]){min-height:16em;outline-offset:4px;white-space:pre-wrap;overflow-wrap:anywhere}.editor :global(.builder-link){text-decoration:underline;color:var(--color-brand,#127365)}
  @media(pointer:coarse){.editor :global(.builder-toolbar button),.editor :global(.builder-toolbar select),.editor :global(.builder-toolbar summary){min-width:44px;min-height:44px}}
  .preview{padding:1.25em;border:1px solid #aabcb8;background:#fff;color:#173a35;--color-canvas:#edf3f2;--color-muted:#526964;--color-brand:#127365;max-width:100%;box-sizing:border-box}.preview.narrow{width:360px}.preview.dark{background:#142c29;color:#e2efec;--color-canvas:#24443f;--color-muted:#afc8c2;--color-brand:#7de0c9}
  .preview-controls h2{font-size:1.1em}input[type=file]{width:16em}.preview-controls{margin-top:1.5em}input:focus-visible,button:focus-visible{outline:2px solid #127365;outline-offset:3px}
  @media(max-width:600px){.builder-actions{align-items:stretch;flex-direction:column}.editor{padding:.5em}.preview{padding:.75em}}
</style>
