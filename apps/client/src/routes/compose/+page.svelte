<script lang="ts">
  import {forwardBody} from "$lib/forward.js";
  import { tick,untrack } from "svelte";
  import {enhance} from "$app/forms";
  import { composeBlocks,formatLines } from "$lib/compose.js";
  import {parseBody} from "$lib/messages.js";
  import RichText from "$lib/RichText.svelte";
  let {data,form}=$props();
  let mode=$state("rich"),title=$state(""),text=$state(""),alt=$state(""),caption=$state(""),preview=$state<string|null>(null);
  let editor=$state<HTMLTextAreaElement>();
  let category=$state(untrack(()=>data.defaultCategory));
  let selected=$state<string[]>(untrack(()=>data.defaultConnection?[data.defaultConnection]:[]));
  $effect(()=>{const available=new Set(data.connections.map(c=>c.connectionId));selected=untrack(()=>selected.filter(id=>available.has(id)));});
  let audience=$derived(data.categories.find(row=>row.category===category)?.subscribers??0);
  let canPublish=$derived(data.kind==="connections"?selected.length>0&&selected.length<=data.maxRecipients:audience>0&&audience<=data.maxRecipients);
  let retryPublication=$derived(form&&"publicationId" in form&&typeof form.publicationId==="string"?form.publicationId:null);
  const batchUrl=(id:string)=>`/compose?${data.kind==='connections'?'audience=connections&':''}publication=${id}`;
  let forwarded=$derived(data.forward?parseBody(forwardBody(data.forward,text)):null);
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
</script>

