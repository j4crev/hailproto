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

<svelte:head><title>Compose · Haili</title></svelte:head>
<header class="mb-8 grid gap-2"><p class="hail-eyebrow">Send a message</p><h1 class="hail-title">Compose a Hail</h1><p class="m-0 text-sm text-muted [overflow-wrap:anywhere]">From {data.account.address}</p></header>
{#if data.status}
  <section class="hail-card mb-5 flex flex-wrap items-center justify-between gap-4 p-5" aria-label="Submission status"><div class="grid min-w-0 gap-1"><strong>Message {data.status.state}</strong><small class="font-mono text-muted [overflow-wrap:anywhere]">{data.status.messageId}</small></div><div class="flex flex-wrap gap-2"><button class="hail-button-secondary" type="button" onclick={refreshStatus} disabled={refreshing}>{refreshing?'Refreshing…':'Refresh status'}</button><a class="hail-button-secondary" href={`/sent/${data.status.messageId}`}>View sent message →</a></div></section>
{/if}
{#if form?.error}<div class="mb-5"><p class="hail-error" role="alert">{form.error}</p></div>{/if}
<div class="grid items-start gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
  <form class="hail-card grid min-w-0 gap-6 p-5 sm:p-7" method="POST" enctype="multipart/form-data">
    <div class="grid gap-2"><label class="hail-field">Recipient and category<select name="target" required disabled={!data.options.length}><option value="">Select an active Grant</option>{#each data.options as option}<option value={option.value}>{option.recipient} · {option.category}</option>{/each}</select></label><p class="m-0 text-xs text-muted">{data.options.length?'Only recipients who have granted you permission appear here.':'No active categorized incoming Grants are available for sending.'}</p></div>
    <fieldset class="m-0 flex gap-5 border-0 p-0"><legend class="mb-2 text-sm font-semibold">Format</legend><label class="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="mode" value="plain" bind:group={mode}/> Plain</label><label class="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="mode" value="rich" bind:group={mode}/> Rich</label></fieldset>
    <label class="hail-field">Title <span class="text-xs font-normal text-muted">Rich only</span><input name="title" maxlength="128" bind:value={title} disabled={mode==='plain'} /></label>
    <div class="grid gap-2">
      <label class="text-sm font-semibold" for="message-text">Message</label>
      <p class="m-0 text-xs text-muted" id="format-help">{mode==='rich'?'Select text, then apply formatting.':'Plain text'}</p>
      {#if mode==='rich'}<div class="flex flex-wrap gap-2" role="group" aria-label="Text formatting"><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('**')} aria-label="Bold"><strong>B</strong></button><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('*')} aria-label="Italic"><em>I</em></button><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('`')} aria-label="Code"><code>&lt;/&gt;</code></button><button class="hail-button-secondary" type="button" onclick={link} aria-label="Link">Link</button></div>{/if}
      <textarea class="w-full resize-y leading-relaxed" id="message-text" aria-describedby="format-help" name="text" rows="9" maxlength="65536" bind:this={editor} bind:value={text} required></textarea>
    </div>
    <details class="rounded-xl border border-solid border-line p-4"><summary class="cursor-pointer text-sm font-semibold">Add a header image <span class="font-normal text-muted">· optional, rich only</span></summary><div class="mt-4 grid gap-4"><label class="hail-field">Header PNG<input name="header" type="file" accept="image/png" onchange={image} disabled={mode==='plain'} /></label><label class="hail-field">Header alt text<input name="alt" maxlength="1024" bind:value={alt} disabled={mode==='plain'} /></label><label class="hail-field">Header caption<input name="caption" maxlength="1024" bind:value={caption} disabled={mode==='plain'} /></label><p class="m-0 text-xs text-muted">Bundled PNG only, up to 192 KiB. Alt text is required when you add an image.</p></div></details>
    <label class="flex min-h-11 items-center gap-3 text-sm"><input name="allowReply" type="checkbox" value="yes" /> Allow one reply for 7 days</label>
    <button class="hail-button justify-self-start" disabled={!data.options.length}>Send message <span aria-hidden="true">→</span></button>
  </form>
  <section class="hail-card min-h-[260px] min-w-0 p-5 sm:p-7 xl:sticky xl:top-8 xl:min-h-[360px]" aria-label="Message preview"><p class="hail-eyebrow">Preview</p><div class="mt-5 font-serif text-[17px] leading-[1.65] [overflow-wrap:anywhere]">{#if mode==='rich'&&preview}<figure class="m-0 mb-5"><img class="block max-h-[260px] w-full rounded-xl object-cover" src={preview} alt={alt}/>{#if caption}<figcaption class="mt-2 text-xs text-muted">{caption}</figcaption>{/if}</figure>{/if}{#if mode==='rich'&&title}<h2 class="text-[1.65em]">{title}</h2>{/if}{#if mode==='plain'}<p class="whitespace-pre-wrap">{text}</p>{:else}{#each blocks as block}<p>{#each block.children as span}{@const link=block.markDefs.find(definition=>span.marks.includes(definition._key))}{#if link}<a class="text-brand" href={link.href} target="_blank" rel="noopener noreferrer">{span.text}</a>{:else if span.marks.includes('code')}<code class="rounded bg-canvas px-1">{span.text}</code>{:else if span.marks.includes('strong')}<strong>{span.text}</strong>{:else if span.marks.includes('em')}<em>{span.text}</em>{:else}{span.text}{/if}{/each}</p>{/each}{/if}{#if !text&&!title&&!(mode==='rich'&&preview)}<p class="py-12 text-center font-sans text-sm text-muted">Your message preview appears here.</p>{/if}</div></section>
</div>
