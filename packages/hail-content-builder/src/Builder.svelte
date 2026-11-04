<script lang="ts">
  import {onMount,untrack} from 'svelte';
  import {toPortable,fromPortable,emptyBody,pngAsset,diagnostics,assertCapabilities,type BuilderDraft,type PortableBundle,type PortableBlock,type Diagnostic} from './core.js';
  import {BuilderStorage,type Recovery} from './storage.js';
  import {renderBody} from './rendering.js';
  import Renderer from './Renderer.svelte';
  let {initial={version:1,body:emptyBody()},profiles=['spt-2','spt-3'],storageKey,revision=0,onchange=()=>{},onsave,onhandoff}: {
    initial?:BuilderDraft;profiles?:readonly string[];storageKey:string;revision?:number;
    onchange?:(draft:BuilderDraft|null,issues:Diagnostic[])=>void;
    onsave?:(draft:BuilderDraft,expectedRevision:number)=>Promise<{revision:number}>;
    onhandoff?:(draft:BuilderDraft)=>void;
  }=$props();
  let bundle=$state<PortableBundle>(untrack(()=>toPortable(initial.body)));
  let issues=$state<Diagnostic[]>([]),notice=$state(''),status=$state('Local recovery starting…');
  let valid=$state<BuilderDraft|null>(null),hostRevision=$state(untrack(()=>revision)),saving=$state(false);
  let editorElement:HTMLDivElement;let dispose:(()=>void)|undefined;let mountText:typeof import('./editor.js').mountEditor;
  let store:BuilderStorage|undefined,localRevision=0,timer:ReturnType<typeof setTimeout>|undefined;
  let generation=0;
  let queue=Promise.resolve();
  let recoveryError=$state('');
  let recovered=$state<Recovery|null>(null),ready=false,disposed=false;
  let narrow=$state(false),dark=$state(false),imagesUnavailable=$state(false);
  const header=$derived(bundle.blocks[0]?._type==='hailImage'?bundle.blocks[0]:null);
  const view=$derived(valid?renderBody(valid.body):null);
  $effect(()=>{hostRevision=revision;});
  function check(){
    try{const body=fromPortable($state.snapshot(bundle));assertCapabilities(body,profiles);valid={version:1,body};issues=[];}
    catch(error){valid=null;issues=diagnostics(error);}
    onchange(valid?structuredClone($state.snapshot(valid)):null,$state.snapshot(issues));
  }
  function changed(){
    check();if(!ready||recovered||!store)return;
    status='Unsaved local changes';clearTimeout(timer);
    timer=setTimeout(()=>{void persist();},350);
  }
  function persist(){queue=queue.then(writeRecovery);return queue;}
  async function writeRecovery(){
    if(!store||recovered)return;
    const snapshot=$state.snapshot(bundle),base=hostRevision;
    try{const next=await store.save(snapshot,base,localRevision);localRevision=next.revision;status='Saved on this device';}
    catch(error){status=error instanceof Error?error.message:'Local save failed. Export your work.';}
  }
  function mount(){
    const mountedGeneration=++generation;
    dispose?.();dispose=mountText(editorElement,$state.snapshot(bundle.blocks.filter(b=>b._type==='block')),blocks=>{
      if(disposed||mountedGeneration!==generation)return;
      bundle={...bundle,blocks:[...(header?[header]:[]),...blocks]};changed();
    },message=>notice=message);
  }
  // Recovery may contain an unfinished image description; validate every other field
  // before allowing it into the editor. No unsupported nodes are silently dropped.
  function recoverable(value:PortableBundle){
    const candidate=structuredClone(value),first=candidate.blocks?.[0];
    if(first?._type==='hailImage'&&first.alt==='')first.alt='Unfinished image description';
    fromPortable(candidate);return value;
  }
  onMount(()=>{
    let cancelled=false;
    void import('./editor.js').then(module=>{
      if(cancelled)return;mountText=module.mountEditor;
      try{
        if(!navigator.locks)throw Error('Local autosave unavailable in this browser. Use Save or Export.');
        store=new BuilderStorage(localStorage,navigator.locks,`hail-builder:v1:${storageKey}`);
        const previous=store.read();if(previous){localRevision=previous.revision;recovered=previous;status='Recovery copy available';try{recoverable(previous.bundle);}catch(error){recoveryError=error instanceof Error?error.message:'Recovery content needs repair';}}
        else status='Local recovery ready';
      }catch(error){status=error instanceof Error?error.message:'Local recovery unavailable';}
      ready=true;mount();check();
    }).catch(error=>notice=String(error));
    return ()=>{cancelled=true;disposed=true;clearTimeout(timer);if(ready&&!recovered)void persist();dispose?.();};
  });
  function restore(){if(!recovered||recoveryError||recovered.baseRevision!==hostRevision)return;bundle=recoverable($state.snapshot(recovered.bundle));recovered=null;mount();changed();}
  function useCurrent(){recovered=null;recoveryError='';changed();}
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
  function download(value:unknown,name:string){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function importBundle(event:Event){
    const file=(event.currentTarget as HTMLInputElement).files?.[0];if(!file)return;
    try{if(file.size>1000000)throw Error('Bundle exceeds 1,000,000 bytes');const parsed=JSON.parse(await file.text());const body=fromPortable(parsed);assertCapabilities(body,profiles);bundle=parsed;mount();changed();notice='Bundle imported.';}
    catch(error){notice=error instanceof Error?error.message:'Invalid bundle';}
    (event.target as HTMLInputElement).value='';
  }
  async function save(){
    if(!valid||!onsave||saving)return;saving=true;const snapshot=structuredClone($state.snapshot(valid));
    try{const result=await onsave(snapshot,hostRevision);if(!Number.isSafeInteger(result.revision)||result.revision<=hostRevision)throw Error('Host returned an invalid save revision');hostRevision=result.revision;notice='Draft saved by host.';await persist();}
    catch(error){notice=error instanceof Error?error.message:'Host save failed; your edits are retained.';}finally{saving=false;}
  }
</script>
<div class="content-builder">
  <p class="intro">Write your message. Preview exactly the content readers receive.</p>
  <p role="status" aria-live="polite">{status}</p>
  {#if recovered}<aside aria-label="Draft recovery"><p>A local recovery copy is available{recovered.baseRevision!==hostRevision?' from an older host revision. Export it to preserve your work; the current server draft will not be overwritten.':'.'}</p>{#if recoveryError}<p role="alert">{recoveryError} Export this recovery copy to retain it.</p>{/if}<button type="button" disabled={!!recoveryError||recovered.baseRevision!==hostRevision} onclick={restore}>Restore local draft</button><button type="button" onclick={()=>download(recovered?.bundle,'recovered-content.json')}>Export recovery</button><button type="button" onclick={useCurrent}>Use current draft</button></aside>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  <div class="builder-actions">
    {#if profiles.includes('spt-3')}<label>Header PNG <input aria-label="Header PNG" type="file" accept="image/png" onchange={addImage}/></label>{/if}
    <label>Import Portable Text bundle <input type="file" accept="application/json,.json" onchange={importBundle}/></label>
    <button type="button" onclick={()=>download($state.snapshot(bundle),'portable-text-bundle.json')}>Export bundle</button>
    {#if onsave}<button type="button" disabled={!valid||saving} onclick={save}>{saving?'Saving…':'Save draft'}</button>{/if}
    {#if onhandoff}<button type="button" disabled={!valid} onclick={()=>{if(valid)onhandoff(structuredClone($state.snapshot(valid)));}}>Use this content</button>{/if}
  </div>
  {#if header}<fieldset><legend>Bundled header</legend>
    <label>Image description <input aria-label="Image description" value={String(header.alt??'')} maxlength="1024" oninput={e=>metadata('alt',e.currentTarget.value)}/></label>
    <label>Caption <input aria-label="Image caption" value={String(header.caption??'')} maxlength="1024" oninput={e=>metadata('caption',e.currentTarget.value)}/></label>
    <button type="button" onclick={()=>{bundle={...bundle,assets:[],blocks:bundle.blocks.slice(1)};changed();}}>Remove header</button>
    <p>Static PNG: up to 192 KiB, 2400 × 1200, and 2 million pixels. A description is required.</p>
  </fieldset>{/if}
  <div class="editor" bind:this={editorElement}></div>
  {#if issues.length}<ul role="alert">{#each issues as issue}<li>{issue.message}</li>{/each}</ul>{/if}
  <section aria-label="Recipient preview">
    <div class="preview-controls"><h2>Recipient preview</h2><label><input type="checkbox" bind:checked={narrow}/> Narrow</label><label><input type="checkbox" bind:checked={dark}/> Dark</label><label><input type="checkbox" bind:checked={imagesUnavailable}/> Images unavailable</label></div>
    <div class="preview" class:narrow class:dark>{#if view}<Renderer blocks={view.blocks} header={view.header} {imagesUnavailable}/>{:else}<p>Fix the validation errors to preview or hand off this content.</p>{/if}</div>
  </section>
</div>
<style>
  .content-builder{font:16px/1.5 system-ui,sans-serif;color:var(--color-ink,#173a35);min-width:0}.intro{font-size:1.1em}button,input{font:inherit;max-width:100%;box-sizing:border-box}button{padding:.45em .7em;cursor:pointer}button:disabled{cursor:default;opacity:.5}label{display:flex;gap:.4em;align-items:center;flex-wrap:wrap}fieldset{display:grid;gap:.75em;min-width:0;margin:1em 0}aside{padding:1em;border:2px solid #b87919}aside button{margin:.2em}.builder-actions,.preview-controls{display:flex;flex-wrap:wrap;gap:.75em;align-items:center}.builder-actions{margin:1em 0}.builder-actions label{font-size:.85em}
  .editor{margin:1em 0;border:1px solid var(--color-line,#aabcb8);border-radius:.5em;padding:.75em;min-width:0}
  .editor :global(.builder-toolbar){display:flex;gap:.3em;flex-wrap:wrap;margin-bottom:1em}.editor :global(button),.editor :global(select){font:inherit;max-width:100%;padding:.4em;cursor:pointer}.editor :global(button[aria-pressed=true]){background:#bde7df;color:#173a35}.editor :global([contenteditable=true]){min-height:16em;outline-offset:4px;white-space:pre-wrap;overflow-wrap:anywhere}.editor :global(.builder-link){text-decoration:underline;color:var(--color-brand,#127365)}
  .preview{padding:1.25em;border:1px solid #aabcb8;background:#fff;color:#173a35;--color-canvas:#edf3f2;--color-muted:#526964;--color-brand:#127365;max-width:100%;box-sizing:border-box}.preview.narrow{width:360px}.preview.dark{background:#142c29;color:#e2efec;--color-canvas:#24443f;--color-muted:#afc8c2;--color-brand:#7de0c9}
  .preview-controls h2{font-size:1.1em}input[type=file]{width:16em}.preview-controls{margin-top:1.5em}input:focus-visible,button:focus-visible{outline:2px solid #127365;outline-offset:3px}
  @media(max-width:600px){.builder-actions{align-items:stretch;flex-direction:column}.editor{padding:.5em}.preview{padding:.75em}}
</style>
