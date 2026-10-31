<script lang="ts">
  import {tick} from 'svelte';
  import {invalidate} from '$app/navigation';
  import {enhance,applyAction} from '$app/forms';
  import MessageListRow from '$lib/MessageListRow.svelte';
  import SelectionAvatar from '$lib/SelectionAvatar.svelte';
  import ContactAddress from '$lib/ContactAddress.svelte';
  import DateTime from '$lib/DateTime.svelte';
  import IdentityDetails from '$lib/IdentityDetails.svelte';
  import QuotedMessage from '$lib/QuotedMessage.svelte';
  import MessageActions from '$lib/MessageActions.svelte';
  import Icon from '$lib/Icon.svelte';
  import {parseConversation,conversationKey,type ConversationRow} from '$lib/connection-threads.js';
  import {parseMessage,parseSentMessage,messageDisplayContent,type MessageView,type SentMessageView} from '$lib/messages.js';
  import {mailboxRequest} from '$lib/mailbox.js';
  import {forwardHref} from '$lib/forward.js';
  let {data}=$props();
  let replyFailure=$state<{error?:string;messageId?:string;text?:string}>({});
  let rows=$state<ConversationRow[]>([]),selected=$state(''),message=$state<MessageView|SentMessageView>(),start=$state(0),total=$state(0),newerUnread=$state(0);
  let pending=$state(false),readPending=$state(false),error=$state(''),replyOpen=$state(false),sending=$state(false),paging=$state(false);
  let newerEdge=$state<HTMLDivElement>(),pagingError=$state(false);
  $effect(()=>{
    const edge=newerEdge;
    if(!edge||!start||paging||pagingError)return;
    const observer=new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting))void more(true);
    },{rootMargin:'160px 0px 0px 0px'});
    observer.observe(edge);
    return()=>observer.disconnect();
  });
  let replyInput=$state<HTMLTextAreaElement>();
  let request=0;
  $effect(()=>{
    request++;pagingError=false;
    rows=data.thread.messages.map(m=>({...m}));start=data.thread.start;total=data.thread.total;newerUnread=data.thread.newerUnread;
    selected=conversationKey(data.thread.selected);message=data.message;replyOpen=false;
    void markRead(data.thread.selected,data.message);
  });
  async function markRead(row:{sender:string;messageId:string;sent:boolean},value:MessageView|SentMessageView){
    if(row.sent||value.isRead)return;
    readPending=true;
    try{await mailboxRequest(`inbox/${encodeURIComponent(row.sender)}/${row.messageId}/mark-read`,{});
      rows=rows.map(m=>conversationKey(m)===conversationKey(row)?{...m,isRead:true}:m);
      await invalidate('hail:mailbox');
    }catch{error='Unable to mark this message read. Reopen it to try again.';}
    finally{readPending=false;}
  }
  async function open(row:ConversationRow){
    if(sending||readPending)return;
    if(conversationKey(row)===selected)return;
    const token=++request;pending=true;error='';
    try{
      const raw=await mailboxRequest(row.sent?`sent/${row.messageId}`:`inbox/${encodeURIComponent(row.sender)}/${row.messageId}`);
      if(token!==request)return;
      const value=row.sent?parseSentMessage(raw):parseMessage(raw);
      selected=conversationKey(row);message=value;replyOpen=false;replyFailure={};
      await tick();
      const heading=document.getElementById('row-'+row.messageId);
      heading?.querySelector<HTMLElement>('.expanded-header')?.focus({preventScroll:true});
      if(heading && (heading.getBoundingClientRect().top<80||heading.getBoundingClientRect().top>window.innerHeight-100))heading.scrollIntoView({block:'start'});
      await markRead(row,value);
    }catch{error='Unable to open this message. Try again.';}
    finally{if(token===request)pending=false;}
  }
  async function more(newer:boolean){
    if(paging)return;
    paging=true;pagingError=false;error='';
    const anchor=rows[0]?document.getElementById('row-'+rows[0].messageId):null;
    const anchorTop=anchor?.getBoundingClientRect().top;
    try{
      const offset=newer?Math.max(0,start-30):start+rows.length;
      const page=parseConversation(await mailboxRequest(`connection-threads/${encodeURIComponent(data.root.sender)}/${data.root.messageId}?offset=${offset}`));
      const existing=new Set(rows.map(conversationKey));
      const added=page.messages.filter(m=>!existing.has(conversationKey(m)));
      rows=newer?[...added,...rows]:[...rows,...added];total=page.total;
      if(newer){start=page.start;newerUnread=page.newerUnread;await tick();if(anchor&&anchorTop!==undefined)window.scrollBy(0,anchor.getBoundingClientRect().top-anchorTop);}
    }catch{pagingError=newer;error='Unable to load more of this conversation. Try again.';}
    finally{paging=false;}
  }
  const conversationSubject=$derived(messageDisplayContent(data.message.blocks).title);
  async function markedUnread(row:ConversationRow){
    const key=conversationKey(row);
    rows=rows.map(m=>conversationKey(m)===key?{...m,isRead:false}:m);
    if(selected===key){
      selected='';message=undefined;replyOpen=false;replyFailure={};
      await tick();
      const element=document.getElementById('row-'+row.messageId);
      element?.querySelector<HTMLElement>('button.row-button')?.focus({preventScroll:true});
      if(element&&(element.getBoundingClientRect().top<80||element.getBoundingClientRect().bottom>innerHeight))element.scrollIntoView({block:'nearest'});
    }
    await invalidate('hail:mailbox');
  }
  const content=$derived(message?messageDisplayContent(message.blocks):null);
  async function reply(){replyOpen=true;await tick();replyInput?.focus();}
