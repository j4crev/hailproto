<script lang="ts">
  import {onMount,untrack} from 'svelte';
  import {toPortable,fromPortable,emptyBody,validateBody,publicationIssues,diagnostics,assertCapabilities,type BuilderDraft,type PortableBundle,type Diagnostic} from './core.js';
  import {renderBody} from './rendering.js';
  import Renderer from './Renderer.svelte';
  let {initial={version:1,body:emptyBody()},profiles=['spt-2','spt-3'],showPreview=true,inspectorTarget,revision=0,onchange=()=>{},onsave,onhandoff}: {
    inspectorTarget?:HTMLElement;initial?:BuilderDraft;profiles?:readonly string[];showPreview?:boolean;revision?:number;
    onchange?:(draft:BuilderDraft|null,issues:Diagnostic[])=>void;
    onsave?:(draft:BuilderDraft,expectedRevision:number)=>Promise<{revision:number}>;
    onhandoff?:(draft:BuilderDraft)=>void;
  }=$props();
  let bundle=$state<PortableBundle>(untrack(()=>toPortable(initial.body)));
  let issues=$state<Diagnostic[]>([]),notice=$state(''),noticeKind=$state<'error'|'info'|'success'>('info');
  function notify(message:string,kind:'error'|'info'|'success'='error'){notice='';noticeKind=kind;notice=message;}
  let draft=$state<BuilderDraft|null>(null),valid=$state<BuilderDraft|null>(null),hostRevision=$state(untrack(()=>revision)),saving=$state(false);
  let localInspector:HTMLDivElement;let editorElement:HTMLDivElement;let dispose:(()=>void)|undefined;let mountText:typeof import('./editor.js').mountEditor;
  let generation=0,disposed=false;
  let narrow=$state(false),dark=$state(false),imagesUnavailable=$state(false);
  const visibleIssues=$derived(issues.filter(issue=>issue.code!=='unfinished-field'));
  const view=$derived(showPreview&&valid?renderBody(valid.body):null);
  $effect(()=>{hostRevision=revision;});
  function changed(){
    draft=null;valid=null;issues=[];
    try{
      const body=fromPortable($state.snapshot(bundle),{draft:true});assertCapabilities(body,profiles);draft={version:1,body};
      issues=publicationIssues(body);
      if(!issues.length){validateBody(body);valid=draft;}
    }catch(error){issues=diagnostics(error);}
    onchange(draft?structuredClone($state.snapshot(draft)):null,$state.snapshot(issues));
  }
  export function editIssue(issue:Diagnostic){
    const match=/blocks\[(\d+)\]/.exec(issue.path);
    if(match)editorElement.dispatchEvent(new CustomEvent('builder:edit-block',{detail:Number(match[1])}));
  }
  function mount(){
    const mountedGeneration=++generation;
    dispose?.();dispose=mountText(editorElement,$state.snapshot(bundle.blocks),(blocks,assets)=>{
      if(disposed||mountedGeneration!==generation)return;
      bundle={...bundle,blocks,assets};changed();
    },(message,kind)=>notify(message,kind),$state.snapshot(bundle.assets),profiles.includes('spt-3'),inspectorTarget??localInspector);
  }
  onMount(()=>{
    let cancelled=false;
    void import('./editor.js').then(module=>{
      if(cancelled)return;mountText=module.mountEditor;mount();changed();
    }).catch(error=>notify(String(error)));
    return ()=>{cancelled=true;disposed=true;dispose?.();};
  });
  async function save(){
    if(!draft||!onsave||saving)return;saving=true;const snapshot=structuredClone($state.snapshot(draft));
    try{const result=await onsave(snapshot,hostRevision);if(!Number.isSafeInteger(result.revision)||result.revision<=hostRevision)throw Error('Host returned an invalid save revision');hostRevision=result.revision;notify('Draft saved.','success');}
    catch(error){notify(error instanceof Error?error.message:'Host save failed; your edits are retained.');}finally{saving=false;}
  }
