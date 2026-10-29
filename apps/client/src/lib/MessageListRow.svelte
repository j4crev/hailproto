<script lang="ts">
  import type {Snippet} from "svelte";
  import type {MessageImage} from "./messages.js";
  import DateTime from "./DateTime.svelte";
  let {isRead = false, leading, sender, timestamp, title, preview, header = null, href, selected = false, muted = false, details}: {
    isRead?: boolean; leading?: Snippet; sender?: Snippet; timestamp: string; title: string; preview: string;
    header?: MessageImage | null; href?: string; selected?: boolean; muted?: boolean; details?: Snippet;
  } = $props();
</script>

{#snippet content()}
  {#if header}<img class="message-header" src={header.src} alt={header.alt} width={header.width} height={header.height} />{/if}
  <span class="message-copy">
    {#if title}<strong class="message-subject">{title}</strong>{/if}
    <span class="message-preview">{preview}</span>
    {#if details}<span class="message-details">{@render details()}</span>{/if}
  </span>
{/snippet}

<article class="list-row message-row" class:is-read={isRead} class:muted class:has-header={!!header} class:without-leading={!leading} class:is-selected={selected}>
  {#if leading}<div class="message-leading">{@render leading()}</div>{/if}
  <div class="message-meta">
    {#if sender}<strong class="message-sender">{@render sender()}</strong>{/if}
    <span class="list-date"><DateTime format="list" value={timestamp} /></span>
  </div>
  {#if href}<a class="message-link" {href}>{@render content()}</a>
  {:else}<div class="message-content">{@render content()}</div>{/if}
</article>

<style>
  .message-row { padding-block:16px; position:relative; display:grid; grid-template-columns:44px minmax(0,1fr); align-items:center; column-gap:12px; }
  .message-row.without-leading { grid-template-columns:minmax(0,1fr); }
  .without-leading .message-meta, .without-leading .message-link, .without-leading .message-content { grid-column:1; }
  .without-leading.has-header .message-meta { margin:16px; }
  .message-leading { grid-column:1; grid-row:1 / 3; }
  .message-meta, .message-link, .message-content { grid-column:2; min-width:0; }
  .message-row.has-header { padding:0; grid-template-columns:60px minmax(0,1fr); }
  .has-header .message-leading { grid-row:1; margin:16px 0 16px 16px; }
  .has-header .message-meta { margin-right:16px; }
  .has-header .message-link, .has-header .message-content { grid-column:1 / -1; }
  .has-header .message-copy { display:block; padding:20px 16px; }
  .has-header .message-subject, .has-header .message-preview { white-space:normal; overflow-wrap:anywhere; }
  .message-header { display:block; width:100%; height:auto; max-height:320px; object-fit:cover; border-block:1px solid var(--color-line); }
  .message-meta { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
  .message-sender { min-width:0; font-size:13px; }
  .message-sender :global(.address) { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .list-date { margin-left:auto; }
  .message-link { display:block; color:inherit; text-decoration:none; }
  .message-link::after { content:""; position:absolute; inset:0; }
  .message-link:focus-visible::after { outline:2px solid var(--color-brand); outline-offset:-2px; }
  .message-subject, .message-preview { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; }
  .message-subject { margin-top:2px; font-weight:650; }
  .is-read .message-sender, .is-read .message-subject { font-weight:400; }
  .muted .message-sender, .muted .message-subject { font-weight:400; color:var(--color-muted); }
  .message-preview { color:var(--color-muted); }
  @media(max-width:640px) { .message-meta { gap:8px; } }
  .message-details { display:block; margin-top:4px; color:var(--color-muted); font-size:11px; }
</style>
