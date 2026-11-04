<script lang="ts">
  import type {Snippet} from "svelte";
  import type {MessageImage} from "./messages.js";
  import DateTime from "./DateTime.svelte";
  let {isRead = false, leading, sender, timestamp, title, preview, header = null, href, selected = false, muted = false, details, unreadCount, onclick, expanded, inline = false, imageLayout = "thumbnail"}: {
    unreadCount?:number; onclick?:()=>void; expanded?:boolean; inline?: boolean; imageLayout?: "feature" | "thumbnail"; isRead?: boolean; leading?: Snippet; sender?: Snippet; timestamp: string; title: string; preview: string;
    header?: MessageImage | null; href?: string; selected?: boolean; muted?: boolean; details?: Snippet;
  } = $props();
</script>

{#snippet content()}
  {#if header}<img class="message-header" src={header.src} alt={header.alt} width={header.width} height={header.height} />{/if}
  <span class="message-copy block min-w-0 flex-1">
    <span class="message-summary" class:titleless={!title && !!unreadCount}>
      {#if title}<span class="message-heading"><strong class="message-subject">{title}</strong>{#if unreadCount && unreadCount>1}<span class="text-xs font-normal text-muted" title={`${unreadCount} unread messages`}>({unreadCount})</span>{/if}</span>{/if}
      <span class="message-preview">{preview}</span>{#if !title && unreadCount && unreadCount>1}<span class="text-xs font-normal text-muted">({unreadCount})</span>{/if}
    </span>
    {#if details}<span class="message-details">{@render details()}</span>{/if}
  </span>
{/snippet}

<article class="list-row message-row" class:inline-row={inline} class:is-read={isRead} class:muted class:has-header={!!header && imageLayout === "feature"} class:has-thumbnail={!!header && imageLayout === "thumbnail"} class:without-leading={!leading} class:is-selected={selected}>
  {#if leading}<div class="message-leading">{@render leading()}</div>{/if}
  <div class="message-meta">
    {#if sender}<strong class="message-sender">{#if !isRead && !muted}<span class="sr-only">Unread: </span>{/if}{@render sender()}</strong>{/if}
    <strong class="list-date"><DateTime format="list" value={timestamp} /></strong>
  </div>
  {#if onclick}<button type="button" class="message-link row-button" {onclick} aria-expanded={expanded}>{@render content()}</button>
  {:else if href}<a class="message-link" {href}>{@render content()}</a>
  {:else}<div class="message-content">{@render content()}</div>{/if}
</article>

<style lang="postcss">
  @reference "../app.css";

  .row-button { @apply [border:0] [background:none] p-0 text-left; font: inherit; @apply cursor-pointer w-full; }
  .message-row { @apply [padding:18px_12px] relative grid [grid-template-columns:40px_minmax(0,1fr)] items-center gap-x-[12px]; }
  .message-row.without-leading { @apply grid-cols-[minmax(0,1fr)]; }
  .without-leading .message-meta, .without-leading .message-link, .without-leading .message-content { @apply [grid-column:1]; }
  .message-leading { @apply [grid-column:1] [grid-row:1_/_3]; }
  .message-meta, .message-link, .message-content { @apply [grid-column:2] min-w-0; }
  .has-header .message-leading { @apply [grid-row:1]; }
  .has-header .message-meta { @apply py-[4px]; }
  .has-header .message-link, .has-header .message-content { @apply [grid-column:1_/_-1] mt-[14px]; }
  .message-header { @apply block w-full h-auto max-h-[200px] object-contain rounded-[10px] [background:var(--color-canvas)] mb-[12px]; }
  .has-header .message-subject, .has-header .message-preview { @apply whitespace-normal [overflow-wrap:anywhere]; }
  .has-header .message-preview { @apply [display:-webkit-box] [-webkit-line-clamp:2] [line-clamp:2] [-webkit-box-orient:vertical]; }
  .has-thumbnail .message-link, .has-thumbnail .message-content { @apply flex flex-row-reverse items-center gap-[12px]; }
  .has-thumbnail .message-header { @apply w-[72px] h-[54px] shrink-0 m-0 rounded-[6px]; }
  .message-summary.titleless { @apply flex items-baseline gap-[6px]; }
  .titleless .message-preview { @apply min-w-0; }
  .message-heading { @apply flex items-baseline min-w-0 gap-[6px]; }
  .message-summary { @apply block min-w-0; }
  .message-meta { @apply flex items-baseline justify-between gap-[12px]; }
  .message-sender { @apply min-w-0 text-[14px]; }
  .message-sender :global(.address) { @apply overflow-hidden text-ellipsis whitespace-nowrap; }
  .list-date { @apply ml-auto; }
  .message-link { @apply block text-inherit [text-decoration:none]; }
  .message-link::after { content: ""; @apply absolute [inset:0]; }
  .message-link:focus-visible::after { @apply [outline:2px_solid_var(--color-brand)]; @apply [outline-offset:-2px] rounded-[4px]; }
  .message-subject, .message-preview { @apply block overflow-hidden text-ellipsis whitespace-nowrap text-[14px] leading-[1.6]; }
  .message-subject { @apply mt-[2px] tracking-[-.015em]; }
  .message-sender, .message-subject, .list-date { @apply font-[650]; }
  .is-read .message-sender, .is-read .message-subject, .is-read .list-date { @apply font-[450]; }
  .is-read .message-sender, .is-read .message-subject { @apply text-message-read; }
  .message-row:not(.is-read):not(.muted) .list-date { @apply text-ink; }
  .muted .message-sender, .muted .message-subject, .muted .list-date { @apply font-[500]; }
  .message-preview { @apply text-muted; }
  .message-details { @apply block mt-[4px] text-muted text-[12px]; }
  @media (max-width:640px) {
    .message-row { @apply [padding:16px_12px] gap-x-[10px] [grid-template-columns:44px_minmax(0,1fr)]; }
    .message-meta { @apply gap-[8px]; }
    .message-header { @apply max-h-[180px]; }
    .list-date { @apply text-[11px]; }
  }
  @media (min-width:1024px) {
    .inline-row {
      @apply min-h-[64px] p-[12px] [grid-template-columns:40px_minmax(140px,22%)_minmax(0,1fr)_max-content];
      grid-template-areas: "leading sender content date";
      @apply gap-x-[16px];
    }
    .inline-row.without-leading { @apply [grid-template-columns:minmax(140px,22%)_minmax(0,1fr)_max-content]; grid-template-areas: "sender content date"; }
    .inline-row .message-meta { @apply contents; }
    .inline-row .message-leading { @apply [grid-area:leading]; }
    .inline-row .message-sender { @apply [grid-area:sender] overflow-hidden text-ellipsis whitespace-nowrap; }
    .inline-row .list-date { @apply [grid-area:date]; }
    .inline-row .message-link, .inline-row .message-content { @apply [grid-area:content]; }
    .inline-row .message-summary { @apply flex items-baseline gap-[8px]; }
    .inline-row .message-heading { @apply [flex:0_1_auto] max-w-[70%]; }
    .inline-row .message-subject { @apply min-w-0 m-0; }
    .inline-row .message-preview { @apply [flex:1_1_0] min-w-0; }
    .inline-row .message-heading + .message-preview::before { content: "— "; }
    .inline-row .message-header { @apply w-[44px] h-[34px]; }
    .inline-row .message-details { @apply mt-[2px]; }
  }
</style>
