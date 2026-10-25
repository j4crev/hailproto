<script lang="ts">
  import { tick,untrack } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import { composeBlocks,formatLines } from "$lib/compose.js";
  import {parseBody} from "$lib/messages.js";
  import RichText from "$lib/RichText.svelte";
  let {data,form}=$props();
  let mode=$state("rich"),title=$state(""),text=$state(""),alt=$state(""),caption=$state(""),preview=$state<string|null>(null);
  let editor=$state<HTMLTextAreaElement>();
  let category=$state(untrack(()=>data.defaultCategory));
  let audience=$derived(data.categories.find(row=>row.category===category)?.subscribers??0);
  let canPublish=$derived(audience>0&&audience<=data.maxRecipients);
  let retryPublication=$derived(form&&"publicationId" in form&&typeof form.publicationId==="string"?form.publicationId:null);
  let refreshing=$state(false);
  let blocks=$derived(parseBody({version:1,profile:"spt-2",blocks:composeBlocks(title,text)}).blocks);
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
  async function block(prefix:string){
    if(!editor)return;
    const formatted=formatLines(text,editor.selectionStart,editor.selectionEnd,prefix);
    text=formatted.text;await tick();editor.focus();editor.setSelectionRange(formatted.start,formatted.end);
  }
  async function refreshStatus(){refreshing=true;try{await invalidateAll();}finally{refreshing=false;}}
</script>

