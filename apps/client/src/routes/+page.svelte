<script lang="ts">
  import MessageListRow from "$lib/MessageListRow.svelte";
  import ContactAddress from "$lib/ContactAddress.svelte";
  import SelectionAvatar from "$lib/SelectionAvatar.svelte";
  import MessageActions from "$lib/MessageActions.svelte";
  import {afterNavigate} from "$app/navigation";
  import {onMount} from "svelte";
  import PasskeySignIn from "$lib/PasskeySignIn.svelte";
  import Icon from "$lib/Icon.svelte";
  import {showInboxHeaders, loadHeaderPreference} from "$lib/preferences.js";
  let {data} = $props();
  let localDates = $state(false);
  const date = (value: string) => !localDates ? value : new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(new Date(value));
  onMount(() => { localDates = true; loadHeaderPreference(); });
  const messageKey = (message: {sender: string; messageId: string}) => JSON.stringify([message.sender, message.messageId]);
  let selected = $state<string[]>([]);
  let selectionLocked = $state(false);
  let selectedMessages = $derived((data.messages ?? []).filter(message => selected.includes(messageKey(message))));
  afterNavigate(() => { selected = []; });
  $effect(() => { if (!selectedMessages.length) selectionLocked = false; });
  function toggle(message: {sender: string; messageId: string}) {
    const key = messageKey(message);
    selected = selected.includes(key) ? selected.filter(value => value !== key) : [...selected, key];
  }
</script>

<svelte:head><title>{!data.configured ? 'Welcome' : data.view === 'connections' ? 'Messages' : 'Inbox'} · Haili</title></svelte:head>