</script>
<svelte:head><title>{conversationSubject || 'Messages'} · Haili</title></svelte:head>
<a class="hail-back" href="/?view=connections">← Inbox</a>
<h1 class="hail-title conversation-subject" class:sr-only={!conversationSubject}>{conversationSubject || 'Messages'}</h1>
{#if error}<p class="hail-error" role="alert">{error}</p>{/if}
{#if replyFailure.error}<p class="hail-error" role="alert">{replyFailure.error}</p>{/if}
{#if pending}<p class="text-sm text-muted" role="status">Opening message…</p>{/if}
{#if start>0}<div class="newer-edge" bind:this={newerEdge}>
  {#if pagingError}<button class="hail-button-secondary" disabled={paging} onclick={()=>more(true)}>Retry loading newer messages</button>
  {:else}<span role="status">{paging?'Loading newer messages…':newerUnread?`↑ ${newerUnread} unread above`:'↑ Newer messages above'}</span>{/if}
</div>{/if}
<section aria-label="Conversation messages" aria-busy={pending}>
{#each rows as row (conversationKey(row))}
  {@const expanded=conversationKey(row)===selected}
  <div class="conversation-item" class:expanded id={'row-'+row.messageId}>
    {#if expanded && message && content}
      {#if content.title && content.title!==conversationSubject}<h2 class="different-subject">{content.title}</h2>{/if}
      <header class="expanded-header" tabindex="-1" aria-label={row.sent?'Message from you':`Message from ${row.senderAddress??row.sender}`}>
        <span class="expanded-date"><DateTime format="list" value={row.createdAt} /></span>
        <div class="sender-avatar"><SelectionAvatar name={row.sent?'You':row.senderAddress??row.sender} avatar={data.avatars[row.sender]} /></div>
        <div class="sender-identity">
          <div class="sender-address">{#if row.sent}You{:else}<ContactAddress owner={data.account.did} did={row.sender} address={row.senderAddress} />{/if}</div>
          {#if row.sent || row.senderAddress}<IdentityDetails did={row.sender} />{/if}
          {#if row.sent}<p class="recipients">To {row.recipients.map(r=>r.address??r.did).join(', ')}</p>{/if}
        </div>
        <div class="message-tools">

            {#if !row.sent}
              <button class="hail-icon-button compact" title="Reply" aria-label="Reply" disabled={!message.connection?.active||sending} aria-expanded={replyOpen} onclick={reply}><Icon name="reply" /></button>
              <a class="hail-icon-button compact" title="Forward" aria-label="Forward" href={forwardHref(message as MessageView)}><Icon name="forward" /></a>
              <MessageActions compact menu disabled={readPending||sending} messages={[message]} onmarkedunread={()=>markedUnread(row)} returnTo="/?view=connections" />
            {:else}<a class="text-xs text-muted" href={`/sent/${row.messageId}`}>Delivery details</a>{/if}
        </div>
      </header>
      <div class="expanded-body">
        <div class="reading-body"><QuotedMessage blocks={content.blocks} header={message.header} /></div>
        {#if !row.sent && !message.connection?.active}<p class="text-sm text-muted">This connection is no longer active. Saved messages remain readable.</p>{/if}
        {#if replyOpen && !row.sent && message.connection?.active}
          <form class="reply-form" method="POST" action={`/message/${encodeURIComponent(row.sender)}/${row.messageId}?/reply`} use:enhance={()=>{sending=true;return async({result})=>{sending=false;if(result.type==='failure')replyFailure=result.data??{};else await applyAction(result);};}}>
            <input type="hidden" name="messageId" value={replyFailure.messageId??data.newReplyId} />
            <label class="hail-field">Reply to {row.senderAddress??row.sender}<textarea bind:this={replyInput} name="text" rows="5" maxlength="65536" required value={replyFailure.text??''}></textarea></label>
            <p class="m-0 text-xs text-muted">Only this person will receive your reply.</p>
            <div class="flex gap-3"><button class="hail-button" disabled={sending}>Send reply</button><button class="hail-button-secondary" type="button" disabled={sending} onclick={()=>replyOpen=false}>Cancel</button></div>
          </form>
        {/if}
      </div>
    {:else}
      <MessageListRow inline isRead={row.isRead} timestamp={row.createdAt} title={row.title===conversationSubject?'':row.title} preview={row.preview} onclick={()=>open(row)} expanded={false}>
        {#snippet leading()}<SelectionAvatar name={row.sent?'You':row.senderAddress??row.sender} avatar={data.avatars[row.sender]} />{/snippet}
        {#snippet sender()}{#if row.sent}You{:else}<ContactAddress owner={data.account.did} did={row.sender} address={row.senderAddress} />{/if}{/snippet}
      </MessageListRow>
    {/if}
  </div>
{/each}
</section>
{#if start+rows.length<total}<button class="hail-button-secondary mt-4" disabled={paging} onclick={()=>more(false)}>Older messages ↓</button>{/if}
<style>
  .newer-edge { min-height:32px; margin-bottom:12px; font-size:12px; color:var(--color-muted); }
  .conversation-item { scroll-margin-top:90px; border-bottom:1px solid var(--color-line); }
  .expanded { background:var(--color-surface); }
  .expanded-body { max-width:800px; margin:0; padding:12px 12px 32px; }
  .expanded-header { display:grid; grid-template-columns:40px minmax(0,1fr) auto; align-items:start; gap:8px 16px; padding:24px 12px 8px; }
  .conversation-subject { margin:0 0 24px; overflow-wrap:anywhere; }
  .different-subject { margin:20px 12px 0; font-size:18px; font-weight:600; overflow-wrap:anywhere; }
  .expanded-header:focus { outline:none; }
  .expanded-date { grid-column:3; grid-row:1; justify-self:end; padding-top:3px; white-space:nowrap; font-size:12px; color:var(--color-muted); }
  .sender-avatar { grid-column:1; grid-row:1 / 3; }
  .sender-identity { grid-column:2; grid-row:1 / 3; min-width:0; overflow-wrap:anywhere; }
  .sender-address { font-size:14px; font-weight:550; line-height:1.5; margin-bottom:3px; }
  .sender-address :global(.address) { white-space:normal; overflow-wrap:anywhere; }
  .recipients { margin:6px 0 0; font-size:12px; color:var(--color-muted); }
  .message-tools { grid-column:3; grid-row:2; display:flex; gap:4px; align-items:center; flex-wrap:wrap; }

  .reading-body { min-height:0; margin-inline:0; padding:20px 0; }
  .reply-form { display:grid; gap:16px; margin-top:24px; }
  @media(max-width:640px){
    .expanded-header { grid-template-columns:44px minmax(0,1fr) auto; gap:12px 10px; padding:20px 0 0; }
    .expanded-date { font-size:11px; padding-top:4px; }
    .sender-identity { grid-column:2; grid-row:1; }
    .message-tools { grid-column:2 / -1; grid-row:2; }
    .expanded-body { padding:0 0 24px; }
  }
</style>
