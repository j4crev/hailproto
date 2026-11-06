<script lang="ts">
  import {page} from "$app/state";
  import MailboxEmptyState from "$lib/MailboxEmptyState.svelte";
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
  let selectedMessages = $derived((data.messages ?? []).filter(message => selected.includes(messageKey(message))).flatMap(message=>message.conversation?.messages??[{sender:message.sender,messageId:message.messageId,isRead:message.isRead===true}]));
  afterNavigate(() => { selected = []; });
  $effect(() => { if (!selectedMessages.length) selectionLocked = false; });
  function toggle(message: {sender: string; messageId: string}) {
    const key = messageKey(message);
    selected = selected.includes(key) ? selected.filter(value => value !== key) : [...selected, key];
  }
</script>

<svelte:head><title>{!data.configured ? 'Welcome' : data.view === 'connections' ? 'Inbox' : 'Feed'} · {page.data.branding?.name ?? "Hail"}</title></svelte:head>

{#if !data.configured}
  <section class="welcome">
    <div class="welcome-copy">
      <h1>Your inbox.<br /><span>Your permission.</span></h1>
      <p class="welcome-description">This isn't email or SMS. {page.data.branding?.name ?? "Hail"} is a place for beautiful content you choose to receive, with permission built in. Unsubscribe on your terms, not the sender's. And since it's opt-in content, anything you send gets delivered - no fear of it being filtered out or sent to spam.</p>
      <p class="welcome-description welcome-invitation">Will you join us?</p>
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
  <section class="welcome-benefits" aria-label={`Why use ${page.data.branding?.name ?? "Hail"}`}>
    <div><h2>Permission comes first.</h2><p>Senders need your approval before they can deliver messages. Having your address doesn’t give them a way in.</p></div>
    <div><h2>Choose the topics. Not just the sender.</h2><p>Subscribe to the categories a sender offers; so saying yes to one kind of update doesn’t mean saying yes to all of them.</p></div>
    <div><h2>Your yes isn’t forever.</h2><p>Revoke a sender’s permission to stop new messages under it. You don’t have to wait for the sender to remove you.</p></div>
  </section>
  <footer class="welcome-footer">
    <p>Built on RACR, an open messaging protocol.{#if data.registration?.mode === "invite"} {page.data.branding?.name ?? "Hail"} is currently an invitation-only alpha.{/if}</p>
    <a class="welcome-github" href="https://github.com/j4crev/hail" aria-label="Hail on GitHub" title="Hail on GitHub">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.807 1.305 3.492.998.108-.776.418-1.305.762-1.605-2.665-.3-5.467-1.334-5.467-5.93 0-1.31.467-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23a11.5 11.5 0 0 1 3-.405c1.02.005 2.045.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>
    </a>
  </footer>
{:else}
  <header class="feed-heading">
    <div><h1 class="hail-title">{data.view === 'connections' ? 'Inbox' : 'Feed'}</h1><p class="feed-description [margin:6px_0_0] text-[14px] text-muted">{data.view === 'connections' ? 'The latest from your connections' : 'The latest from your subscriptions'}</p></div>
  </header>
  <div class="feed-layout" class:has-selection={selectedMessages.length > 0}>
  {#if selectedMessages.length}
    <MessageActions messages={selectedMessages} bind:locked={selectionLocked} onclear={() => selected = []} onremoved={removed => { selected = selected.filter(key => !removed.some(message => messageKey(message) === key)); }} />
  {/if}
  <section class:compact-list={data.messages.length > 0} aria-label="Messages">

    {#if data.messages.length === 0}
      <MailboxEmptyState icon={data.view === 'connections' ? 'chat' : 'feed'} title={data.view === 'connections' ? 'Delivery late?' : 'Horse eat it?'} />
    {:else}
      {#each data.messages as message (message.sender+message.messageId)}
        <MessageListRow unreadCount={message.conversation?.unreadCount} inline={data.view === "connections"} imageLayout={data.view === "connections" ? "thumbnail" : "feature"} isRead={message.isRead} timestamp={message.deliveredAt} title={message.title} preview={message.preview} header={$showInboxHeaders ? message.header : null} selected={selected.includes(messageKey(message))}
          href={`/${data.view==='connections'?'conversation':'message'}/${encodeURIComponent(message.sender)}/${message.messageId}`}>
          {#snippet leading()}<SelectionAvatar name={message.sender===data.account.did?'You':message.senderAddress??message.sender} avatar={message.avatar} selected={selected.includes(messageKey(message))} disabled={selectionLocked} label={`Select ${data.view==='connections'?'conversation with':'message from'} ${message.senderAddress??message.sender}, ${date(message.deliveredAt)}`} ontoggle={()=>toggle(message)} />{/snippet}
          {#snippet sender()}{#if message.sender===data.account.did}You{:else}<ContactAddress owner={data.account.did} did={message.sender} address={message.senderAddress} />{/if}{/snippet}
        </MessageListRow>
      {/each}
    {/if}
  </section>
  {#if data.paged||data.next}<nav aria-label={data.view === 'connections' ? 'Inbox pages' : 'Feed pages'} class="mt-6 flex flex-wrap justify-center gap-3">{#if data.paged}<a class="hail-button-secondary" href={data.view==='connections'?'/?view=connections':'/?view=subscriptions'}>← Newest messages</a>{/if}{#if data.next}<a class="hail-button-secondary" href={`/?${data.view==='connections'?'view=connections&':'view=subscriptions&'}after=${encodeURIComponent(data.next)}`}>Older messages →</a>{/if}</nav>{/if}
  </div>
  {#if !selectedMessages.length}
    <a class="mobile-compose mobile-floating-action" href={data.view==='connections'?'/compose?audience=connections':'/compose'} aria-label={data.view==='connections'?'Message connections':'Publish to subscribers'} title={data.view==='connections'?'Message connections':'Publish to subscribers'}><Icon name="compose" size={24} /></a>
  {/if}
{/if}

<style lang="postcss">
  @reference "../app.css";

  @media (max-width:900px) {
    .feed-layout { @apply pb-[88px]; }
    .has-selection { @apply pb-[180px]; }
  }
  .welcome { @apply grid [grid-template-columns:1.1fr_1fr] items-center gap-[48px] [padding:28px_0_48px]; }
  .welcome-copy h1 { @apply [margin:0_0_22px] text-[clamp(42px,5.3vw,66px)] leading-[1.08] tracking-[-.055em] font-[650]; }
  .welcome-copy h1 span { @apply text-brand; }
  .welcome-description { @apply text-[16px] text-muted leading-[1.9] m-0; }
  .welcome-invitation { @apply mt-[16px]; }
  .welcome-signin { @apply mt-[32px] max-w-[340px]; }
  .welcome-signin > p { @apply text-[11px] text-muted [margin:13px_0_0]; }
  .subscription-example {
    @apply min-w-0 p-[28px] [border:1px_solid_var(--color-line)] rounded-[18px] [background:var(--color-surface)]
      [box-shadow:0_8px_25px_#172b2d06];
  }
  .subscription-example h2 { @apply [margin:0_0_10px] text-[26px] leading-[1.25] tracking-[-.035em] font-[600]; }
  .subscription-example p { @apply text-[14px] text-muted leading-[1.7] [margin:0_0_20px]; }
  .example-topics { @apply [list-style:none] m-0 p-0; }
  .example-topics li { @apply flex justify-between items-center gap-[12px] [border-top:1px_solid_var(--color-line)] [padding:17px_0] text-[14px]; }
  .topic-status { @apply shrink-0 [padding:5px_10px] rounded-[99px] text-[11px] [background:var(--color-brand-soft)] text-brand-strong; }
  .topic-off { @apply [background:var(--color-canvas)] text-muted; }
  .subscription-example .example-caption { @apply [border-top:1px_solid_var(--color-line)] pt-[16px] m-0 text-[11px]; }
  .welcome-benefits { @apply grid grid-cols-[repeat(3,minmax(0,1fr))] gap-[32px] pt-[32px] [border-top:1px_solid_var(--color-line)]; }
  .welcome-benefits h2 { @apply text-[19px] leading-[1.4] tracking-[-.025em] font-[600] [margin:0_0_12px]; }
  .welcome-benefits p { @apply m-0 text-[14px] leading-[1.8] text-muted; }
  .welcome-footer {
    @apply flex items-center justify-between gap-[20px] [margin:32px_0_0] pt-[20px]
      [border-top:1px_solid_var(--color-line)] text-muted text-[12px] leading-[1.7];
  }
  .welcome-footer p { @apply m-0; }
  .welcome-github { @apply inline-flex items-center justify-center shrink-0 w-[44px] h-[44px] rounded-[8px] text-inherit; }
  .welcome-github:hover { @apply text-brand; }
  .welcome-github:focus-visible { @apply [outline:2px_solid_var(--color-brand)]; @apply [outline-offset:2px]; }
  .feed-heading { @apply flex items-center justify-between flex-wrap gap-[20px] mb-[24px]; }
  .feed-layout { @apply min-w-0; }
  @media (max-width:800px) {
    .welcome { @apply gap-[28px]; }
    .subscription-example { @apply p-[20px]; }
    .welcome-benefits { @apply gap-[22px]; }
  }
  @media (max-width:640px) {
    .welcome { @apply grid-cols-[1fr] [padding:10px_0_32px] gap-[32px]; }
    .welcome-copy h1 { @apply text-[clamp(38px,_12vw,_48px)]; }
    .welcome-description { @apply text-[14px]; }
    .welcome-signin { @apply [max-width:none] mt-[26px]; }
    .welcome-benefits { @apply grid-cols-[1fr] gap-[24px]; }
    .example-topics li { @apply text-[12px] gap-[8px]; }
    .topic-status { @apply text-[10px] [padding:5px_8px]; }
    .feed-heading { @apply gap-[16px] mb-[20px]; }
  }
</style>