<svelte:head><title>Publish an update · Haili</title></svelte:head>
<header class="mb-8 grid gap-2"><p class="hail-eyebrow">Your subscribers</p><h1 class="hail-title">Publish an update</h1><p class="m-0 text-sm text-muted [overflow-wrap:anywhere]">From {data.account.address}</p><p class="m-0 text-xs text-muted">Publish to a category audience, not selected subscription recipients. Direct messaging to connections is not available yet.</p></header>
{#if data.status}
  <section class="hail-card mb-5 grid gap-4 p-5" aria-label="Publication status"><div class="flex flex-wrap items-center justify-between gap-3"><div class="min-w-0"><strong>Publication {data.status.state}</strong><p class="m-0 mt-1 text-sm text-muted [overflow-wrap:anywhere]">{data.status.category==='general'?'General':data.status.category} · {data.status.total} subscriber{data.status.total===1?'':'s'} in the saved audience</p></div><button class="hail-button-secondary" type="button" onclick={refreshStatus} disabled={refreshing}>{refreshing?'Refreshing…':'Refresh status'}</button></div>
    <dl class="m-0 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">{#each Object.entries(data.status.counts) as [name,count]}<div class="rounded-xl bg-canvas p-3"><dt class="capitalize text-muted">{name==='indeterminate'?'Unconfirmed':name}</dt><dd class="m-0 mt-1 text-xl font-bold">{count}</dd></div>{/each}</dl>
    <p class="m-0 text-xs text-muted">Finished means fan-out work ended, not that everyone received or read the update. Confirmed delivery: {data.status.delivery.delivered} delivered, {data.status.delivery.accepted} accepted, {data.status.delivery['on-hold']} on hold, {data.status.delivery.failed} failed, {data.status.delivery.cancelled} cancelled, {data.status.delivery.indeterminate} indeterminate.</p>
    <details><summary class="cursor-pointer py-2 text-sm font-semibold">Per-subscriber outcomes</summary><ul class="m-0 mt-2 grid list-none gap-3 p-0">{#each data.status.targets as target}<li class="grid gap-1 rounded-xl border border-solid border-line p-3 text-xs"><code class="[overflow-wrap:anywhere]">{target.recipient}</code><span>Work: {target.state} · Delivery: {target.delivery??'no delivery record'}</span>{#if target.delivery!==null}<a class="inline-block py-2 font-semibold text-brand" href={`/sent/${target.messageId}`}>View sent message →</a>{/if}</li>{/each}</ul></details>
    <div class="flex flex-wrap gap-2"><a class="hail-button-secondary" href="/sent">View Sent delivery details →</a>{#if data.status.counts.pending}<form method="POST" action="?/cancel"><input type="hidden" name="publicationId" value={data.status.publicationId}/><button class="hail-button-secondary text-danger">Stop new messages</button></form>{/if}</div><p class="m-0 text-xs text-muted">Stopping new messages does not recall delivered content. Already-created messages may still be submitted. Unfinished creation attempts expire {new Date(data.status.expiresAt).toLocaleString()}.</p>
  </section>
{/if}
{#if form?.error}<div class="mb-5"><p class="hail-error" role="alert">{form.error}</p>{#if retryPublication}<a class="hail-back mt-2" href={`/compose?publication=${retryPublication}`}>Check original publication status →</a>{/if}</div>{/if}
{#if data.recent.length}<details class="hail-card mb-6 p-5" open={data.recent.some(row=>row.pending)}><summary class="cursor-pointer text-sm font-semibold">Your publications · unfinished work and recent history</summary><ul class="m-0 mt-3 grid list-none gap-2 p-0">{#each data.recent as publication}<li><a class="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-xl bg-canvas px-3 py-2 text-sm no-underline hover:bg-brand-soft" href={`/compose?publication=${publication.publicationId}`} aria-current={data.status?.publicationId===publication.publicationId?'page':undefined}><span class="[overflow-wrap:anywhere]">{publication.category==='general'?'General':publication.category} · {new Date(publication.createdAt).toLocaleString()}</span>{#if publication.pending}<span class="text-xs font-semibold text-brand">Unfinished</span>{/if}</a></li>{/each}</ul></details>{/if}
<div class="grid items-start gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
  <form class="hail-card grid min-w-0 gap-6 p-5 sm:p-7" method="POST" action="?/publish" enctype="multipart/form-data">
    <input type="hidden" name="publicationId" value={retryPublication??data.newPublicationId}/>
    <div class="grid gap-2"><label class="hail-field">Subscription category<select name="category" bind:value={category} required disabled={!data.categories.length}><option value="">Choose a category</option>{#each data.categories as option}<option value={option.category}>{option.category==='general'?'General':option.category} · {option.subscribers} subscriber{option.subscribers===1?'':'s'}</option>{/each}</select></label><p class="m-0 text-xs text-muted">{!data.categories.length?'No active category subscribers yet.':category?`This update goes to all ${audience} currently authorized subscribers in this category. The audience is saved when you publish.`:'Choose the subscription category to publish to. General is the default when available.'}</p>{#if audience>data.maxRecipients}<p class="m-0 text-xs text-danger">This alpha supports at most {data.maxRecipients} subscribers per publication.</p>{/if}</div>
    <fieldset class="m-0 flex gap-5 border-0 p-0"><legend class="mb-2 text-sm font-semibold">Format</legend><label class="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="mode" value="plain" bind:group={mode}/> Plain</label><label class="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="mode" value="rich" bind:group={mode}/> Rich</label></fieldset>
    <label class="hail-field">Title <span class="text-xs font-normal text-muted">Rich only</span><input name="title" maxlength="128" bind:value={title} disabled={mode==='plain'} /></label>
    <div class="grid gap-2">
      <label class="text-sm font-semibold" for="message-text">Message</label>
      <p class="m-0 text-xs text-muted" id="format-help">{mode==='rich'?'Select text for inline formatting, or select lines for headings, lists and quotes.':'Plain text'}</p>
      {#if mode==='rich'}<div class="flex flex-wrap gap-2" role="group" aria-label="Text formatting"><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('**')} aria-label="Bold"><strong>B</strong></button><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('*')} aria-label="Italic"><em>I</em></button><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('`')} aria-label="Code"><code>&lt;/&gt;</code></button><button class="hail-button-secondary" type="button" onclick={link} aria-label="Link">Link</button></div>{/if}
      {#if mode==='rich'}<div class="flex flex-wrap gap-2" role="group" aria-label="Block formatting"><button class="hail-button-secondary" type="button" onclick={()=>block('## ')}>Heading</button><button class="hail-button-secondary" type="button" onclick={()=>block('- ')}>Bullets</button><button class="hail-button-secondary" type="button" onclick={()=>block('1. ')}>Numbered list</button><button class="hail-button-secondary" type="button" onclick={()=>block('> ')}>Quote</button></div>{/if}
      <textarea class="w-full resize-y leading-relaxed" id="message-text" aria-describedby="format-help" name="text" rows="9" maxlength="65536" bind:this={editor} bind:value={text} required></textarea>
    </div>
    {#if mode==='rich'}<details class="text-xs text-muted"><summary class="cursor-pointer py-2 font-semibold">Formatting shortcuts</summary><p class="m-0 mt-2 leading-relaxed">Start lines with <code>## </code> or <code>### </code> for headings, <code>- </code> for bullets, <code>1. </code> for numbered items, and <code>&gt; </code> for quotes. List numbering is automatic. Separate ordinary paragraphs with blank lines. This is a small set of shortcuts, not a full Markdown editor; HTML is displayed as text.</p></details>{/if}
    <details class="rounded-xl border border-solid border-line p-4"><summary class="cursor-pointer text-sm font-semibold">Add a header image <span class="font-normal text-muted">· optional, rich only</span></summary><div class="mt-4 grid gap-4"><label class="hail-field">Header PNG<input name="header" type="file" accept="image/png" onchange={image} disabled={mode==='plain'} /></label><label class="hail-field">Header alt text<input name="alt" maxlength="1024" bind:value={alt} disabled={mode==='plain'} /></label><label class="hail-field">Header caption<input name="caption" maxlength="1024" bind:value={caption} disabled={mode==='plain'} /></label><p class="m-0 text-xs text-muted">Bundled PNG only, up to 192 KiB. Alt text is required when you add an image.</p></div></details>
    <label class="flex min-h-11 items-center gap-3 text-sm"><input name="allowReply" type="checkbox" value="yes" /> Allow one reply per subscriber (expires 7 days after publishing)</label>
    <button class="hail-button justify-self-start" disabled={!canPublish}>Publish update <span aria-hidden="true">→</span></button>
  </form>
  <section class="hail-card min-h-[260px] min-w-0 p-5 sm:p-7 xl:sticky xl:top-8 xl:min-h-[360px]" aria-label="Message preview"><p class="hail-eyebrow">Preview</p><div class="mt-5 font-serif text-[17px] leading-[1.65] [overflow-wrap:anywhere]">{#if mode==='rich'&&preview}<figure class="m-0 mb-5"><img class="block max-h-[260px] w-full rounded-xl object-cover" src={preview} alt={alt}/>{#if caption}<figcaption class="mt-2 text-xs text-muted">{caption}</figcaption>{/if}</figure>{/if}{#if mode==='plain'}<p class="whitespace-pre-wrap">{text}</p>{:else}<RichText {blocks}/>{/if}{#if !text&&(mode==='plain'||!title&&!preview)}<p class="py-12 text-center font-sans text-sm text-muted">Your message preview appears here.</p>{/if}</div></section>
</div>