{#if !data.configured}
  <section class="welcome">
    <div class="welcome-copy">
      <h1>Your inbox.<br /><span>Your permission.</span></h1>
      <p class="welcome-description">Messages from people you choose. Updates on topics you want. With Haili, someone knowing your address isn’t enough to reach your inbox.</p>
      <div class="welcome-signin"><PasskeySignIn returnTo={data.returnTo} />{#if data.registration?.signupAvailable&&data.registration.mode==="public"}<p><a href="/signup">Create an account</a></p>{:else}<p>Already have an invitation? Use your signup link.</p>{/if}</div>
    </div>
    <aside class="subscription-example" aria-labelledby="subscription-example-title">
      <h2 id="subscription-example-title">A little more selective.</h2>
      <p>A newsletter offers two topics.<br />You decide which ones reach you.</p>
      <ul class="example-topics">
        <li><span>Weekly essays</span><span class="topic-status">Subscribed</span></li>
        <li><span>Event announcements</span><span class="topic-status topic-off">Not subscribed</span></li>
      </ul>
      <p class="example-caption">Example categories. Each topic needs your permission.</p>
    </aside>
  </section>
  <section class="welcome-benefits" aria-label="Why use Haili">
    <div><h2>Permission comes first.</h2><p>Senders need your approval before they can deliver messages. Having your address doesn’t give them a way in.</p></div>
    <div><h2>Choose the topics. Not just the sender.</h2><p>Subscribe to the categories a sender offers; so saying yes to one kind of update doesn’t mean saying yes to all of them.</p></div>
    <div><h2>Your yes isn’t forever.</h2><p>Revoke a sender’s permission to stop new messages under it. You don’t have to wait for the sender to remove you.</p></div>
  </section>
  <p class="welcome-footer">Built on Hail, an open messaging protocol. Haili is currently an invitation-only alpha.</p>
{:else}
  <header class="feed-heading">
    <div><h1 class="hail-title">{data.view === 'connections' ? 'Messages' : 'Inbox'}</h1><p class="feed-description">{data.view === 'connections' ? 'The latest from your connections' : 'The latest from your subscriptions'}</p></div>
    {#if data.view === 'connections'}<a class="hail-button-secondary" href="/compose?audience=connections"><Icon name="plus" size={18} />New message</a>{/if}
  </header>
  <div class="feed-layout" class:has-selection={selectedMessages.length > 0}><div class="min-w-0">
  {#if selectedMessages.length}
    <MessageActions messages={selectedMessages} bind:locked={selectionLocked} onclear={() => selected = []} onremoved={removed => { selected = selected.filter(key => !removed.some(message => messageKey(message) === key)); }} />
  {/if}
  <section class:compact-list={data.messages.length > 0} aria-label="Messages">

    {#if data.messages.length === 0}
      <div class="hail-card flex flex-col items-center gap-3 px-6 py-16 text-center"><span class="empty-symbol" aria-hidden="true"><Icon name={data.view === 'connections' ? 'chat' : 'feed'} size={30} /></span><h2 class="m-0 text-xl tracking-tight">No messages yet</h2><p class="m-0 max-w-sm text-sm text-muted">{data.view==='connections'?'Reach out and say "hello".':'All quiet here.'}</p>{#if data.view !== 'connections'}<a class="hail-button-secondary mt-2" href="/permissions">Find your first sender <span aria-hidden="true">→</span></a>{/if}</div>
    {:else}
      {#each data.messages as message (message.sender+message.messageId)}
        <MessageListRow timestamp={message.deliveredAt} title={message.title} preview={message.preview} header={$showInboxHeaders ? message.header : null} selected={selected.includes(messageKey(message))}
          href={`/message/${encodeURIComponent(message.sender)}/${message.messageId}${message.kind==='connection'?'?view=connections':''}`}>
          {#snippet leading()}<SelectionAvatar name={message.senderAddress??message.sender} avatar={message.avatar} selected={selected.includes(messageKey(message))} disabled={selectionLocked} label={`Select message from ${message.senderAddress??message.sender}, ${date(message.deliveredAt)}`} ontoggle={()=>toggle(message)} />{/snippet}
          {#snippet sender()}<ContactAddress owner={data.account.did} did={message.sender} address={message.senderAddress} />{/snippet}
        </MessageListRow>
      {/each}
    {/if}
  </section>
  {#if data.paged||data.next}<nav aria-label={data.view === 'connections' ? 'Messages pages' : 'Inbox pages'} class="mt-6 flex flex-wrap justify-center gap-3">{#if data.paged}<a class="hail-button-secondary" href={data.view==='connections'?'/?view=connections':'/'}>← Newest messages</a>{/if}{#if data.next}<a class="hail-button-secondary" href={`/?${data.view==='connections'?'view=connections&':''}after=${encodeURIComponent(data.next)}`}>Older messages →</a>{/if}</nav>{/if}
  </div><aside class="feed-aside"><div class="aside-heading"><Icon name="shield" size={18} /><span>On your terms</span></div><h2>{data.view === 'connections' ? 'Good conversations start here.' : 'An inbox with intention.'}</h2><p>{data.view === 'connections' ? 'Share your connection code to invite someone into your space.' : 'Choose who can reach you and what they can send.'}</p><a href={data.view === 'connections' ? '/connections' : '/permissions'}>{data.view === 'connections' ? 'Your connection codes' : 'Your subscriptions'}<Icon name="arrow" size={16} /></a></aside></div>
{/if}

<style>
  @media(max-width:900px) { .has-selection { padding-bottom:180px; } }

  .welcome { display:grid; grid-template-columns:1.1fr 1fr; align-items:center; gap:48px; padding:28px 0 48px; }
  .welcome-copy h1 { margin:0 0 22px; font-size:clamp(42px,5.3vw,66px); line-height:1.08; letter-spacing:-.055em; font-weight:650; }
  .welcome-copy h1 span { color:var(--color-brand); }
  .welcome-description { font-size:16px; color:var(--color-muted); line-height:1.9; margin:0; }
  .welcome-signin { margin-top:32px; max-width:340px; }
  .welcome-signin > p { font-size:11px; color:var(--color-muted); margin:13px 0 0; }
  .subscription-example { min-width:0; padding:28px; border:1px solid var(--color-line); border-radius:18px; background:var(--color-surface); box-shadow:0 8px 25px #172b2d06; }
  .subscription-example h2 { margin:0 0 10px; font-size:26px; line-height:1.25; letter-spacing:-.035em; font-weight:600; }
  .subscription-example p { font-size:14px; color:var(--color-muted); line-height:1.7; margin:0 0 20px; }
  .example-topics { list-style:none; margin:0; padding:0; }
  .example-topics li { display:flex; justify-content:space-between; align-items:center; gap:12px; border-top:1px solid var(--color-line); padding:17px 0; font-size:14px; }
  .topic-status { flex-shrink:0; padding:5px 10px; border-radius:99px; font-size:11px; background:var(--color-brand-soft); color:var(--color-brand-strong); }
  .topic-off { background:var(--color-canvas); color:var(--color-muted); }
  .subscription-example .example-caption { border-top:1px solid var(--color-line); padding-top:16px; margin:0; font-size:11px; }
  .welcome-benefits { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:32px; padding-top:32px; border-top:1px solid var(--color-line); }
  .welcome-benefits h2 { font-size:19px; line-height:1.4; letter-spacing:-.025em; font-weight:600; margin:0 0 12px; }
  .welcome-benefits p { margin:0; font-size:14px; line-height:1.8; color:var(--color-muted); }
  .welcome-footer { margin:32px 0 0; padding-top:20px; border-top:1px solid var(--color-line); color:var(--color-muted); font-size:12px; line-height:1.7; }
  .feed-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:20px; margin-bottom:32px; }
  .feed-description { margin:12px 0 0; font-size:14px; color:var(--color-muted); }
  .feed-layout { display:grid; grid-template-columns:minmax(0,1fr) 218px; gap:32px; align-items:start; }
  .feed-aside { margin-top:0; padding:24px 0 24px 24px; border-left:1px solid var(--color-line); }
  .aside-heading { display:flex; align-items:center; gap:7px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--color-brand); }
  .feed-aside h2 { font-size:21px; line-height:1.4; letter-spacing:-.03em; margin:18px 0 12px; font-weight:600; }
  .feed-aside p { font-size:12px; line-height:1.8; color:var(--color-muted); margin:0 0 20px; }
  .feed-aside a { display:flex; align-items:center; gap:7px; min-height:44px; font-size:11px; font-weight:650; color:var(--color-brand-strong); text-decoration:none; }
  .feed-aside a:hover { text-decoration:underline; }
  .empty-symbol { display:grid; place-items:center; width:76px; height:76px; margin-bottom:14px; border:10px solid var(--color-canvas); border-radius:26px; background:var(--color-brand-soft); color:var(--color-brand); }
  @media(max-width:1200px) { .feed-layout { grid-template-columns:minmax(0,1fr); max-width:780px; margin:0 auto; } .feed-aside { display:none; } }
  @media(max-width:800px) { .welcome { gap:28px; } .subscription-example { padding:20px; } .welcome-benefits { gap:22px; } }
  @media(max-width:640px) { .welcome { grid-template-columns:1fr; padding:10px 0 32px; gap:32px; } .welcome-copy h1 { font-size:clamp(38px, 12vw, 48px); } .welcome-description { font-size:14px; } .welcome-signin { max-width:none; margin-top:26px; } .welcome-benefits { grid-template-columns:1fr; gap:24px; } .example-topics li { font-size:12px; gap:8px; } .topic-status { font-size:10px; padding:5px 8px; } .feed-heading { gap:16px; margin-bottom:20px; } }
</style>
