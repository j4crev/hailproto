<script lang="ts">
  import RichText from "$lib/RichText.svelte";
  let { data,form } = $props();
  let delivered = $derived(new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(new Date(data.message.deliveredAt)));
</script>

<a class="mb-[18px] inline-block text-[14px] font-bold text-[#286446] no-underline" href="/">← Inbox</a>
<article class="hail-card overflow-hidden">
  <header class="flex items-center justify-between gap-4 border-0 border-b border-solid border-[#e7ebe8] px-6 py-5 max-[560px]:px-[18px]">
    <div class="flex min-w-0 items-center gap-3">
      {#if data.avatar}<img class="grid size-[42px] flex-[0_0_42px] place-items-center rounded-[13px] object-cover" src={data.avatar.src} alt="" width={data.avatar.width} height={data.avatar.height} />
      {:else}<span class="grid size-[42px] flex-[0_0_42px] place-items-center rounded-[13px] bg-[#dcece2] text-[12px] font-extrabold text-[#778179]" aria-hidden="true">{(data.message.senderAddress ?? data.message.sender).slice(0, 2).toUpperCase()}</span>{/if}
      <div class="flex min-w-0 flex-col gap-[5px]">
      <span class="text-[12px] text-[#778179]">From</span>
      <strong class="overflow-hidden text-ellipsis">{data.message.senderAddress ?? data.message.sender}</strong>
      {#if data.message.senderAddress}<small class="overflow-hidden font-mono text-[11px] text-ellipsis text-[#778179]">{data.message.sender}</small>{/if}
      </div>
    </div>
    {#if data.message.category}<mark class="rounded-[999px] bg-[#e5f2e9] px-2.5 py-1.5 text-[12px] font-bold text-[#286446]">{data.message.category}</mark>{/if}
  </header>
  <div class="min-h-[220px] px-6 py-7 font-serif text-[18px] leading-[1.7] max-[560px]:px-[18px]">
    <RichText blocks={data.message.blocks} header={data.message.header} />
  </div>
  <footer class="flex items-center justify-between gap-4 border-0 border-t border-solid border-[#e7ebe8] px-6 py-5 font-mono text-[11px] text-[#778179] max-[560px]:px-[18px]">
    <time datetime={data.message.deliveredAt}>{delivered}</time>
    <span class="overflow-hidden text-ellipsis max-[560px]:hidden">{data.message.messageId}</span>
  </footer>
</article>
{#if data.canReply}
  <form class="hail-card mt-[18px] grid gap-3.5 p-[22px]" method="POST" action="?/reply">
    <label class="grid gap-[7px] text-[13px] font-[750] text-[#3d4c43]">Reply<textarea class="w-full resize-y rounded-[10px] border border-solid border-[#ccd5cf] px-3 py-[11px] [font:inherit]" name="text" rows="5" maxlength="65536" required></textarea></label>
    <label class="flex items-center gap-2 text-[13px] font-[750] text-[#3d4c43]"><input class="w-auto" name="allowReply" type="checkbox" value="yes" /> Allow one reply for 7 days</label>
    <button class="cursor-pointer justify-self-start rounded-[10px] border-0 bg-[#17633f] px-[15px] py-2.5 font-[750] text-white">Send reply</button>
    {#if form?.error}<p class="text-[13px] text-[#852f28]" role="alert">{form.error}</p>{/if}
  </form>
{:else if data.message.replyUntil}
  <p class="mt-4 text-[13px] text-[#852f28]">This reply invitation has expired or was already used.</p>
{/if}