</script>
<div class="content-builder">
  {#if notice}<div class="builder-toast" class:error={noticeKind==='error'} role={noticeKind==='error'?'alert':'status'} aria-atomic="true">
    <span aria-hidden="true" class="toast-icon">{noticeKind==='error'?'!':'✓'}</span><div><strong>{noticeKind==='error'?'Could not complete that action':noticeKind==='success'?'Saved':'Notice'}</strong><p>{notice}</p></div>
    <button type="button" aria-label="Dismiss notification" onclick={()=>notice=''}>×</button>
  </div>{/if}
  <p class="builder-hint">Build your message with text and images. Drag the handles to arrange blocks, or use Block actions to move them.</p>
  <div class="builder-shell"><div class="editor hail-builder-ui" bind:this={editorElement}></div><div class="builder-inspector-host" bind:this={localInspector}></div></div>
  {#if visibleIssues.length}<ul class="builder-errors" role="alert">{#each visibleIssues as issue}<li>{issue.message}</li>{/each}</ul>{/if}
  {#if showPreview}<section aria-label="Recipient preview">
    <div class="preview-controls"><h2>Recipient preview</h2><label><input type="checkbox" bind:checked={narrow}/> Narrow</label><label><input type="checkbox" bind:checked={dark}/> Dark</label><label><input type="checkbox" bind:checked={imagesUnavailable}/> Images unavailable</label></div>
    <div class="preview" class:narrow class:dark>{#if view}<Renderer blocks={view.blocks} header={view.header} {imagesUnavailable}/>{:else}<div role="alert"><p>Complete these fields to preview your message:</p><ul>{#each issues as issue}<li>{issue.message} {#if /blocks\[\d+\]/.test(issue.path)}<button type="button" onclick={()=>editIssue(issue)}>Edit block</button>{/if}</li>{/each}</ul></div>{/if}</div>
  </section>{/if}
  {#if onsave||onhandoff}<div class="builder-actions">
    {#if onsave}<button type="button" disabled={!draft||saving} onclick={save}>{saving?'Saving…':'Save as Draft'}</button>{/if}
    {#if onhandoff}<button type="button" disabled={!valid} onclick={()=>{if(valid)onhandoff(structuredClone($state.snapshot(valid)));}}>Use this content</button>{/if}
  </div>{/if}
</div>
<style>
  .builder-toast{position:fixed;z-index:40;bottom:calc(90px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;width:max-content;max-width:calc(100vw - 32px);box-sizing:border-box;padding:16px 20px;border:1px solid var(--color-brand,#127365);border-radius:14px;background:var(--color-brand-soft,#e4f2ec);color:var(--color-brand-strong,#126357);box-shadow:0 8px 28px #0003;font:14px/1.5 system-ui}
  .builder-toast.error{background:#fff0f0;color:#981b1b;border-color:#c53030}.builder-toast strong{font-size:14px}.builder-toast p{margin:3px 0 0}.toast-icon{display:grid;place-items:center;width:24px;height:24px;border:2px solid currentColor;border-radius:50%;font-weight:750;flex-shrink:0}.builder-toast button{align-self:flex-start;flex-shrink:0;border:0;background:transparent;color:inherit;font-size:24px;padding:0 4px;line-height:1}
  .builder-errors{color:#b42318;background:#fff0f0;border:1px solid #c53030;border-radius:8px;padding:12px 12px 12px 32px}
  :global(.hail-builder-ui .builder-header-label){font-weight:650;color:var(--color-brand-strong,#126357)}:global(.hail-builder-ui .builder-image-help){font-size:12px;color:var(--color-muted,#526964);margin:0}:global(.hail-builder-ui .builder-image-actions){display:flex;gap:12px;flex-wrap:wrap}
  :global(.hail-builder-ui .builder-image-fields .builder-header-option){display:flex;align-items:center;gap:8px}:global(.hail-builder-ui .builder-header-option input){width:auto;margin:0;accent-color:var(--color-brand,#127365)}
  :global(.hail-builder-ui .builder-cta-preview){padding:.5em 0}:global(.hail-builder-ui .builder-cta-preview span){display:inline-block;max-width:100%;box-sizing:border-box;padding:.7em 1.25em;border-radius:.5em;background:#126357;color:#fff;font-weight:650;overflow-wrap:anywhere}
  .builder-hint{font-size:.85em;color:var(--color-muted,#526964)}
  :global(.hail-builder-ui .builder-block){position:relative;padding:10px 8px 10px 30px;border:1px solid transparent;border-radius:8px;min-height:2em}
  :global(.hail-builder-ui .builder-block:hover),:global(.hail-builder-ui .builder-block:focus-within){border-color:var(--color-line,#aabcb8)}
  :global(.hail-builder-ui .builder-block.drop-before){border-top:3px solid var(--color-brand,#127365);background:var(--color-brand-soft,#e4f2ec)}
  :global(.hail-builder-ui .builder-block.drop-after){border-bottom:3px solid var(--color-brand,#127365);background:var(--color-brand-soft,#e4f2ec)}
  :global(.hail-builder-ui .builder-drag){position:absolute;left:2px;top:10px;padding:2px;border:0;background:transparent;color:var(--color-muted,#526964);cursor:grab;font-size:20px}
  :global(.hail-builder-ui .builder-image img){display:block;width:auto;height:auto;max-width:100%;max-height:48rem;object-fit:contain;border-radius:6px}
  :global(.hail-builder-ui .builder-image-fields){display:grid;gap:10px;padding:0;background:var(--color-canvas,#edf3f2);border-radius:0 0 6px 6px;font-size:13px}
  :global(.hail-builder-ui .builder-image-fields label){display:grid;gap:4px}:global(.hail-builder-ui .builder-image-fields input:not([type=checkbox])){width:100%;padding:8px;border:1px solid var(--color-line,#aabcb8);border-radius:5px;background:var(--color-surface,#fff);color:inherit}
  :global(.hail-builder-ui .builder-image-fields button){justify-self:start}:global(.hail-builder-ui .builder-add-image){position:relative;display:inline-flex;align-items:center;cursor:pointer;padding:6px;font-size:13px;min-height:36px;box-sizing:border-box}
  :global(.hail-builder-ui .builder-add-image input){position:absolute;inset:0;opacity:0;width:100%;cursor:pointer}:global(.hail-builder-ui .builder-add-image:focus-within){outline:2px solid var(--color-brand,#127365)}
  .content-builder{font:16px/1.5 system-ui,sans-serif;color:var(--color-ink,#173a35);min-width:0}button,input{font:inherit;max-width:100%;box-sizing:border-box}button{padding:.45em .7em;cursor:pointer}button:disabled{cursor:default;opacity:.5}label{display:flex;gap:.4em;align-items:center;flex-wrap:wrap}.builder-actions,.preview-controls{display:flex;flex-wrap:wrap;gap:.75em;align-items:center}.builder-actions{margin:1em 0}
  .editor{margin:0;border:1px solid var(--color-line,#aabcb8);border-radius:.5em;padding:.75em;min-width:0}
  :global(.hail-builder-ui){font:16px/1.5 system-ui,sans-serif;color:var(--color-ink,#173a35)}
  :global(.hail-builder-ui .builder-inspector){max-height:calc(100dvh - 40px);overflow:auto}
  :global(.hail-builder-ui .builder-settings-launch){position:sticky;bottom:20px;display:block;margin:12px 0 0 auto;padding:10px 16px;border:1px solid var(--color-line,#aabcb8);border-radius:8px;background:var(--color-surface,#fff);color:inherit;cursor:pointer;z-index:4}
  :global(.hail-builder-ui.builder-sheet){position:fixed;inset:auto 0 0;margin:0 auto;width:100%;max-width:640px;max-height:80dvh;padding:16px 16px max(16px,env(safe-area-inset-bottom));box-sizing:border-box;border:1px solid var(--color-line,#aabcb8);border-radius:16px 16px 0 0;background:var(--color-canvas,#edf3f2);color:var(--color-ink,#173a35)}
  :global(.hail-builder-ui.builder-sheet::backdrop){background:#0007}
  :global(.hail-builder-ui.builder-sheet .builder-inspector){border:0;padding:0;max-height:none;overflow:visible}
  :global(.hail-builder-ui .builder-sheet-close){display:block;margin:0 0 12px auto;padding:8px 14px;background:var(--color-surface,#fff);color:inherit;border:1px solid var(--color-line,#aabcb8);border-radius:6px;cursor:pointer}
  .builder-shell{display:grid;gap:20px;margin:1em 0;align-items:start}
  .builder-shell:global([data-builder-wide=true]){grid-template-columns:minmax(0,1fr) 280px}
  .builder-inspector-host:empty{display:none}
  .builder-inspector-host{position:sticky;top:20px;min-width:0}
  :global(.hail-builder-ui .builder-workspace){display:block}
  :global(.hail-builder-ui .builder-canvas){min-width:0}
  :global(.hail-builder-ui .builder-inspector){min-width:0;padding:16px;box-sizing:border-box;border:1px solid var(--color-line,#aabcb8);border-radius:8px;background:var(--color-canvas,#edf3f2)}
  :global(.hail-builder-ui .builder-inspector h3){margin:0 0 14px;font-size:14px;font-weight:650}
  :global(.hail-builder-ui .builder-inspector-hint){margin:0;color:var(--color-muted,#526964);font-size:13px}
  :global(.hail-builder-ui .builder-inspector input){box-sizing:border-box;font:inherit;min-width:0}
  :global(.hail-builder-ui .builder-inspector button){font:inherit;padding:8px;border:1px solid var(--color-line,#aabcb8);border-radius:6px;background:var(--color-surface,#fff);color:inherit;cursor:pointer}
  :global(.hail-builder-ui .builder-block.is-selected){border-color:var(--color-brand,#127365)}
  :global(.hail-builder-ui .builder-image-caption){font-size:.875em;color:var(--color-muted,#526964);margin-top:.35em}
  :global(.hail-builder-ui .builder-toolbar){display:flex;gap:.35em;flex-wrap:wrap;align-items:center;margin:-.25em -.25em 1em;padding-bottom:.65em;border-bottom:1px solid var(--color-line,#aabcb8)}
  :global(.hail-builder-ui .builder-tool-group){display:flex;align-items:center;gap:2px;padding-right:.35em;border-right:1px solid var(--color-line,#aabcb8)}
  :global(.hail-builder-ui .builder-toolbar button),:global(.hail-builder-ui .builder-toolbar select),:global(.hail-builder-ui .builder-toolbar summary){font:inherit;font-size:13px;color:var(--color-muted,#526964);background:transparent;border:0;border-radius:6px;min-width:36px;min-height:36px;padding:6px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:none}
  :global(.hail-builder-ui .builder-toolbar select){max-width:130px;padding-inline:8px}
  :global(.hail-builder-ui .builder-toolbar button:hover:not(:disabled)),:global(.hail-builder-ui .builder-toolbar summary:hover),:global(.hail-builder-ui .builder-toolbar select:hover){background:var(--color-brand-soft,#e4f2ec);color:var(--color-ink,#173a35)}
  :global(.hail-builder-ui .builder-toolbar button[aria-pressed=true]){background:var(--color-brand-soft,#e4f2ec);color:var(--color-brand-strong,#127365)}
  :global(.hail-builder-ui .builder-toolbar button:disabled){opacity:.35;cursor:default}
  :global(.hail-builder-ui .builder-toolbar :is(button,select,summary):focus-visible){outline:2px solid var(--color-brand,#127365);outline-offset:2px}
  :global(.hail-builder-ui .builder-toolbar strong),:global(.hail-builder-ui .builder-toolbar em){font-size:16px}
  :global(.hail-builder-ui .builder-code-icon){font-family:monospace;font-size:13px}
  :global(.hail-builder-ui .builder-more){position:relative;margin-left:auto}
  :global(.hail-builder-ui .builder-more summary){list-style:none}
  :global(.hail-builder-ui .builder-more summary::-webkit-details-marker){display:none}
  :global(.hail-builder-ui .builder-more[open] summary){background:var(--color-brand-soft,#e4f2ec);color:var(--color-ink,#173a35)}
  :global(.hail-builder-ui .builder-block-actions){position:absolute;right:0;top:calc(100% + 6px);z-index:10;display:grid;min-width:170px;padding:5px;border:1px solid var(--color-line,#aabcb8);border-radius:10px;background:var(--color-surface,#fff);box-shadow:0 8px 24px #0002}
  :global(.hail-builder-ui .builder-block-actions button){justify-content:flex-start;padding-inline:12px;white-space:nowrap}
  :global(.hail-builder-ui [contenteditable=true]){min-height:16em;outline-offset:4px;white-space:pre-wrap;overflow-wrap:anywhere}:global(.hail-builder-ui .builder-link){text-decoration:underline;color:var(--color-brand,#127365)}
  @media(pointer:coarse){:global(.hail-builder-ui .builder-toolbar button),:global(.hail-builder-ui .builder-toolbar select),:global(.hail-builder-ui .builder-toolbar summary){min-width:44px;min-height:44px}}
  .preview{padding:1.25em;border:1px solid #aabcb8;background:#fff;color:#173a35;--color-canvas:#edf3f2;--color-muted:#526964;--color-brand:#127365;max-width:100%;box-sizing:border-box}.preview.narrow{width:360px}.preview.dark{background:#142c29;color:#e2efec;--color-canvas:#24443f;--color-muted:#afc8c2;--color-brand:#7de0c9}
  .preview-controls h2{font-size:1.1em}.preview-controls{margin-top:1.5em}input:focus-visible,button:focus-visible{outline:2px solid #127365;outline-offset:3px}
  @media(max-width:600px){.builder-actions{align-items:stretch;flex-direction:column}.editor{padding:.5em}.preview{padding:.75em}}
</style>
