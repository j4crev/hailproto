<script lang="ts">
  import { onMount } from "svelte";
  let { data } = $props();
  let showHeaders = $state(true);
  let preferencesReady = $state(false);
  const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  onMount(() => {
    try { showHeaders = localStorage.getItem("hail.gui.showInboxHeaders") !== "false"; }
    catch { /* A blocked display preference must not prevent reading messages. */ }
    preferencesReady = true;
  });
  function toggleHeaders(event: Event) {
    showHeaders = (event.currentTarget as HTMLInputElement).checked;
    try { localStorage.setItem("hail.gui.showInboxHeaders", String(showHeaders)); }
    catch { /* Keep the choice for this page when browser storage is blocked. */ }
  }
</script>

<svelte:head><title>{data.configured&&data.view==='connections'?'Conversations':'Feed'} · Haili</title></svelte:head>

{#if !data.configured}
  <section class="hail-card mx-auto mt-8 flex max-w-[620px] flex-col items-start gap-5 p-8 sm:p-12">
    <p class="m-0 text-xs font-bold tracking-[.12em] text-brand uppercase">Welcome to Haili</p>
    <h1 class="m-0 text-[clamp(30px,5vw,46px)] leading-tight tracking-[-.04em]">A little more signal.<br />A lot more say.</h1>
    <p class="m-0 leading-relaxed text-muted">Your subscriptions and messages, from senders you choose. Sign in to open your inbox.</p>
    <a class="hail-button" href="/auth/login">Sign in with a passkey <span aria-hidden="true">→</span></a>
    <p class="m-0 text-xs text-muted">Haili is currently an invitation-only alpha.</p>
  </section>
{:else}
  <section class="mb-8 flex flex-wrap items-start justify-between gap-4">
    <div>
      <p class="m-0 mb-2 text-xs font-bold tracking-[.12em] text-brand uppercase">Your inbox</p>
      <h1 class="m-0 text-[clamp(30px,5vw,40px)] leading-tight tracking-[-.035em]">{data.view==='connections'?'Conversations':'The latest, on your terms.'}</h1>
      <p class="m-0 mt-3 text-sm text-muted [overflow-wrap:anywhere]">{data.account.address}</p>
      <details class="mt-2 text-xs text-muted"><summary class="cursor-pointer py-1">Account details</summary><dl class="grid gap-2"><div><dt class="font-bold">Identity</dt><dd class="m-0 mt-1 font-mono [overflow-wrap:anywhere]">{data.account.did}</dd></div><div><dt class="font-bold">Key custody</dt><dd class="m-0 mt-1">{data.account.custodyProfile}</dd></div></dl><a class="inline-block py-2 font-bold text-brand underline-offset-4" href="/settings/security">Manage passkeys →</a></details>
    </div>
    <div class="flex flex-wrap gap-2">{#if data.view==='connections'}<a class="hail-button" href="/compose?audience=connections">Message connections</a>{/if}<form method="POST" action="/auth/logout"><button class="hail-button-secondary">Sign out</button></form></div>
  </section>

  <section class="mb-5 flex flex-wrap items-center justify-between gap-3 border-0 border-b border-solid border-line pb-4" aria-label="Inbox preferences">
    <div class="flex flex-col gap-1"><strong class="text-sm">{data.view==='connections'?'Connection messages':'Message feed'}</strong><small class="text-xs text-muted">Bundled images never contact the sender.</small></div>
    <label class="flex min-h-11 cursor-pointer items-center gap-2 text-xs font-semibold text-muted"><input class="size-4 accent-brand" type="checkbox" checked={showHeaders} onchange={toggleHeaders} disabled={!preferencesReady} /> Show headers</label>
  </section>

  <section class="grid gap-5" aria-label="Messages">
    {#if data.messages.length === 0}
      <div class="hail-card flex flex-col items-center gap-3 px-6 py-14 text-center"><span class="grid size-12 place-items-center rounded-2xl bg-brand-soft text-2xl text-brand" aria-hidden="true">↓</span><h2 class="m-0 text-xl tracking-tight">No messages yet</h2><p class="m-0 max-w-sm text-sm text-muted">{data.view==='connections'?'Personal messages from your connections will appear here, separate from subscription updates.':'Choose a sender and the updates you want to receive. Their delivered messages will appear here.'}</p><a class="hail-button-secondary mt-2" href={data.view==='connections'?'/compose?audience=connections':'/permissions'}>{data.view==='connections'?'Message a connection':'Review a sender'} <span aria-hidden="true">→</span></a></div>
    {:else}
      {#each data.messages as message}
        <a class="hail-card flex min-w-0 flex-col overflow-hidden no-underline transition-[border-color,box-shadow] duration-150 hover:border-brand hover:shadow-md" href={`/message/${encodeURIComponent(message.sender)}/${message.messageId}${message.kind==='connection'?'?view=connections':''}`}>
          <span class="flex items-center gap-3 px-[18px] py-4">
            {#if message.avatar}<img class="grid size-[42px] flex-[0_0_42px] place-items-center rounded-[13px] object-cover" src={message.avatar.src} alt="" width={message.avatar.width} height={message.avatar.height} />
              {:else}<span class="grid size-[42px] flex-[0_0_42px] place-items-center rounded-[13px] bg-brand-soft text-[12px] font-extrabold text-brand" aria-hidden="true">{(message.senderAddress ?? message.sender).slice(0, 2).toUpperCase()}</span>{/if}
            <span class="flex min-w-0 flex-1 flex-col gap-[3px]"><strong class="truncate text-[14px]">{message.senderAddress ?? message.sender}</strong>{#if message.senderAddress}<small class="truncate font-mono text-[11px] text-muted">{message.sender}</small>{/if}<time class="text-[11px] text-muted" datetime={message.deliveredAt}>{date(message.deliveredAt)}</time></span>
          </span>
          {#if showHeaders && message.header}
            <img class="block h-auto max-h-[320px] w-full border-0 border-y border-solid border-line object-cover" src={message.header.src} alt={message.header.alt} width={message.header.width} height={message.header.height} />
          {/if}
          <span class="px-[18px] pt-4 pb-[18px] font-serif text-[17px] leading-relaxed text-ink [overflow-wrap:anywhere]">{message.preview}</span>
        </a>
      {/each}
    {/if}
  </section>
  {#if data.paged||data.next}<nav aria-label="Feed pages" class="mt-6 flex flex-wrap justify-center gap-3">{#if data.paged}<a class="hail-button-secondary" href={data.view==='connections'?'/?view=connections':'/'}>← Newest messages</a>{/if}{#if data.next}<a class="hail-button-secondary" href={`/?${data.view==='connections'?'view=connections&':''}after=${encodeURIComponent(data.next)}`}>Older messages →</a>{/if}</nav>{/if}
{/if}
