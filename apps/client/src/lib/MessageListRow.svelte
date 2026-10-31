<script lang="ts">
  import type {Snippet} from "svelte";
  import type {MessageImage} from "./messages.js";
  import ThreadCount from "./ThreadCount.svelte";
  import DateTime from "./DateTime.svelte";
  let {isRead = false, leading, sender, timestamp, title, preview, header = null, href, selected = false, muted = false, details, thread, inline = false, imageLayout = "thumbnail"}: {
    thread?: {sender:string;messageId:string}; inline?: boolean; imageLayout?: "feature" | "thumbnail"; isRead?: boolean; leading?: Snippet; sender?: Snippet; timestamp: string; title: string; preview: string;
    header?: MessageImage | null; href?: string; selected?: boolean; muted?: boolean; details?: Snippet;
  } = $props();
</script>

{#snippet content()}
  {#if header}<img class="message-header" src={header.src} alt={header.alt} width={header.width} height={header.height} />{/if}
  <span class="message-copy">
    <span class="message-summary" class:titleless={!title && !!thread}>
      {#if title}<span class="message-heading"><strong class="message-subject">{title}</strong>{#if thread}<ThreadCount {thread} />{/if}</span>{/if}
      <span class="message-preview">{preview}</span>{#if !title && thread}<ThreadCount {thread} />{/if}
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
  {#if href}<a class="message-link" {href}>{@render content()}</a>
  {:else}<div class="message-content">{@render content()}</div>{/if}
</article>

<style>
  .message-row { padding:18px 12px; position:relative; display:grid; grid-template-columns:40px minmax(0,1fr); align-items:center; column-gap:12px; }
  .message-row.without-leading { grid-template-columns:minmax(0,1fr); }
  .without-leading .message-meta, .without-leading .message-link, .without-leading .message-content { grid-column:1; }
  .message-leading { grid-column:1; grid-row:1 / 3; }
  .message-meta, .message-link, .message-content { grid-column:2; min-width:0; }
  .has-header .message-leading { grid-row:1; }
  .has-header .message-meta { padding-block:4px; }
  .has-header .message-link, .has-header .message-content { grid-column:1 / -1; margin-top:14px; }
  .message-header { display:block; width:100%; height:auto; max-height:200px; object-fit:contain; border-radius:10px; background:var(--color-canvas); margin-bottom:12px; }
  .has-header .message-subject, .has-header .message-preview { white-space:normal; overflow-wrap:anywhere; }
  .has-header .message-preview { display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; }
  .has-thumbnail .message-link, .has-thumbnail .message-content { display:flex; flex-direction:row-reverse; align-items:center; gap:12px; }
  .has-thumbnail .message-header { width:72px; height:54px; flex-shrink:0; margin:0; border-radius:6px; }
  .message-summary.titleless { display:flex; align-items:baseline; gap:6px; }
  .titleless .message-preview { min-width:0; }
  .message-heading { display:flex; align-items:baseline; min-width:0; gap:6px; }
  .message-summary { display:block; min-width:0; }
  .message-copy { display:block; min-width:0; flex:1; }
  .message-meta { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
  .message-sender { min-width:0; font-size:14px; font-weight:650; }
  .message-sender :global(.address) { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .list-date { margin-left:auto; font-weight:400; }
  .message-row:not(.is-read):not(.muted) .list-date { color:var(--color-ink); font-weight:650; }
  .message-link { display:block; color:inherit; text-decoration:none; }
  .message-link::after { content:""; position:absolute; inset:0; }
  .message-link:focus-visible::after { outline:2px solid var(--color-brand); outline-offset:-2px; border-radius:4px; }
  .message-subject, .message-preview { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; line-height:1.6; }
  .message-subject { margin-top:2px; font-weight:650; letter-spacing:-.015em; }
  .is-read .message-sender, .is-read .message-subject { font-weight:450; }
  .muted .message-sender, .muted .message-subject { font-weight:500; }
  .message-preview { color:var(--color-muted); }
  .message-details { display:block; margin-top:4px; color:var(--color-muted); font-size:12px; }
  @media(max-width:640px) { .message-row { padding:16px 0; column-gap:10px; grid-template-columns:44px minmax(0,1fr); } .message-meta { gap:8px; } .message-header { max-height:180px; } .list-date { font-size:11px; } }
  @media(min-width:1024px) {
    .inline-row { min-height:64px; padding:12px; grid-template-columns:40px minmax(140px,22%) minmax(0,1fr) max-content; grid-template-areas:"leading sender content date"; column-gap:16px; }
    .inline-row.without-leading { grid-template-columns:minmax(140px,22%) minmax(0,1fr) max-content; grid-template-areas:"sender content date"; }
    .inline-row .message-meta { display:contents; }
    .inline-row .message-leading { grid-area:leading; }
    .inline-row .message-sender { grid-area:sender; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .inline-row .list-date { grid-area:date; }
    .inline-row .message-link, .inline-row .message-content { grid-area:content; }
    .inline-row .message-summary { display:flex; align-items:baseline; gap:8px; }
    .inline-row .message-heading { flex:0 1 auto; max-width:70%; }
    .inline-row .message-subject { min-width:0; margin:0; }
    .inline-row .message-preview { flex:1 1 0; min-width:0; }
    .inline-row .message-heading + .message-preview::before { content:"— "; }
    .inline-row .message-header { width:44px; height:34px; }
    .inline-row .message-details { margin-top:2px; }
  }
</style>
