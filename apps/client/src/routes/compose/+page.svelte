<script lang="ts">
  import {parseDraft} from "@racrproto/client-support/drafts";
  import {page} from "$app/state";
  import {forwardBody} from "$lib/forward.js";
  import { tick,untrack,onDestroy } from "svelte";
  import {enhance} from "$app/forms";
  import { composeBlocks,formatLines } from "$lib/compose.js";
  import {parseBody} from "$lib/messages.js";
  import RichText from "$lib/RichText.svelte";
  import Icon from "$lib/Icon.svelte";
  let {data,form}=$props();
  let draftRevision=$state(untrack(()=>data.draft?.revision??0)),draftIdentity=$state(untrack(()=>data.newPublicationId)),savedHeader=$state<string|null>(null);
  let saving=$state(false);
  $effect(()=>{
    const draft=data.draft;
    draftIdentity=data.newPublicationId;draftRevision=draft?.revision??0;
    title=draft?.content.title??'';text=draft?.content.text??'';alt=draft?.content.alt??'';caption=draft?.content.caption??'';
    allowReply=draft?.content.allowReply??false;category=draft?.content.category??'';categoryQuery=categoryLabel(draft?.content.category??'');
    selected=draft?.content.connections??(data.defaultConnection?[data.defaultConnection]:[]);
    savedHeader=draft?.content.header??null;preview=draft?.content.header?'data:image/png;base64,'+draft.content.header.replace(/-/g,'+').replace(/_/g,'/'):null;
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
  {#if form?.error}<div class="mb-5"><p class="hail-error" role="alert">{form.error}</p>{#if retryPublication}<a class="hail-back mt-2" href={batchUrl(retryPublication)}>Check original {isConnection?'message batch':'publication'} status →</a>{/if}</div>{/if}
  {#if form && 'savedDraft' in form && form.savedDraft}<p role="status">Draft saved. <a href="/drafts">View drafts</a></p>{/if}
  <form class="compose-layout" method="POST" use:enhance={({submitter})=>{
    saving=submitter?.getAttribute('formaction')==='?/save';sending=true;
    return async({update,result})=>{try{
      if(result.type==='success'&&result.data?.savedDraft){const saved=parseDraft(result.data.savedDraft);draftRevision=saved.revision;draftIdentity=saved.id;}
      await update({reset:false,invalidateAll:false});
    }finally{sending=false;saving=false;}};
  }} action={isConnection?'?/publish&audience=connections':'?/publish'} enctype="multipart/form-data" aria-busy={sending}>
    <input type="hidden" name="publicationId" value={retryPublication??draftIdentity}/>
    <input type="hidden" name="draftRevision" value={draftRevision}/>
    <input type="hidden" name="savedHeader" value={savedHeader??''}/>
    <input type="hidden" name="audience" value={data.kind}/>
    {#if data.forward}<input type="hidden" name="forwardSender" value={data.forward.message.sender}/><input type="hidden" name="forwardMessage" value={data.forward.message.messageId}/>{/if}
    <div class="writing-workspace">
      <div class="editor-topline"><button class="preview-toggle" type="button" aria-expanded={previewOpen} aria-controls="compose-preview" onclick={()=>previewOpen=!previewOpen}><Icon name={previewOpen?'compose':'preview'} size={16}/>{previewOpen?'Back to writing':'Preview'}</button></div>
      <div class="writing-card">
        {#if isConnection}
          {#each selected as id}<input type="hidden" name="connection" value={id}/>{/each}
          <div class="to-line">
            <label for="recipient-search">To</label>
            <div class="recipient-entry">
              <div class="recipient-chips">
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
            <div class="recipient-entry">
              <input id="category-search" class="category-search" type="text" role="combobox" aria-autocomplete="list" aria-expanded={categoryOpen} aria-controls="category-suggestions" aria-activedescendant={categoryOpen&&categoryMatches[activeCategory]?`category-option-${activeCategory}`:undefined} autocomplete="off" spellcheck="false" placeholder="Find a category…" bind:value={categoryQuery} onfocus={(event)=>{categoryOpen=true;categoryFiltering=false;activeCategory=0;event.currentTarget.select();}} oninput={()=>{categoryFiltering=true;categoryOpen=true;activeCategory=0;}} onblur={()=>categoryOpen=false} onkeydown={categoryKey}/>
              <div class="recipient-suggestions" hidden={!categoryOpen}>
                <div id="category-suggestions" role="listbox" aria-label="Categories">
                  {#each categoryMatches as option,index}<button id={`category-option-${index}`} type="button" role="option" aria-selected={activeCategory===index} tabindex="-1" class="recipient-option category-option" onmousedown={(event)=>event.preventDefault()} onclick={()=>chooseCategory(option.category)}><span>{categoryLabel(option.category)}</span><small>{option.subscribers} subscriber{option.subscribers===1?'':'s'}</small></button>{/each}
                </div>
                {#if !categoryMatches.length}<p role="status">{data.categories.length?'No matching categories.':'No active category subscribers yet.'}</p>{/if}
              </div>
            </div>
          </div>
          {#if categoryReady&&audience>data.maxRecipients}<p class="category-limit text-sm text-danger">Choose an audience with at most {data.maxRecipients} subscribers.</p>{/if}
        {/if}
        <div class="sender-line"><span>From</span><strong>{data.account.address}</strong></div>
        <div class="editor-content" hidden={previewOpen}>
          {#if data.forward}<div class="forward-notice"><Icon name="forward"/><p>The original message and sender details will appear below your note.</p></div>{:else}
            {#if !isConnection}<details class="cover-control" open={!!preview}><summary bind:this={coverSummary}><Icon name="image" size={18}/>{preview?'Cover image added':'Add a cover image'}<span>Optional</span></summary><div class="cover-fields"><label class="hail-field">Header PNG<input name="header" bind:this={headerInput} type="file" accept="image/png" onchange={image}/></label>{#if preview}<img class="cover-thumbnail" src={preview} alt={alt}/><button class="hail-button-secondary justify-self-start" type="button" onclick={removeImage}>Remove image</button>{/if}<label class="hail-field">Image description<input name="alt" oninvalid={revealInvalid} maxlength="1024" bind:value={alt} required={!!preview} placeholder="Describe the image for readers"/></label><label class="hail-field">Caption <span class="optional">Optional</span><input name="caption" maxlength="1024" bind:value={caption}/></label><p class="setting-note">PNG up to 192 KiB. An image description is required.</p></div></details>{/if}
            <label class="title-field"><span class="sr-only">Title (optional)</span><input name="title" maxlength="128" bind:value={title} placeholder={isConnection?'Give it a title (optional)':'Your headline goes here'}/></label>
          {/if}
          <div class="format-toolbar" role="group" aria-label="Text formatting"><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('**')} aria-label="Bold"><strong>B</strong></button><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('*')} aria-label="Italic"><em>I</em></button><button class="hail-button-secondary min-w-11" type="button" onclick={()=>insert('`')} aria-label="Code"><code>&lt;/&gt;</code></button><button class="hail-button-secondary" type="button" onclick={link} aria-label="Link">Link</button><span class="format-divider" aria-hidden="true"></span><button class="hail-button-secondary" type="button" onclick={()=>block('## ')}>Heading</button><button class="hail-button-secondary" type="button" onclick={()=>block('- ')}>Bullets</button><button class="hail-button-secondary" type="button" onclick={()=>block('1. ')}>Numbered list</button><button class="hail-button-secondary" type="button" onclick={()=>block('> ')}>Quote</button></div>
          <label class="sr-only" for="message-text">{data.forward?'Note (optional)':'Message'}</label>
          <textarea id="message-text" oninvalid={revealInvalid} aria-describedby="format-help" name="text" rows={isConnection?10:13} maxlength="65536" bind:this={editor} bind:value={text} required={!data.forward} placeholder={data.forward?'Add a personal note…':isConnection?'What’s on your mind?':'Tell your story. Share an idea. Give them something to look forward to.'}></textarea>
          <div class="editor-meta"><span>{wordCount} word{wordCount===1?'':'s'}</span></div>
        </div>
        <section id="compose-preview" hidden={!previewOpen} class="compose-preview" aria-label="Message preview"><div class="preview-byline"><span class="avatar">{data.account.address.slice(0,1).toUpperCase()}</span><span><strong>{data.account.address}</strong><small>{isConnection?"Message preview":"Publication preview"}</small></span></div><div class="mt-5 text-[17px] leading-[1.8] [overflow-wrap:anywhere]">{#if forwarded}<RichText blocks={forwarded.blocks} header={forwarded.header}/>{:else}{#if data.kind==='category'&&preview}<figure class="m-0 mb-5"><img class="block max-h-[260px] w-full rounded-xl object-contain" src={preview} alt={alt}/>{#if caption}<figcaption class="mt-2 text-xs text-muted">{caption}</figcaption>{/if}</figure>{/if}<RichText {blocks}/>{#if !text&&!title&&!preview}<p class="py-12 text-center font-sans text-sm text-muted">Your message preview appears here.</p>{/if}{/if}</div></section>
        {#if !isConnection}<label class="reply-setting"><input name="allowReply" type="checkbox" value="yes" bind:checked={allowReply}/>Allow one reply per subscriber, within 7 days</label>{/if}
        <footer class="send-bar"><div><strong>{selected.length>1&&isConnection?'Shared conversation':'Ready when you are'}</strong><span>{isConnection&&search.trim()?'Select a matching connection':canPublish?`To ${destination}`:isConnection?'Choose at least one recipient':'Choose a category with subscribers'}</span></div><button class="hail-button-secondary" type="submit" formaction="?/save" formnovalidate disabled={sending}>{saving?'Saving…':'Save as Draft'}</button><button class="hail-button" disabled={sending||!canPublish||(isConnection&&!!search.trim())||(!data.forward&&!text.trim())}>{sending&&!saving?'Sending…':data.forward?'Forward message':'Send message'}</button></footer>
      </div>
    </div>
  </form>
  <button class="mobile-floating-action" type="button" aria-label={previewOpen?'Back to writing':'Preview'} title={previewOpen?'Back to writing':'Preview'} aria-expanded={previewOpen} aria-controls="compose-preview" onclick={()=>previewOpen=!previewOpen}><Icon name={previewOpen?'compose':'preview'} size={24}/></button>
</div>

<style>
  .workspace-heading { display:flex; justify-content:space-between; align-items:center; gap:24px; margin:8px 0 36px; }
  .audience-switch { display:flex; padding:5px; border:1px solid var(--color-line); border-radius:12px; background:var(--color-canvas); flex-shrink:0; }
  .audience-switch a { display:flex; align-items:center; justify-content:center; gap:8px; padding:10px 14px; border-radius:8px; text-decoration:none; font-size:12px; font-weight:600; color:var(--color-muted); }
  .audience-switch a[aria-current] { background:var(--color-surface); color:var(--color-brand-strong); box-shadow:0 2px 5px #0000000a; }
  .compose-layout { display:grid; grid-template-columns:minmax(0,1fr); max-width:900px; margin-inline:auto; }
  .setting-note { font-size:12px; line-height:1.6; color:var(--color-muted); }
  .reply-setting { display:flex; align-items:center; gap:10px; padding:16px 28px; border-top:1px solid var(--color-line); font-size:12px; cursor:pointer; }
  .category-search { width:100%; border:0; background:transparent; padding:8px 4px; font-size:13px; }
  .category-search:focus-visible { outline:none; }
  .category-option>span { flex:1; min-width:0; overflow-wrap:anywhere; }
  .category-option small { color:var(--color-muted); font-size:11px; }
  .category-limit { padding-inline:28px; }
  .avatar { display:grid; place-items:center; flex-shrink:0; width:30px; height:30px; border-radius:50%; background:var(--color-brand-soft); color:var(--color-brand-strong); font-size:12px; font-weight:650; }
  .writing-workspace { min-width:0; }
  .editor-topline { display:flex; align-items:center; justify-content:space-between; margin:0 0 12px; font-size:11px; color:var(--color-muted); }
  .preview-toggle { display:flex; gap:7px; align-items:center; background:none; border:0; color:var(--color-brand-strong); padding:8px; cursor:pointer; font-size:12px; font-weight:600; }
  .writing-card { border:1px solid var(--color-line); border-radius:18px; box-shadow:0 12px 40px #00000004; overflow:hidden; background:var(--color-surface); }
  .sender-line,.to-line { display:flex; align-items:center; gap:16px; padding:16px 28px; font-size:12px; border-bottom:1px solid var(--color-line); }
  .sender-line>span,.to-line>label { color:var(--color-muted); min-width:30px; }
  .sender-line strong { font-weight:500; overflow-wrap:anywhere; min-width:0; }
  .to-line { align-items:baseline; }
  .recipient-entry { position:relative; flex:1; min-width:0; }
  .recipient-chips { display:flex; align-items:center; flex-wrap:wrap; gap:6px; min-width:0; }
  #recipient-search { flex:1; min-width:min(160px,100%); width:0; max-width:100%; border:0; background:transparent; padding:8px 4px; font-size:13px; }
  #recipient-search:focus-visible { outline:none; }
  .recipient-suggestions { position:absolute; top:calc(100% + 8px); left:0; right:0; z-index:5; max-height:260px; overflow-y:auto; padding:6px; border:1px solid var(--color-line); border-radius:10px; background:var(--color-surface); box-shadow:0 8px 24px #0002; }
  .recipient-option { display:flex; align-items:center; gap:10px; width:100%; padding:10px; border:0; border-radius:6px; background:transparent; color:var(--color-ink); text-align:left; cursor:pointer; }
  .recipient-option>span:nth-child(2) { flex:1; min-width:0; overflow-wrap:anywhere; font-size:12px; }
  .recipient-option :global(svg) { flex-shrink:0; }
  .recipient-option:hover,.recipient-option[aria-selected=true] { background:var(--color-brand-soft); }
  .recipient-suggestions p { margin:0; padding:12px; font-size:12px; color:var(--color-muted); }
  .recipient-chip { display:flex; align-items:center; gap:8px; font-size:11px; background:var(--color-brand-soft); color:var(--color-brand-strong); border:0; border-radius:6px; padding:6px 8px; cursor:pointer; overflow-wrap:anywhere; min-width:0; }
  .recipient-chip :global(svg) { flex-shrink:0; }
  .editor-content { padding:28px; }
  .editor-content[hidden],.compose-preview[hidden] { display:none; }
  .title-field input { width:100%; border:0; border-radius:0; padding:16px 0 24px; background:transparent; font:400 clamp(25px,2.7vw,36px)/1.25 Georgia,serif; letter-spacing:-.03em; }
  .conversation .title-field input { font:500 21px/1.4 var(--font-sans); letter-spacing:-.02em; }
  .title-field input::placeholder { color:var(--color-muted); opacity:.8; }
  .cover-control { border:1px dashed var(--color-line); border-radius:10px; margin-bottom:14px; }
  .cover-control summary { display:flex; align-items:center; gap:9px; padding:13px; cursor:pointer; font-size:12px; color:var(--color-muted); }
  .cover-control summary>span { margin-left:auto; font-size:10px; }
  .cover-fields { display:grid; gap:14px; padding:4px 14px 14px; }
  .cover-thumbnail { max-height:180px; width:100%; object-fit:contain; border-radius:8px; }
  .optional { font-weight:400; font-size:11px; color:var(--color-muted); }
  .format-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:2px; padding:5px; border-block:1px solid var(--color-line); background:var(--color-canvas); }
  .format-toolbar button { border:0; background:transparent; padding:8px; font-size:11px; min-height:36px; }
  .format-toolbar button:hover { background:var(--color-brand-soft); }
  .format-divider { width:1px; height:18px; margin-inline:4px; background:var(--color-line); }
  textarea { display:block; width:100%; min-height:300px; border:0; border-radius:0; padding:22px 0; resize:vertical; background:transparent; font-size:16px; line-height:1.85; }
  #message-text:focus-visible { outline:none; }
  textarea::placeholder { color:var(--color-muted); }
  .editor-meta { display:flex; justify-content:space-between; align-items:start; gap:16px; font-size:10px; color:var(--color-muted); }
  .editor-meta>span { flex-shrink:0; }
  .send-bar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:20px 28px; background:var(--color-canvas); border-top:1px solid var(--color-line); }
  .send-bar>div { display:grid; gap:5px; }
  .send-bar strong { font-size:12px; font-weight:600; }
  .send-bar span { font-size:11px; color:var(--color-muted); }
  .send-bar button { flex-shrink:0; }
  .compose-preview { padding:32px; min-height:440px; }
  .preview-byline { display:flex; gap:10px; align-items:center; font-size:12px; overflow-wrap:anywhere; }
  .preview-byline>span:last-child { min-width:0; }
  .preview-byline small { display:block; color:var(--color-muted); margin-top:3px; font-size:10px; }
  .forward-notice { display:flex; gap:12px; font-size:12px; line-height:1.6; color:var(--color-muted); margin-bottom:24px; }
  .forward-notice p { margin:0; }
  .forward-notice :global(svg) { flex-shrink:0; }
  @media(max-width:900px) { .editor-topline { display:none; } .compose-workspace { padding-bottom:112px; } }
  @media(max-width:760px) { .workspace-heading { margin-bottom:24px; } .audience-switch { width:100%; } .audience-switch a { flex:1; } .editor-content,.compose-preview { padding:20px; } .sender-line,.to-line,.reply-setting { padding:16px 20px; } .send-bar { padding:18px 20px; flex-wrap:wrap; } .send-bar button { margin-left:auto; } }
  @media(prefers-reduced-motion:no-preference) { .recipient-option,.audience-switch a { transition:background .15s ease; } }
</style>
