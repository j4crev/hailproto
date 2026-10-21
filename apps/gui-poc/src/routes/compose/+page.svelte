<script lang="ts">
  import { tick } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import { composeBlocks } from "$lib/compose.js";
  let {data,form}=$props();
  let mode=$state("rich"),title=$state(""),text=$state(""),alt=$state(""),caption=$state(""),preview=$state<string|null>(null);
  let editor=$state<HTMLTextAreaElement>();
  let refreshing=$state(false);
  let blocks=$derived(composeBlocks("",text));
  function image(event:Event){if(preview)URL.revokeObjectURL(preview);const file=(event.currentTarget as HTMLInputElement).files?.[0];preview=file?URL.createObjectURL(file):null;}
  async function insert(before:string,after=before,placeholder="text"){
    if(!editor)return;
    const start=editor.selectionStart,end=editor.selectionEnd,value=text.slice(start,end)||placeholder;
    text=`${text.slice(0,start)}${before}${value}${after}${text.slice(end)}`;await tick();editor.focus();editor.setSelectionRange(start+before.length,start+before.length+value.length);
  }
  async function link(){
    const href=prompt("HTTPS link URL");if(!href)return;
    try {const url=new URL(href);if(url.protocol!=="https:"||url.username||url.password)throw new Error();await insert("[","]("+url.href+")","link text");}
    catch {alert("Use an HTTPS URL without embedded credentials.");}
  }
  async function refreshStatus(){refreshing=true;try{await invalidateAll();}finally{refreshing=false;}}
</script>

