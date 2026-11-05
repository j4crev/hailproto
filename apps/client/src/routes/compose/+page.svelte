<script lang="ts">
  import {parseDraft} from "@racrproto/client-support/drafts";
  import {page} from "$app/state";
  import {forwardBody} from "$lib/forward.js";
  import { tick,untrack,onDestroy } from "svelte";
  import {enhance} from "$app/forms";
  import { composeBlocks,formatLines } from "$lib/compose.js";
  import {parseBody} from "$lib/messages.js";
  import Builder from '@racrproto/content-builder/svelte';
  import {emptyBody,plainText,type BuilderDraft} from '@racrproto/content-builder/core';
  let {data,form}=$props();
  let rich=$state(untrack(()=>!!data.builderInitial)),richInvalid=$state(false),richDraft=$state<BuilderDraft|null>(untrack(()=>data.builderInitial)),richInitial=$state<BuilderDraft>(untrack(()=>data.builderInitial??{version:1,body:emptyBody()}));
  import RichText from "$lib/RichText.svelte";
  import Icon from "$lib/Icon.svelte";
  let draftRevision=$state(untrack(()=>data.draft?.revision??0)),draftIdentity=$state(untrack(()=>data.newPublicationId)),savedHeader=$state<string|null>(null);
  let saving=$state(false);
  $effect(()=>{
    const draft=data.draft;
    rich=!!data.builderInitial;richInitial=data.builderInitial??{version:1,body:emptyBody()};richDraft=data.builderInitial;richInvalid=false;
    draftIdentity=data.newPublicationId;draftRevision=draft?.revision??0;
    title=draft?.content.title??'';text=draft?.content.text??'';alt=draft?.content.alt??'';caption=draft?.content.caption??'';
    allowReply=draft?.content.allowReply??false;category=draft?.content.category??'';categoryQuery=categoryLabel(draft?.content.category??'');
    selected=draft?.content.connections??(data.defaultConnection?[data.defaultConnection]:[]);
    savedHeader=data.builderInitial?null:draft?.content.header??null;preview=draft?.content.header?'data:image/png;base64,'+draft.content.header.replace(/-/g,'+').replace(/_/g,'/'):null;
  });
  let sentToast=$state(false);
  const sentPublication=$derived(!form?.error ? data.status?.publicationId : null);
  $effect(()=>{
    sentToast=Boolean(sentPublication);
    if(!sentPublication)return;
    const timer=setTimeout(()=>{sentToast=false;},5000);
    return ()=>clearTimeout(timer);
  });
  let title=$state(""),text=$state(""),alt=$state(""),caption=$state(""),preview=$state<string|null>(null);
  let previewOpen=$state(false);
  let savedAttachments=$state<import("@racrproto/client-support/drafts").DraftContent["attachments"]>([]);
  let attachmentInput=$state<HTMLInputElement>();
  $effect(()=>{savedAttachments=data.draft?.content.attachments??[];});
  let headerInput=$state<HTMLInputElement>();
  let coverSummary=$state<HTMLElement>();
  let search=$state("");
  let recipientInput=$state<HTMLInputElement>();
  let suggestionsOpen=$state(false);
  let activeSuggestion=$state(0);
  let sending=$state(false);
  let allowReply=$state(false);
  let selected=$state<string[]>(untrack(()=>data.defaultConnection?[data.defaultConnection]:[]));
  const isConnection=$derived(data.kind==='connections');
  const recipients=$derived(selected.map(id=>data.connections.find(c=>c.connectionId===id)??{connectionId:id,address:"Unavailable connection",recipientDid:""}));
  const matches=$derived(data.connections.filter(c=>!selected.includes(c.connectionId)&&`${c.address} ${c.recipientDid}`.toLowerCase().includes(search.trim().toLowerCase())));
  const showSuggestions=$derived(suggestionsOpen&&(matches.length>0||!!search.trim()||!data.connections.length));
  const wordCount=$derived(text.trim()?text.trim().split(/\s+/).length:0);
  let editor=$state<HTMLTextAreaElement>();
  let category=$state("");
  const categoryLabel=(value:string)=>value==='general'?'General':value;
  let categoryQuery=$state("");
  let categoryOpen=$state(false),categoryFiltering=$state(false),activeCategory=$state(0);
  const categoryMatches=$derived(data.categories.filter(row=>!categoryFiltering||categoryLabel(row.category).toLowerCase().includes(categoryQuery.trim().toLowerCase())));
  const categoryReady=$derived(!!category&&categoryQuery===categoryLabel(category));
  function chooseCategory(value:string){category=value;categoryQuery=categoryLabel(value);categoryOpen=false;categoryFiltering=false;activeCategory=0;}
  async function categoryKey(event:KeyboardEvent){
    if(event.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();categoryQuery=categoryLabel(category);categoryOpen=false;return;}
    if(event.key==='Enter'){
      event.preventDefault();
      if(categoryOpen&&categoryMatches[activeCategory])chooseCategory(categoryMatches[activeCategory].category);
      else categoryOpen=true;
    }else if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();
      const direction=event.key==='ArrowDown'?1:-1;
      activeCategory=categoryOpen?(activeCategory+direction+categoryMatches.length)%Math.max(categoryMatches.length,1):0;
      categoryOpen=true;await tick();
      document.getElementById(`category-option-${activeCategory}`)?.scrollIntoView({block:'nearest'});
    }
  }

  let audience=$derived(data.categories.find(row=>row.category===category)?.subscribers??0);
  const destination=$derived(isConnection?`${selected.length} connection${selected.length===1?'':'s'}`:`${audience} subscriber${audience===1?'':'s'}`);
  let canPublish=$derived(data.kind==="connections"?selected.length>0&&selected.length<=data.maxRecipients&&selected.every(id=>data.connections.some(c=>c.connectionId===id)):categoryReady&&audience>0&&audience<=data.maxRecipients);
  let retryPublication=$derived(form&&"publicationId" in form&&typeof form.publicationId==="string"?form.publicationId:null);
  const batchUrl=(id:string)=>`/compose?${data.kind==='connections'?'audience=connections&':''}publication=${id}`;
  let forwarded=$derived(data.forward?parseBody(forwardBody(data.forward,text)):null);
  const richPreview=$derived(richDraft&&!richInvalid?parseBody(richDraft.body):null);
  let blocks=$derived(parseBody({version:1,profile:"spt-2",blocks:composeBlocks(title,text)}).blocks);
  $effect(()=>{
    if(data.kind==='connections'){
      const previous=untrack(()=>preview);
      if(previous)URL.revokeObjectURL(previous);
      preview=null;alt='';caption='';
    }
  });
  onDestroy(()=>{if(preview)URL.revokeObjectURL(preview);});
  async function addRecipient(id:string){
    if(selected.length>=data.maxRecipients||selected.includes(id))return;
    selected=[...selected,id];search="";activeSuggestion=0;suggestionsOpen=true;
    await tick();recipientInput?.focus();
  }
  async function removeRecipient(id:string){
    selected=selected.filter(value=>value!==id);activeSuggestion=0;
    await tick();recipientInput?.focus();
  }
  async function recipientKey(event:KeyboardEvent){
    if(event.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();suggestionsOpen=false;return;}
    if(event.key==='Enter'){
      event.preventDefault();
      if(suggestionsOpen&&matches[activeSuggestion])await addRecipient(matches[activeSuggestion].connectionId);
      else suggestionsOpen=true;
    }else if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();
      const direction=event.key==='ArrowDown'?1:-1;
      activeSuggestion=suggestionsOpen?(activeSuggestion+direction+matches.length)%Math.max(matches.length,1):0;
      suggestionsOpen=true;await tick();
      document.getElementById(`recipient-option-${activeSuggestion}`)?.scrollIntoView({block:'nearest'});
    }
  }
  async function revealInvalid(event:Event){
    if(!previewOpen)return;
    event.preventDefault();previewOpen=false;await tick();
    (event.target as HTMLElement).focus();
  }
  async function removeImage(){
    if(preview)URL.revokeObjectURL(preview);
    if(headerInput)headerInput.value="";
    preview=null;savedHeader=null;alt="";caption="";
    await tick();coverSummary?.focus();
  }
  function image(event:Event){savedHeader=null;if(preview)URL.revokeObjectURL(preview);const file=(event.currentTarget as HTMLInputElement).files?.[0];preview=file?URL.createObjectURL(file):null;}
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