<svelte:head><title>{data.forward?"Forward a message":data.kind==="connections"?"Send a message":"Send a hail"} · Haili</title></svelte:head>
<header class="mb-8 grid gap-2"><h1 class="hail-title">{data.forward?"Forward a message":data.kind==="connections"?"Send a message":"Send a hail"}</h1><p class="m-0 text-sm text-muted [overflow-wrap:anywhere]">From {data.account.address}</p><p class="m-0 text-xs text-muted">{data.kind==="connections"?"Each connection receives a separate, private message.":"Send to everyone subscribed to a category."}</p>{#if !data.forward}<nav class="mt-3 flex flex-wrap gap-2" aria-label="Compose audience"><a class={data.kind==='category'?'hail-button':'hail-button-secondary'} href="/compose" aria-current={data.kind==='category'?'page':undefined}>Subscribers</a><a class={data.kind==='connections'?'hail-button':'hail-button-secondary'} href="/compose?audience=connections" aria-current={data.kind==='connections'?'page':undefined}>Connections</a></nav>{/if}</header>
{#if data.status && !form?.error}
  <p class="mb-5 text-sm" role="status">Message sent.</p>
{/if}
{#if form?.error}<div class="mb-5"><p class="hail-error" role="alert">{form.error}</p>{#if retryPublication}<a class="hail-back mt-2" href={batchUrl(retryPublication)}>Check original {data.kind==='connections'?'message batch':'publication'} status →</a>{/if}</div>{/if}
<div class="grid items-start gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
  <form class="hail-card grid min-w-0 gap-6 p-5 sm:p-7" method="POST" use:enhance action={data.kind==='connections'?'?/publish&audience=connections':'?/publish'} enctype="multipart/form-data">
    <input type="hidden" name="publicationId" value={retryPublication??data.newPublicationId}/>
    {#if data.forward}<input type="hidden" name="forwardSender" value={data.forward.message.sender}/><input type="hidden" name="forwardMessage" value={data.forward.message.messageId}/><p class="m-0 text-sm text-muted">The original message and sender details are included below your note.</p>{/if}
    <input type="hidden" name="audience" value={data.kind}/>
    {#if data.kind==='connections'}<fieldset class="m-0 grid min-w-0 gap-3 rounded-xl border border-solid border-line p-4"><legend class="px-1 text-sm font-semibold">Recipients · choose up to {data.maxRecipients} connections</legend>{#each data.connections as connection}<label class="flex min-h-11 min-w-0 items-start gap-3 text-sm"><input type="checkbox" name="connection" value={connection.connectionId} bind:group={selected}/><span class="grid min-w-0 gap-1"><strong class="[overflow-wrap:anywhere]">{connection.address}</strong><small class="text-xs text-muted [overflow-wrap:anywhere]">{connection.recipientDid}</small></span></label>{/each}{#if !data.connections.length}<p class="m-0 text-sm text-muted">No active connections yet. Share a code from <a href="/connections">Connections</a>.</p>{/if}</fieldset>
    {:else}<div class="grid gap-2"><label class="hail-field">Subscription category<select name="category" bind:value={category} required disabled={!data.categories.length}><option value="">Choose a category</option>{#each data.categories as option}<option value={option.category}>{option.category==='general'?'General':option.category} · {option.subscribers} subscriber{option.subscribers===1?'':'s'}</option>{/each}</select></label><p class="m-0 text-xs text-muted">{!data.categories.length?'No active category subscribers yet.':category?`This update goes to all ${audience} currently authorized subscribers in this category. The audience is saved when you publish.`:'Choose the subscription category to publish to. General is the default when available.'}</p>{#if audience>data.maxRecipients}<p class="m-0 text-xs text-danger">This alpha supports at most {data.maxRecipients} subscribers per publication.</p>{/if}</div>{/if}
    {#if !data.forward}<fieldset class="m-0 flex gap-5 border-0 p-0"><legend class="mb-2 text-sm font-semibold">Format</legend><label class="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="mode" value="plain" bind:group={mode}/> Plain</label><label class="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="mode" value="rich" bind:group={mode}/> Rich</label></fieldset>
    <label class="hail-field">Title <span class="text-xs font-normal text-muted">Rich only</span><input name="title" maxlength="128" bind:value={title} disabled={mode==='plain'} /></label>{:else}<input type="hidden" name="mode" value="rich"/>{/if}
    <div class="grid gap-2">
      <label class="text-sm font-semibold" for="message-text">{data.forward?"Note (optional)":"Message"}</label>
      <p class="m-0 text-xs text-muted" id="format-help">{mode==='rich'?'Select text for inline formatting, or select lines for headings, lists and quotes.':'Plain text'}</p>
      {#if mode==='rich'}<div class="flex flex-wrap gap-2" role="group" aria-label="Text formatting"><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('**')} aria-label="Bold"><strong>B</strong></button><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('*')} aria-label="Italic"><em>I</em></button><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('`')} aria-label="Code"><code>&lt;/&gt;</code></button><button class="hail-button-secondary" type="button" onclick={link} aria-label="Link">Link</button></div>{/if}
      {#if mode==='rich'}<div class="flex flex-wrap gap-2" role="group" aria-label="Block formatting"><button class="hail-button-secondary" type="button" onclick={()=>block('## ')}>Heading</button><button class="hail-button-secondary" type="button" onclick={()=>block('- ')}>Bullets</button><button class="hail-button-secondary" type="button" onclick={()=>block('1. ')}>Numbered list</button><button class="hail-button-secondary" type="button" onclick={()=>block('> ')}>Quote</button></div>{/if}
      <textarea class="w-full resize-y leading-relaxed" id="message-text" aria-describedby="format-help" name="text" rows="9" maxlength="65536" bind:this={editor} bind:value={text} required={!data.forward}></textarea>
    </div>
    {#if mode==='rich'}<details class="text-xs text-muted"><summary class="cursor-pointer py-2 font-semibold">Formatting shortcuts</summary><p class="m-0 mt-2 leading-relaxed">Start lines with <code>## </code> or <code>### </code> for headings, <code>- </code> for bullets, <code>1. </code> for numbered items, and <code>&gt; </code> for quotes. List numbering is automatic. Separate ordinary paragraphs with blank lines. This is a small set of shortcuts, not a full Markdown editor; HTML is displayed as text.</p></details>{/if}
    {#if !data.forward}<details class="rounded-xl border border-solid border-line p-4"><summary class="cursor-pointer text-sm font-semibold">Add a header image <span class="font-normal text-muted">· optional, rich only</span></summary><div class="mt-4 grid gap-4"><label class="hail-field">Header PNG<input name="header" type="file" accept="image/png" onchange={image} disabled={mode==='plain'} /></label><label class="hail-field">Header alt text<input name="alt" maxlength="1024" bind:value={alt} disabled={mode==='plain'} /></label><label class="hail-field">Header caption<input name="caption" maxlength="1024" bind:value={caption} disabled={mode==='plain'} /></label><p class="m-0 text-xs text-muted">Bundled PNG only, up to 192 KiB. Alt text is required when you add an image.</p></div></details>{/if}
    {#if data.kind==='category'}<label class="flex min-h-11 items-center gap-3 text-sm"><input name="allowReply" type="checkbox" value="yes" /> Allow one reply per subscriber (expires 7 days after publishing)</label>{/if}
    <button class="hail-button justify-self-start" disabled={!canPublish}>Send <span aria-hidden="true">→</span></button>
  </form>
  <section class="hail-card min-h-[260px] min-w-0 p-5 sm:p-7 xl:sticky xl:top-8 xl:min-h-[360px]" aria-label="Message preview"><p class="hail-eyebrow">Preview</p><div class="mt-5 font-serif text-[17px] leading-[1.65] [overflow-wrap:anywhere]">{#if forwarded}<RichText blocks={forwarded.blocks} header={forwarded.header}/>{:else}{#if mode==='rich'&&preview}<figure class="m-0 mb-5"><img class="block max-h-[260px] w-full rounded-xl object-cover" src={preview} alt={alt}/>{#if caption}<figcaption class="mt-2 text-xs text-muted">{caption}</figcaption>{/if}</figure>{/if}{#if mode==='plain'}<p class="whitespace-pre-wrap">{text}</p>{:else}<RichText {blocks}/>{/if}{#if !text&&(mode==='plain'||!title&&!preview)}<p class="py-12 text-center font-sans text-sm text-muted">Your message preview appears here.</p>{/if}{/if}</div></section>
</div>