<a class="back" href="/">← Inbox</a>
{#if !data.configured}
  <section class="card notice">Connect the canary before composing.</section>
{:else}
  <section class="heading"><div><p>Send</p><h1>Compose a Hail</h1></div><span>{data.account.address}</span></section>
  {#if data.status}
    <section class="card status"><div><strong>Message {data.status.state}</strong><small>{data.status.messageId}</small></div><button type="button" onclick={refreshStatus} disabled={refreshing}>{refreshing?'Refreshing…':'Refresh status'}</button></section>
  {/if}
  {#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
  <div class="columns">
    <form class="card composer" method="POST" enctype="multipart/form-data">
      <label>Recipient and category<select name="target" required disabled={!data.options.length}><option value="">Select an active Grant</option>{#each data.options as option}<option value={option.value}>{option.recipient} · {option.category}</option>{/each}</select></label>
      {#if !data.options.length}<small>No active categorized incoming Grants are available for sending.</small>{/if}
      <fieldset><legend>Format</legend><label><input type="radio" name="mode" value="plain" bind:group={mode}/> Plain</label><label><input type="radio" name="mode" value="rich" bind:group={mode}/> Rich</label></fieldset>
      <label>Title <span>Rich only</span><input name="title" maxlength="128" bind:value={title} disabled={mode==='plain'} /></label>
      <label>Message <span>{mode==='rich'?'Select text, then apply formatting.':'Plain text'}</span>
        {#if mode==='rich'}<span class="toolbar" aria-label="Text formatting"><button type="button" onclick={()=>insert('**')} aria-label="Bold"><strong>B</strong></button><button type="button" onclick={()=>insert('*')} aria-label="Italic"><em>I</em></button><button type="button" onclick={()=>insert('`')} aria-label="Code"><code>&lt;/&gt;</code></button><button type="button" onclick={link} aria-label="Link">Link</button></span>{/if}
        <textarea name="text" rows="9" maxlength="65536" bind:this={editor} bind:value={text} required></textarea></label>
      <label>Header PNG <span>Optional, rich only</span><input name="header" type="file" accept="image/png" onchange={image} disabled={mode==='plain'} /></label>
      <label>Header alt text<input name="alt" maxlength="1024" bind:value={alt} disabled={mode==='plain'} /></label>
      <label>Header caption<input name="caption" maxlength="1024" bind:value={caption} disabled={mode==='plain'} /></label>
      <label class="check"><input name="allowReply" type="checkbox" value="yes" /> Allow one reply for 7 days</label>
      <button disabled={!data.options.length}>Send message</button>
    </form>
    <section class="card preview" aria-label="Message preview"><p class="label">Preview</p>{#if mode==='rich'&&preview}<figure><img src={preview} alt={alt}/>{#if caption}<figcaption>{caption}</figcaption>{/if}</figure>{/if}{#if mode==='rich'&&title}<h2>{title}</h2>{/if}{#if mode==='plain'}<p class="plain">{text}</p>{:else}{#each blocks as block}<p>{#each block.children as span}{@const link=block.markDefs.find(definition=>span.marks.includes(definition._key))}{#if link}<a href={link.href} target="_blank" rel="noopener noreferrer">{span.text}</a>{:else if span.marks.includes('code')}<code>{span.text}</code>{:else if span.marks.includes('strong')}<strong>{span.text}</strong>{:else if span.marks.includes('em')}<em>{span.text}</em>{:else}{span.text}{/if}{/each}</p>{/each}{/if}{#if !text&&!title&&!preview}<div class="empty">Your message preview appears here.</div>{/if}</section>
  </div>
{/if}

<style>
  .back{display:inline-block;margin-bottom:18px;color:#286446;font-size:14px;font-weight:700;text-decoration:none}.heading{display:flex;align-items:end;justify-content:space-between;margin-bottom:22px}.heading p,.label{margin:0 0 7px;color:#22714b;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.heading h1{margin:0;font-size:38px}.heading span{color:#68766e;font-size:13px}.columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.8fr);gap:18px;align-items:start}.composer,.preview,.status,.notice{padding:22px}.composer{display:grid;gap:17px}label{display:grid;gap:7px;color:#3d4c43;font-size:13px;font-weight:750}label span{color:#7a857e;font-size:11px;font-weight:500}input,select,textarea{width:100%;padding:11px 12px;border:1px solid #ccd5cf;border-radius:10px;background:#fff;color:#17231d;font:inherit}textarea{resize:vertical;line-height:1.5}fieldset{display:flex;gap:18px;margin:0;padding:0;border:0}legend{margin-bottom:8px;font-size:13px;font-weight:750}fieldset label{display:flex;grid:unset;align-items:center;gap:6px}fieldset input{width:auto}button{padding:11px 16px;border:0;border-radius:10px;background:#17633f;color:#fff;font-weight:750;text-decoration:none;cursor:pointer}button:disabled{cursor:not-allowed;opacity:.45}.toolbar{display:flex;gap:6px}.toolbar button{min-width:36px;padding:6px 9px;border:1px solid #ccd5cf;background:#f7f9f7;color:#26352d}.preview{min-height:360px;font-family:ui-serif,Georgia,serif;font-size:17px;line-height:1.65}.preview h2{font-size:1.65em}.preview a{color:#17633f}.preview code{padding:.08em .3em;border-radius:.3em;background:#edf0ed}.plain{white-space:pre-wrap}.preview figure{margin:0 -8px 20px}.preview img{display:block;width:100%;max-height:260px;border-radius:12px;object-fit:cover}.preview figcaption{margin-top:6px;color:#68766e;font-size:12px}.empty{display:grid;min-height:240px;place-items:center;color:#8a948e;text-align:center}.status{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:18px}.status div{display:flex;min-width:0;flex-direction:column;gap:4px}.status small{overflow:hidden;color:#68766e;font-family:ui-monospace,monospace;text-overflow:ellipsis}.status button{font-size:13px;white-space:nowrap}.error{padding:12px 15px;border-radius:10px;background:#fde9e7;color:#852f28}.notice{color:#5d6962}@media(max-width:760px){.columns{grid-template-columns:1fr}.heading{align-items:flex-start;flex-direction:column;gap:8px}.preview{min-height:260px}}
  .check{display:flex;align-items:center;gap:8px}.check input{width:auto}
</style>
