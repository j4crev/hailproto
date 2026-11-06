<script lang="ts">
  import Attachments from "$lib/Attachments.svelte";
  import MessageBack from "$lib/MessageBack.svelte";
  import {page} from "$app/state";
  import {tick} from 'svelte';
  import {invalidate,invalidateAll} from '$app/navigation';
  import {connectionRequest} from '$lib/connections.js';
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
  let replyAll=$state(false),membershipSaving=$state(false);
  let revival=$state<{operationId:string;targets:{recipient:string;outcome:string}[]}|null>(null);
  async function revive(){
    const shared=message?.sharedConversation;if(!shared?.canRevive||shared.state!=='expired')return;
    membershipSaving=true;error='';
    try{revival=await connectionRequest('conversation-revive',{operationId:revival?.operationId??data.newRevivalId,conversationId:shared.conversationId});await invalidateAll();}
    catch(e){error=e instanceof Error?e.message:'Unable to revive this conversation.';}
    finally{membershipSaving=false;}
  }
  let openedConversation='';
  $effect(()=>{
    const shared=data.message.sharedConversation,key=shared?shared.creator+'/'+shared.conversationId:'';
    if(key&&key!==openedConversation){revival=null;openedConversation=key;void recordOpen(data.message);}
  });
  async function recordOpen(value:MessageView|SentMessageView){
    const s=value.sharedConversation;if(!s||s.state!=='active')return;
    try{await connectionRequest('conversation-membership',{action:'open',creator:s.creator,conversationId:s.conversationId});}
    catch{error='Unable to record conversation activity. Reopen it to try again.';}
  }
  async function membership(action:'leave'|'rejoin'){
    const s=message?.sharedConversation;if(!s)return;
    membershipSaving=true;error='';
    try{await connectionRequest('conversation-membership',{action,creator:s.creator,conversationId:s.conversationId});await invalidateAll();}
    catch(e){error=e instanceof Error?e.message:'Unable to change participation.';}
    finally{membershipSaving=false;}
  }
  const conversationActions=$derived.by(()=>{
    const shared=message?.sharedConversation;if(!shared)return [];
    const actions=[];
    if(shared.state==='active')actions.push({label:'Leave conversation',icon:'logout',run:()=>{void membership('leave');}});
    if(shared.state==='left')actions.push({label:'Rejoin conversation',icon:'plus',run:()=>{void membership('rejoin');}});
    if(shared.canRevive&&shared.state==='expired')actions.push({label:'Revive expired participation',icon:'chat',run:()=>{void revive();}});
    return actions;
  });
  let request=0;
  // Layout-only mailbox refreshes replace data without reloading this thread.
  // Keep those updates from resetting local selection/pagination or marking read again.
  const loadedThread=$derived(data.thread),loadedMessage=$derived(data.message);
  $effect(()=>{
    request++;pagingError=false;
    rows=loadedThread.messages.map(m=>({...m}));start=loadedThread.start;total=loadedThread.total;newerUnread=loadedThread.newerUnread;
    selected=conversationKey(loadedThread.selected);message=loadedMessage;replyOpen=false;
    void markRead(loadedThread.selected,loadedMessage);
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
      await recordOpen(value);
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
  const content=$derived(message?messageDisplayContent(message.blocks):null);
  async function reply(all=false){replyAll=all;replyOpen=true;await tick();replyInput?.focus();}
</script>
<svelte:head><title>{conversationSubject || 'Messages'} · {page.data.branding?.name ?? "Hail"}</title></svelte:head>
<MessageBack href="/?view=connections" label="Inbox" />
<h1 class="hail-title conversation-subject" class:sr-only={!conversationSubject}>{conversationSubject || 'Messages'}</h1>
{#if error}<p class="hail-error" role="alert">{error}</p>{/if}
{#if replyFailure.error}<p class="hail-error" role="alert">{replyFailure.error}</p>{/if}
{#if pending}<p class="text-sm text-muted" role="status">Opening message…</p>{/if}
{#if start>0}<div class="newer-edge min-h-[32px] mb-[12px] text-[12px] text-muted" bind:this={newerEdge}>
  {#if pagingError}<button class="hail-button-secondary" disabled={paging} onclick={()=>more(true)}>Retry loading newer messages</button>
  {:else}<span role="status">{paging?'Loading newer messages…':newerUnread?`↑ ${newerUnread} unread above`:'↑ Newer messages above'}</span>{/if}
</div>{/if}
<section aria-label="Conversation messages" aria-busy={pending}>
{#each rows as row (conversationKey(row))}
  {@const expanded=conversationKey(row)===selected}
  <div class="conversation-item scroll-mt-[90px] [border-bottom:1px_solid_var(--color-line)]" class:expanded id={'row-'+row.messageId}>
    {#if expanded && message && content}
      {#if content.title && content.title!==conversationSubject}<h2 class="different-subject [margin:20px_12px_0] text-[18px] font-[600] [overflow-wrap:anywhere]">{content.title}</h2>{/if}
      <header class="expanded-header" tabindex="-1" aria-label={row.sent?'Message from you':`Message from ${row.senderAddress??row.sender}`}>
        <span class="expanded-date"><DateTime format="list" value={row.createdAt} /></span>
        <div class="sender-avatar [grid-column:1] [grid-row:1_/_3]"><SelectionAvatar name={row.sent?'You':row.senderAddress??row.sender} avatar={data.avatars[row.sender]} /></div>
        <div class="sender-identity">
          <div class="sender-address">{#if row.sent}You{:else}<ContactAddress owner={data.account.did} did={row.sender} address={row.senderAddress} />{/if}</div>
          {#if row.sent || row.senderAddress}<IdentityDetails did={row.sender} />{/if}
          {#if row.sent && !message.sharedConversation}<p class="recipients [margin:6px_0_0] text-[12px] text-muted">To {row.recipients.map(r=>r.address??r.did).join(', ')}</p>{/if}
        </div>
        <div class="message-tools mobile-message-actions [grid-column:3] [grid-row:2] flex gap-[4px] items-center flex-wrap" role="group" aria-label="Message actions">

            {#if message.sharedConversation}<button class="hail-icon-button compact" title="Reply all" aria-label="Reply all" aria-expanded={replyOpen&&replyAll} disabled={message.sharedConversation.state!=='active'||sending} onclick={()=>reply(true)}><Icon name="reply-all"/></button>{/if}
            {#if !row.sent}
              <button class="hail-icon-button compact" title="Reply privately" aria-label="Reply privately" disabled={!message.connection?.active||sending} aria-expanded={replyOpen&&!replyAll} onclick={()=>reply(false)}><Icon name="reply" /></button>
              <a class="hail-icon-button compact" title="Forward" aria-label="Forward" href={forwardHref(message as MessageView)}><Icon name="forward" /></a>
              <MessageActions compact menu disabled={readPending||sending||membershipSaving} extraActions={conversationActions} messages={[message]} returnTo="/?view=connections" />
            {:else}<a class="text-xs text-muted" href={`/sent/${row.messageId}`}>Delivery details</a>{#if message.sharedConversation}<MessageActions compact menu disabled={sending||membershipSaving} messages={[]} extraActions={conversationActions}/>{/if}{/if}
        </div>
        <details class="message-details"><summary>Details</summary>
          <div class="detail-row">
            <Icon name="calendar" size={14} />
            <span><span class="sr-only">{row.sent?'Sent':'Received'}: </span><DateTime format="detailed" value={'deliveredAt' in message?message.deliveredAt:message.createdAt} /></span>
          </div>
          {#if message.sharedConversation}
            {@const shared=message.sharedConversation}
            <div class="detail-row">
              <Icon name="user" size={14} />
              <ul aria-label="Participants">{#each shared.participants as did}<li>{#if did===data.account.did}You{:else}<ContactAddress owner={data.account.did} {did} address={shared.participantAddresses?.[did]??null}/>{/if}</li>{/each}</ul>
            </div>
          {/if}
        </details>
      </header>
      <div class="expanded-body">
        {#if message.sharedConversation?.state==='left'}<p class="text-sm text-muted">You left this conversation. Saved messages remain readable.</p>
        {:else if message.sharedConversation?.state==='expired'}<p class="text-sm text-muted">Your participation expired through inactivity.</p>{/if}
        {#if revival}<ul class="text-sm" aria-label="Revival status">{#each revival.targets as target}<li class="break-words">{message.sharedConversation?.participantAddresses?.[target.recipient]??target.recipient}: {target.outcome}</li>{/each}</ul>{/if}
        <div class="reading-body"><QuotedMessage blocks={content.blocks} header={message.header} /><Attachments files={message.attachments} sender={message.sender} messageId={message.messageId} /></div>
        {#if !row.sent && !message.connection?.active}<p class="text-sm text-muted">{message.sharedConversation?'Private replies require a connection to this person.':'This connection is no longer active. Saved messages remain readable.'}</p>{/if}
        {#if replyOpen && (replyAll?message.sharedConversation?.state==='active':!row.sent&&message.connection?.active)}
          <form class="reply-form grid gap-[16px] mt-[24px]" enctype="multipart/form-data" method="POST" action={`/message/${encodeURIComponent(row.sender)}/${row.messageId}?/${replyAll?'replyAll':'reply'}`} use:enhance={()=>{sending=true;return async({result})=>{sending=false;if(result.type==='failure')replyFailure=result.data??{};else await applyAction(result);};}}>
            <input type="hidden" name="messageId" value={replyFailure.messageId??data.newReplyId} />
            <label class="hail-field">{replyAll?'Reply to everyone':'Reply to '+(row.senderAddress??row.sender)}<textarea bind:this={replyInput} name="text" rows="5" maxlength="65536" required value={replyFailure.text??''}></textarea></label>
    <label class="hail-field">Attachments (PNG, JPEG, WebP, PDF, TXT, LOG · 25 MiB total)<input type="file" name="attachment" accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.log" multiple /></label>
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
<style lang="postcss">
  @reference "../../../../app.css";

  .expanded { @apply [background:var(--color-surface)]; }
  .expanded-body { @apply max-w-[800px] m-0 [padding:8px_12px_32px]; }
  .expanded-header { @apply grid [grid-template-columns:40px_minmax(0,1fr)_auto] [align-items:start] [gap:4px_16px] [padding:20px_12px_4px]; }
  .conversation-subject { @apply [margin:0_0_24px] [overflow-wrap:anywhere]; }
  .expanded-header:focus { @apply [outline:none]; }
  .expanded-date { @apply [grid-column:3] [grid-row:1] [justify-self:end] pt-[3px] whitespace-nowrap text-[12px] text-muted; }
  .sender-identity { @apply [grid-column:2] [grid-row:1_/_3] min-w-0 [overflow-wrap:anywhere]; }
  .sender-address { @apply text-[14px] font-[550] leading-[1.5] mb-[3px]; }
  .sender-address :global(.address) { @apply whitespace-normal [overflow-wrap:anywhere]; }
  .message-details { @apply [grid-column:2_/_-1] [grid-row:3] min-w-0 [overflow-wrap:anywhere] m-0 text-[12px] text-muted; }
  .message-details summary { @apply cursor-pointer w-[fit-content]; }
  .detail-row { @apply grid [grid-template-columns:14px_minmax(0,1fr)] [align-items:start] gap-[8px] mt-[8px]; }
  .detail-row :global(svg) { @apply mt-[2px]; }
  .detail-row ul { @apply [list-style:none] p-0 m-0 grid gap-[6px]; }
  .reading-body { @apply min-h-0 mx-0 [padding:12px_0]; }
  @media (max-width:640px) {
    .expanded-header { @apply [grid-template-columns:44px_minmax(0,1fr)_auto] [gap:4px_10px] [padding:12px_0_0]; }
    .conversation-subject { @apply mb-[16px]; }
    .expanded-date { @apply text-[11px] pt-[4px]; }
    .sender-identity { @apply [grid-column:2] [grid-row:1]; }
    .expanded-body { @apply [padding:0_0_24px]; }
  }
</style>
