<script lang="ts">
  import { onMount } from "svelte";
  let { data } = $props();
  let showHeaders = $state(true);
  const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  onMount(() => { showHeaders = localStorage.getItem("hail.gui.showInboxHeaders") !== "false"; });
  function toggleHeaders(event: Event) {
    showHeaders = (event.currentTarget as HTMLInputElement).checked;
    localStorage.setItem("hail.gui.showInboxHeaders", String(showHeaders));
  }
</script>

{#if !data.configured}
  <section class="hail-card flex max-w-[620px] flex-col items-start gap-2 p-[42px] [&_p]:leading-[1.65]">
    <p class="m-0 mb-2 text-[12px] font-extrabold tracking-[.12em] text-[#22714b] uppercase">Signed out</p>
    <h1 class="m-0 mb-2 text-[clamp(28px,6vw,42px)] tracking-[-.035em]">Connect your Hail account</h1>
    <p class="text-[#657168]"><a class="inline-block rounded-[9px] bg-[#17633f] px-3.5 py-2.5 font-[750] text-white no-underline" href="/auth/login">Sign in with a passkey</a></p>
  </section>
{:else}
  <section class="mb-6 flex items-end justify-between max-[600px]:flex-col max-[600px]:items-start max-[600px]:gap-4">
    <div>
      <p class="m-0 mb-2 text-[12px] font-extrabold tracking-[.12em] text-[#22714b] uppercase">Inbox</p>
      <h1 class="m-0 text-[clamp(28px,6vw,42px)] tracking-[-.035em]">{data.account.address}</h1>
      <p class="m-0 mt-2 font-mono text-[12px] text-[#6b766f]">{data.account.did}</p>
    </div>
    <span class="rounded-[999px] bg-[#e2f1e8] px-3 py-2 text-[12px] font-bold text-[#24573c]">{data.account.custodyProfile}</span>
    <form method="POST" action="/auth/logout"><button class="cursor-pointer rounded-lg border border-solid border-[#cad4cd] bg-white px-[11px] py-2 [font:inherit] text-[12px]! font-bold! text-[#526058]">Sign out</button></form>
  </section>

  <section class="mb-3.5 flex items-center justify-between gap-[18px] max-[600px]:flex-col max-[600px]:items-start" aria-label="Inbox preferences">
    <div class="flex flex-col gap-[3px]"><strong>Message feed</strong><small class="text-[#758078]">Bundled images never contact the sender.</small></div>
    <label class="flex items-center gap-2 text-[13px] font-bold whitespace-nowrap text-[#526058]"><input class="size-[17px] accent-[#17633f]" type="checkbox" checked={showHeaders} onchange={toggleHeaders} /> Show headers</label>
  </section>

  <section class="grid gap-[18px]" aria-label="Messages">
    {#if data.messages.length === 0}
      <div class="flex flex-col items-start gap-2 p-[42px]"><strong>No messages yet</strong><span class="text-[#657168]">Delivered Hail messages will appear here.</span></div>
    {:else}
      {#each data.messages as message}
        <a class="hail-card flex flex-col overflow-hidden no-underline transition-[transform,box-shadow] duration-150 ease-[ease] hover:-translate-y-px hover:shadow-[0_14px_36px_rgba(21,50,35,.09)]" href={`/message/${encodeURIComponent(message.sender)}/${message.messageId}`}>
          <span class="flex items-center gap-3 px-[18px] py-4">
            {#if message.avatar}<img class="grid size-[42px] flex-[0_0_42px] place-items-center rounded-[13px] object-cover" src={message.avatar.src} alt="" width={message.avatar.width} height={message.avatar.height} />
            {:else}<span class="grid size-[42px] flex-[0_0_42px] place-items-center rounded-[13px] bg-[#dcece2] text-[12px] font-extrabold text-[#17633f]" aria-hidden="true">{(message.senderAddress ?? message.sender).slice(0, 2).toUpperCase()}</span>{/if}
            <span class="flex min-w-0 flex-1 flex-col gap-[3px]"><strong class="truncate text-[14px]">{message.senderAddress ?? message.sender}</strong>{#if message.senderAddress}<small class="truncate font-mono text-[11px] text-[#778179]">{message.sender}</small>{/if}<time class="text-[11px] text-[#758078]" datetime={message.deliveredAt}>{date(message.deliveredAt)}</time></span>
          </span>
          {#if showHeaders && message.header}
            <img class="block h-auto max-h-[320px] w-full border-0 border-y border-solid border-[#e4e9e5] object-cover" src={message.header.src} alt={message.header.alt} width={message.header.width} height={message.header.height} />
          {/if}
          <span class="px-[18px] pt-4 pb-[18px] font-serif text-[16px] leading-[1.5] text-[#4f5d55]">{message.preview}</span>
        </a>
      {/each}
    {/if}
  </section>
  {#if data.paged||data.next}<nav class="mt-[18px] flex justify-center gap-[22px] [&_a]:text-[13px] [&_a]:font-[750] [&_a]:text-[#286446] [&_a]:no-underline">{#if data.paged}<a href="/">← Newest messages</a>{/if}{#if data.next}<a href={`/?after=${encodeURIComponent(data.next)}`}>Older messages →</a>{/if}</nav>{/if}
{/if}