<svelte:head><title>{data.forward?"Forward a message":isConnection?"New conversation":"New publication"} · {page.data.branding?.name ?? "Hail"}</title></svelte:head>
<div class="compose-workspace" class:conversation={isConnection}>
  <header class="workspace-heading">
    {#if !data.forward}<nav class="audience-switch" aria-label="Compose audience"><a href="/compose?audience=connections" aria-current={isConnection?'page':undefined}><Icon name="chat" size={17}/>Connections</a><a href="/compose" aria-current={!isConnection?'page':undefined}><Icon name="feed" size={17}/>Subscribers</a></nav>{/if}
  </header>
  <div role="status" aria-atomic="true">{#if sentToast}<div class="hail-success-toast"><Icon name="check"/><span>Message sent.</span></div>{/if}</div>
  {#if data.builderFallback}<p role="status">This draft could not be opened in the new editor. You can continue editing it here; its original content has been preserved.</p>{/if}
  {#if form?.error}<div class="mb-5"><p class="hail-error" role="alert">{form.error}</p>{#if retryPublication}<a class="hail-back mt-2" href={batchUrl(retryPublication)}>Check original {isConnection?'message batch':'publication'} status →</a>{/if}</div>{/if}
  {#if form && 'savedDraft' in form && form.savedDraft}<p role="status">Draft saved. <a href="/drafts">View drafts</a></p>{/if}
  <form class="compose-layout grid grid-cols-[minmax(0,1fr)] max-w-[900px] mx-auto" method="POST" use:enhance={({submitter})=>{
    saving=submitter?.getAttribute('formaction')==='?/save';sending=true;
    return async({update,result})=>{try{
      if(result.type==='success'&&result.data?.savedDraft){const saved=parseDraft(result.data.savedDraft);draftRevision=saved.revision;draftIdentity=saved.id;savedAttachments=saved.content.attachments??[];if(attachmentInput)attachmentInput.value="";}
      await update({reset:false,invalidateAll:false});
    }finally{sending=false;saving=false;}};
  }} action={isConnection?'?/publish&audience=connections':'?/publish'} enctype="multipart/form-data" aria-busy={sending}>
    {#if rich}<input type="hidden" name="builder" value={richDraft?JSON.stringify(richDraft):''}/>{/if}
    <input type="hidden" name="publicationId" value={retryPublication??draftIdentity}/>
    <input type="hidden" name="draftRevision" value={draftRevision}/>
    <input type="hidden" name="savedHeader" value={savedHeader??''}/>
    <input type="hidden" name="audience" value={data.kind}/>
    {#if data.forward}<input type="hidden" name="forwardSender" value={data.forward.message.sender}/><input type="hidden" name="forwardMessage" value={data.forward.message.messageId}/>{/if}
    <div class="writing-workspace min-w-0">
      <div class="editor-topline"><button class="preview-toggle flex gap-[7px] items-center [background:none] [border:0] text-brand-strong p-[8px] cursor-pointer text-[12px] font-[600]" type="button" aria-expanded={previewOpen} aria-controls="compose-preview" onclick={()=>previewOpen=!previewOpen}><Icon name={previewOpen?'compose':'preview'} size={16}/>{previewOpen?'Back to writing':'Preview'}</button></div>
      <div class="writing-card [border:1px_solid_var(--color-line)] rounded-[18px] [box-shadow:0_12px_40px_#00000004] overflow-hidden [background:var(--color-surface)]">
        {#if isConnection}
          {#each selected as id}<input type="hidden" name="connection" value={id}/>{/each}
          <div class="to-line">
            <label for="recipient-search">To</label>
            <div class="recipient-entry relative flex-1 min-w-0">
              <div class="recipient-chips flex items-center flex-wrap gap-[6px] min-w-0">
                {#each recipients as recipient}<button type="button" class="recipient-chip" onclick={()=>removeRecipient(recipient.connectionId)} aria-label={`Remove ${recipient.address}`}>{recipient.address}<Icon name="close" size={13}/></button>{/each}
                <input id="recipient-search" type="text" role="combobox" aria-autocomplete="list" aria-expanded={showSuggestions} aria-controls="recipient-suggestions" aria-activedescendant={showSuggestions&&selected.length<data.maxRecipients&&matches[activeSuggestion]?`recipient-option-${activeSuggestion}`:undefined} autocomplete="off" spellcheck="false" placeholder={selected.length?'':'Find a connection…'} bind:this={recipientInput} bind:value={search} oninput={()=>{suggestionsOpen=true;activeSuggestion=0;}} onfocus={()=>{suggestionsOpen=true;activeSuggestion=0;}} onblur={()=>suggestionsOpen=false} onkeydown={recipientKey}/>
              </div>
              <div class="recipient-suggestions" hidden={!showSuggestions}>
                <div id="recipient-suggestions" role="listbox" aria-label="Connections">
                  {#if selected.length<data.maxRecipients}{#each matches as connection,index}
                    <button id={`recipient-option-${index}`} type="button" role="option" aria-selected={activeSuggestion===index} tabindex="-1" class="recipient-option" onmousedown={(event)=>event.preventDefault()} onclick={()=>addRecipient(connection.connectionId)}>
                      <span class="avatar">{connection.address.slice(0,1).toUpperCase()}</span><span>{connection.address}</span><Icon name="plus" size={16}/>
                    </button>
                  {/each}{/if}
                </div>
                {#if selected.length>=data.maxRecipients}<p role="status">You can select up to {data.maxRecipients} connections.</p>
                {:else if !data.connections.length}<p role="status">No connections yet. <a href="/connections" onmousedown={(event)=>event.preventDefault()}>Add a connection</a></p>
                {:else if !matches.length}<p role="status">No matching connections.</p>{/if}
              </div>
            </div>
          </div>
        {/if}
        {#if !isConnection}
          <input type="hidden" name="category" value={categoryReady?category:''}/>
          <div class="to-line category-line">
            <label for="category-search">Category</label>
            <div class="recipient-entry relative flex-1 min-w-0">
              <input id="category-search" class="category-search" type="text" role="combobox" aria-autocomplete="list" aria-expanded={categoryOpen} aria-controls="category-suggestions" aria-activedescendant={categoryOpen&&categoryMatches[activeCategory]?`category-option-${activeCategory}`:undefined} autocomplete="off" spellcheck="false" placeholder="Find a category…" bind:value={categoryQuery} onfocus={(event)=>{categoryOpen=true;categoryFiltering=false;activeCategory=0;event.currentTarget.select();}} oninput={()=>{categoryFiltering=true;categoryOpen=true;activeCategory=0;}} onblur={()=>categoryOpen=false} onkeydown={categoryKey}/>
              <div class="recipient-suggestions" hidden={!categoryOpen}>
                <div id="category-suggestions" role="listbox" aria-label="Categories">
                  {#each categoryMatches as option,index}<button id={`category-option-${index}`} type="button" role="option" aria-selected={activeCategory===index} tabindex="-1" class="recipient-option category-option" onmousedown={(event)=>event.preventDefault()} onclick={()=>chooseCategory(option.category)}><span>{categoryLabel(option.category)}</span><small>{option.subscribers} subscriber{option.subscribers===1?'':'s'}</small></button>{/each}
                </div>
                {#if !categoryMatches.length}<p role="status">{data.categories.length?'No matching categories.':'No active category subscribers yet.'}</p>{/if}
              </div>
            </div>
          </div>
          {#if categoryReady&&audience>data.maxRecipients}<p class="category-limit text-sm text-danger px-[28px]">Choose an audience with at most {data.maxRecipients} subscribers.</p>{/if}
        {/if}
        <div class="sender-line"><span>From</span><strong>{data.account.address}</strong></div>
        {#if rich}
          {#key draftIdentity}<div class="builder-editor p-5" hidden={previewOpen}><Builder showPreview={false} initial={richInitial} profiles={isConnection?['spt-2']:['spt-2','spt-3']} onchange={(value,issues)=>{richDraft=value;richInvalid=issues.length>0;}}/></div>{/key}
        {:else}
        <div class="editor-content" hidden={previewOpen}>
          {#if data.forward}<div class="forward-notice"><Icon name="forward"/><p>The original message and sender details will appear below your note.</p></div>{:else}
            {#if !isConnection}<details class="cover-control" open={!!preview}><summary bind:this={coverSummary}><Icon name="image" size={18}/>{preview?'Cover image added':'Add a cover image'}<span>Optional</span></summary><div class="cover-fields grid gap-[14px] [padding:4px_14px_14px]"><label class="hail-field">Header PNG<input name="header" bind:this={headerInput} type="file" accept="image/png" onchange={image}/></label>{#if preview}<img class="cover-thumbnail max-h-[180px] w-full object-contain rounded-[8px]" src={preview} alt={alt}/><button class="hail-button-secondary justify-self-start" type="button" onclick={removeImage}>Remove image</button>{/if}<label class="hail-field">Image description<input name="alt" oninvalid={revealInvalid} maxlength="1024" bind:value={alt} required={!!preview} placeholder="Describe the image for readers"/></label><label class="hail-field">Caption <span class="optional font-[400] text-[11px] text-muted">Optional</span><input name="caption" maxlength="1024" bind:value={caption}/></label><p class="setting-note text-[12px] leading-[1.6] text-muted">PNG up to 192 KiB. An image description is required.</p></div></details>{/if}
            <label class="title-field"><span class="sr-only">Title (optional)</span><input name="title" maxlength="128" bind:value={title} placeholder={isConnection?'Give it a title (optional)':'Your headline goes here'}/></label>
          {/if}
          <div class="format-toolbar" role="group" aria-label="Text formatting"><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('**')} aria-label="Bold"><strong>B</strong></button><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('*')} aria-label="Italic"><em>I</em></button><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('`')} aria-label="Code"><code>&lt;/&gt;</code></button><button class="hail-button-secondary" type="button" onclick={link} aria-label="Link">Link</button><span class="format-divider w-[1px] h-[18px] mx-[4px] [background:var(--color-line)]" aria-hidden="true"></span><button class="hail-button-secondary" type="button" onclick={()=>block('## ')}>Heading</button><button class="hail-button-secondary" type="button" onclick={()=>block('- ')}>Bullets</button><button class="hail-button-secondary" type="button" onclick={()=>block('1. ')}>Numbered list</button><button class="hail-button-secondary" type="button" onclick={()=>block('> ')}>Quote</button></div>
          <label class="sr-only" for="message-text">{data.forward?'Note (optional)':'Message'}</label>
          <textarea id="message-text" oninvalid={revealInvalid} aria-describedby="format-help" name="text" rows={isConnection?10:13} maxlength="65536" bind:this={editor} bind:value={text} required={!data.forward} placeholder={data.forward?'Add a personal note…':isConnection?'What’s on your mind?':'Tell your story. Share an idea. Give them something to look forward to.'}></textarea>
          <div class="editor-meta"><span>{wordCount} word{wordCount===1?'':'s'}</span></div>
        </div>
        {/if}
        <section id="compose-preview" hidden={!previewOpen} class="compose-preview" aria-label="Message preview"><div class="preview-byline"><span class="avatar">{data.account.address.slice(0,1).toUpperCase()}</span><span><strong>{data.account.address}</strong><small>{isConnection?"Message preview":"Publication preview"}</small></span></div><div class="mt-5 text-[17px] leading-[1.8] [overflow-wrap:anywhere]">{#if rich}{#if richPreview}<RichText blocks={richPreview.blocks} header={richPreview.header}/>{:else}<p>Complete the image description and fix any validation errors to preview your message.</p>{/if}{:else if forwarded}<RichText blocks={forwarded.blocks} header={forwarded.header}/>{:else}{#if data.kind==='category'&&preview}<figure class="m-0 mb-5"><img class="block max-h-[260px] w-full rounded-xl object-contain" src={preview} alt={alt}/>{#if caption}<figcaption class="mt-2 text-xs text-muted">{caption}</figcaption>{/if}</figure>{/if}<RichText {blocks}/>{#if !text&&!title&&!preview}<p class="py-12 text-center font-sans text-sm text-muted">Your message preview appears here.</p>{/if}{/if}</div></section>
        {#if !isConnection}<label class="reply-setting"><input name="allowReply" type="checkbox" value="yes" bind:checked={allowReply}/>Allow one reply per subscriber, within 7 days</label>{/if}
        <section aria-label="Attachments" class="grid min-w-0 justify-items-start gap-2 px-[28px] py-[20px] [@media(max-width:760px)]:px-[20px]">
          <label for="attachments">Attachments</label>
          <input id="attachments" class="min-w-0 max-w-full" aria-describedby="attachments-help" name="attachment" type="file" accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.log" multiple bind:this={attachmentInput} />
          <p id="attachments-help" class="m-0 text-xs text-muted">PNG, JPEG, WebP, PDF, TXT, LOG · 25 MiB total · up to 20 files</p>
          <input type="hidden" name="savedAttachments" value={JSON.stringify(savedAttachments)} />
          {#each savedAttachments??[] as file,i}<p>{file.filename} ({file.size.toLocaleString()} bytes) <button type="button" onclick={()=>savedAttachments=savedAttachments?.filter((_,index)=>index!==i)}>Remove</button></p>{/each}
        </section>
        <footer class="send-bar">
          <div class="grid min-w-0 flex-[1_1_220px] gap-[5px] [overflow-wrap:anywhere]"><strong>{selected.length>1&&isConnection?'Shared conversation':'Ready when you are'}</strong><span>{isConnection&&search.trim()?'Select a matching connection':canPublish?`To ${destination}`:isConnection?'Choose at least one recipient':'Choose a category with subscribers'}</span></div>
          <div class="grid min-w-0 flex-[1_1_300px] grid-cols-2 gap-[12px]">
            <button class="hail-button-secondary min-w-0" type="submit" formaction="?/save" formnovalidate disabled={sending||(rich&&!richDraft)}>{saving?'Saving…':'Save as Draft'}</button>
            <button class="hail-button min-w-0" disabled={sending||!canPublish||(isConnection&&!!search.trim())||(rich?(richInvalid||!richDraft||!plainText(richDraft.body).trim()):(!data.forward&&!text.trim()))}>{sending&&!saving?'Sending…':data.forward?'Forward message':'Send message'}</button>
          </div>
        </footer>
      </div>
    </div>
  </form>
  <button class="mobile-floating-action" type="button" aria-label={previewOpen?'Back to writing':'Preview'} title={previewOpen?'Back to writing':'Preview'} aria-expanded={previewOpen} aria-controls="compose-preview" onclick={()=>previewOpen=!previewOpen}><Icon name={previewOpen?'compose':'preview'} size={24}/></button>
</div>

<style lang="postcss">
  @reference "../../app.css";

  .workspace-heading { @apply flex justify-between items-center gap-[24px] [margin:8px_0_36px]; }
  .audience-switch { @apply flex p-[5px] [border:1px_solid_var(--color-line)] rounded-[12px] [background:var(--color-canvas)] shrink-0; }
  .audience-switch a {
    @apply flex items-center justify-center gap-[8px] [padding:10px_14px] rounded-[8px] [text-decoration:none]
      text-[12px] font-[600] text-muted;
  }
  .audience-switch a[aria-current] { @apply [background:var(--color-surface)] text-brand-strong [box-shadow:0_2px_5px_#0000000a]; }
  .reply-setting { @apply flex items-center gap-[10px] [padding:16px_28px] [border-top:1px_solid_var(--color-line)] text-[12px] cursor-pointer; }
  .category-search { @apply w-full [border:0] [background:transparent] [padding:8px_4px] text-[13px]; }
  .category-search:focus-visible { @apply [outline:none]; }
  .category-option>span { @apply flex-1 min-w-0 [overflow-wrap:anywhere]; }
  .category-option small { @apply text-muted text-[11px]; }
  .avatar { @apply grid place-items-center shrink-0 w-[30px] h-[30px] rounded-[50%] [background:var(--color-brand-soft)] text-brand-strong text-[12px] font-[650]; }
  .editor-topline { @apply flex items-center justify-between [margin:0_0_12px] text-[11px] text-muted; }
  .sender-line,.to-line { @apply flex items-center gap-[16px] [padding:16px_28px] text-[12px] [border-bottom:1px_solid_var(--color-line)]; }
  .sender-line>span,.to-line>label { @apply text-muted min-w-[30px]; }
  .sender-line strong { @apply font-[500] [overflow-wrap:anywhere] min-w-0; }
  .to-line { @apply items-baseline; }
  #recipient-search { @apply flex-1 min-w-[min(160px,100%)] w-0 max-w-full [border:0] [background:transparent] [padding:8px_4px] text-[13px]; }
  #recipient-search:focus-visible { @apply [outline:none]; }
  .recipient-suggestions {
    @apply absolute top-[calc(100%_+_8px)] left-0 right-0 z-[5] max-h-[260px] overflow-y-auto p-[6px]
      [border:1px_solid_var(--color-line)] rounded-[10px] [background:var(--color-surface)] [box-shadow:0_8px_24px_#0002];
  }
  .recipient-option { @apply flex items-center gap-[10px] w-full p-[10px] [border:0] rounded-[6px] [background:transparent] text-ink text-left cursor-pointer; }
  .recipient-option>span:nth-child(2) { @apply flex-1 min-w-0 [overflow-wrap:anywhere] text-[12px]; }
  .recipient-option :global(svg) { @apply shrink-0; }
  .recipient-option:hover,.recipient-option[aria-selected=true] { @apply [background:var(--color-brand-soft)]; }
  .recipient-suggestions p { @apply m-0 p-[12px] text-[12px] text-muted; }
  .recipient-chip {
    @apply flex items-center gap-[8px] text-[11px] [background:var(--color-brand-soft)] text-brand-strong [border:0]
      rounded-[6px] [padding:6px_8px] cursor-pointer [overflow-wrap:anywhere] min-w-0;
  }
  .recipient-chip :global(svg) { @apply shrink-0; }
  .editor-content { @apply p-[28px]; }
  .builder-editor[hidden],.editor-content[hidden],.compose-preview[hidden] { @apply hidden; }
  .title-field input {
    @apply w-full [border:0] rounded-none [padding:16px_0_24px] [background:transparent];
    font: 400 clamp(25px,2.7vw,36px)/1.25 Georgia,serif;
    @apply tracking-[-.03em];
  }
  .conversation .title-field input { font: 500 21px/1.4 var(--font-sans); @apply tracking-[-.02em]; }
  .title-field input::placeholder { @apply text-muted opacity-[.8]; }
  .cover-control { @apply [border:1px_dashed_var(--color-line)] rounded-[10px] mb-[14px]; }
  .cover-control summary { @apply flex items-center gap-[9px] p-[13px] cursor-pointer text-[12px] text-muted; }
  .cover-control summary>span { @apply ml-auto text-[10px]; }
  .format-toolbar { @apply flex items-center flex-wrap gap-[2px] p-[5px] [border-block:1px_solid_var(--color-line)] [background:var(--color-canvas)]; }
  .format-toolbar button { @apply [border:0] [background:transparent] p-[8px] text-[13px] min-h-[36px]; }
  .format-toolbar button:hover { @apply [background:var(--color-brand-soft)]; }
  textarea { @apply block w-full min-h-[300px] [border:0] rounded-none [padding:22px_0] resize-y [background:transparent] text-[16px] leading-[1.85]; }
  #message-text:focus-visible { @apply [outline:none]; }
  textarea::placeholder { @apply text-muted; }
  .editor-meta { @apply flex justify-between [align-items:start] gap-[16px] text-[10px] text-muted; }
  .editor-meta>span { @apply shrink-0; }
  .send-bar { @apply flex flex-wrap items-center justify-between gap-[16px] [padding:20px_28px] [background:var(--color-canvas)] [border-top:1px_solid_var(--color-line)]; }
  .send-bar strong { @apply text-[12px] font-[600]; }
  .send-bar span { @apply text-[11px] text-muted; }
  .send-bar button { @apply shrink-0; }
  .compose-preview { @apply p-[32px] min-h-[440px]; }
  .preview-byline { @apply flex gap-[10px] items-center text-[12px] [overflow-wrap:anywhere]; }
  .preview-byline>span:last-child { @apply min-w-0; }
  .preview-byline small { @apply block text-muted mt-[3px] text-[10px]; }
  .forward-notice { @apply flex gap-[12px] text-[12px] leading-[1.6] text-muted mb-[24px]; }
  .forward-notice p { @apply m-0; }
  .forward-notice :global(svg) { @apply shrink-0; }
  @media (max-width:900px) {
    .editor-topline { @apply hidden; }
    .compose-workspace { @apply pb-[112px]; }
  }
  @media (max-width:760px) {
    .workspace-heading { @apply mb-[24px]; }
    .audience-switch { @apply w-full; }
    .audience-switch a { @apply flex-1; }
    .editor-content,.compose-preview { @apply p-[20px]; }
    .sender-line,.to-line,.reply-setting { @apply [padding:16px_20px]; }
    .send-bar { @apply [padding:18px_20px]; }
  }
  @media (prefers-reduced-motion:no-preference) {
    .recipient-option,.audience-switch a { transition: background .15s ease; }
  }
</style>
