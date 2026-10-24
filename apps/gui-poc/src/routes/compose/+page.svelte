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

<a class="mb-[18px] inline-block text-[14px] font-bold text-[#286446] no-underline" href="/">← Inbox</a>
{#if !data.configured}
  <section class="hail-card p-[22px] text-[#5d6962]">Connect the canary before composing.</section>
{:else}
  <section class="mb-[22px] flex items-end justify-between max-[760px]:flex-col max-[760px]:items-start max-[760px]:gap-2"><div><p class="m-0 mb-[7px] text-[12px] font-extrabold tracking-[.12em] text-[#22714b] uppercase">Send</p><h1 class="m-0 text-[38px]">Compose a Hail</h1></div><span class="text-[13px] text-[#68766e]">{data.account.address}</span></section>
  {#if data.status}
    <section class="hail-card mb-[18px] flex items-center justify-between gap-[15px] p-[22px]"><div class="flex min-w-0 flex-col gap-1"><strong>Message {data.status.state}</strong><small class="overflow-hidden font-mono text-ellipsis text-[#68766e]">{data.status.messageId}</small></div><button class="cursor-pointer rounded-[10px] border-0 bg-[#17633f] px-4 py-[11px] text-[13px] font-[750] whitespace-nowrap text-white no-underline disabled:cursor-not-allowed disabled:opacity-45" type="button" onclick={refreshStatus} disabled={refreshing}>{refreshing?'Refreshing…':'Refresh status'}</button></section>
  {/if}
  {#if form?.error}<p class="rounded-[10px] bg-[#fde9e7] px-[15px] py-3 text-[#852f28]" role="alert">{form.error}</p>{/if}
  <div class="grid grid-cols-[minmax(0,1fr)_minmax(280px,.8fr)] items-start gap-[18px] max-[760px]:grid-cols-1">
    <form class="hail-card grid gap-[17px] p-[22px] [&_label]:grid [&_label]:gap-[7px] [&_label]:text-[13px] [&_label]:font-[750] [&_label]:text-[#3d4c43] [&_label_span]:text-[11px] [&_label_span]:font-medium [&_label_span]:text-[#7a857e] [&_input]:w-full [&_select]:w-full [&_textarea]:w-full [&_input]:px-3 [&_select]:px-3 [&_textarea]:px-3 [&_input]:py-[11px] [&_select]:py-[11px] [&_textarea]:py-[11px] [&_input]:border [&_select]:border [&_textarea]:border [&_input]:border-solid [&_select]:border-solid [&_textarea]:border-solid [&_input]:border-[#ccd5cf] [&_select]:border-[#ccd5cf] [&_textarea]:border-[#ccd5cf] [&_input]:rounded-[10px] [&_select]:rounded-[10px] [&_textarea]:rounded-[10px] [&_input]:bg-white [&_select]:bg-white [&_textarea]:bg-white [&_input]:text-[#17231d] [&_select]:text-[#17231d] [&_textarea]:text-[#17231d] [&_input]:[font:inherit] [&_select]:[font:inherit] [&_textarea]:[font:inherit] [&_button]:cursor-pointer [&_button]:rounded-[10px] [&_button]:border-0 [&_button]:bg-[#17633f] [&_button]:px-4 [&_button]:py-[11px] [&_button]:font-[750] [&_button]:text-white [&_button]:no-underline [&_button:disabled]:cursor-not-allowed [&_button:disabled]:opacity-45" method="POST" enctype="multipart/form-data">
      <label>Recipient and category<select name="target" required disabled={!data.options.length}><option value="">Select an active Grant</option>{#each data.options as option}<option value={option.value}>{option.recipient} · {option.category}</option>{/each}</select></label>
      {#if !data.options.length}<small>No active categorized incoming Grants are available for sending.</small>{/if}
      <fieldset class="m-0 flex gap-[18px] border-0 p-0 [&_label]:flex! [&_label]:items-center [&_label]:gap-1.5! [&_input]:w-auto!"><legend class="mb-2 text-[13px] font-[750]">Format</legend><label><input type="radio" name="mode" value="plain" bind:group={mode}/> Plain</label><label><input type="radio" name="mode" value="rich" bind:group={mode}/> Rich</label></fieldset>
      <label>Title <span>Rich only</span><input name="title" maxlength="128" bind:value={title} disabled={mode==='plain'} /></label>
      <label>Message <span>{mode==='rich'?'Select text, then apply formatting.':'Plain text'}</span>
        {#if mode==='rich'}<span class="flex gap-1.5 [&_button]:min-w-9 [&_button]:px-[9px]! [&_button]:py-1.5! [&_button]:border! [&_button]:border-solid [&_button]:border-[#ccd5cf] [&_button]:bg-[#f7f9f7]! [&_button]:text-[#26352d]!" aria-label="Text formatting"><button type="button" onclick={()=>insert('**')} aria-label="Bold"><strong>B</strong></button><button type="button" onclick={()=>insert('*')} aria-label="Italic"><em>I</em></button><button type="button" onclick={()=>insert('`')} aria-label="Code"><code>&lt;/&gt;</code></button><button type="button" onclick={link} aria-label="Link">Link</button></span>{/if}
        <textarea class="resize-y leading-[1.5]!" name="text" rows="9" maxlength="65536" bind:this={editor} bind:value={text} required></textarea></label>
      <label>Header PNG <span>Optional, rich only</span><input name="header" type="file" accept="image/png" onchange={image} disabled={mode==='plain'} /></label>
      <label>Header alt text<input name="alt" maxlength="1024" bind:value={alt} disabled={mode==='plain'} /></label>
      <label>Header caption<input name="caption" maxlength="1024" bind:value={caption} disabled={mode==='plain'} /></label>
      <label class="flex! items-center gap-2!"><input class="w-auto!" name="allowReply" type="checkbox" value="yes" /> Allow one reply for 7 days</label>
      <button disabled={!data.options.length}>Send message</button>
    </form>
    <section class="hail-card min-h-[360px] p-[22px] font-serif text-[17px] leading-[1.65] max-[760px]:min-h-[260px]" aria-label="Message preview"><p class="m-0 mb-[7px] text-[12px] font-extrabold tracking-[.12em] text-[#22714b] uppercase">Preview</p>{#if mode==='rich'&&preview}<figure class="mx-[-8px] mt-0 mb-5"><img class="block max-h-[260px] w-full rounded-xl object-cover" src={preview} alt={alt}/>{#if caption}<figcaption class="mt-1.5 text-[12px] text-[#68766e]">{caption}</figcaption>{/if}</figure>{/if}{#if mode==='rich'&&title}<h2 class="text-[1.65em]">{title}</h2>{/if}{#if mode==='plain'}<p class="whitespace-pre-wrap">{text}</p>{:else}{#each blocks as block}<p>{#each block.children as span}{@const link=block.markDefs.find(definition=>span.marks.includes(definition._key))}{#if link}<a class="text-[#17633f]" href={link.href} target="_blank" rel="noopener noreferrer">{span.text}</a>{:else if span.marks.includes('code')}<code class="rounded-[.3em] bg-[#edf0ed] px-[.3em] py-[.08em]">{span.text}</code>{:else if span.marks.includes('strong')}<strong>{span.text}</strong>{:else if span.marks.includes('em')}<em>{span.text}</em>{:else}{span.text}{/if}{/each}</p>{/each}{/if}{#if !text&&!title&&!preview}<div class="grid min-h-[240px] place-items-center text-center text-[#8a948e]">Your message preview appears here.</div>{/if}</section>
  </div>
{/if}
