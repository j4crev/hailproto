<script lang="ts">
  import RichText from './RichText.svelte';
  import Icon from './Icon.svelte';
  import {replyQuoteIndex} from './reply.js';
  import type {MessageBlock,MessageImage} from './messages.js';
  let {blocks,header=null}:{blocks:MessageBlock[];header?:MessageImage|null}=$props();
  const index=$derived(replyQuoteIndex(blocks));
</script>
<RichText blocks={index<0?blocks:blocks.slice(0,index)} {header}/>
{#if index>=0}
  <details class="mt-5 border-0 border-t border-solid border-line pt-4">
    <summary class="quote-toggle text-muted" aria-label="Toggle quoted text" title="Toggle quoted text"><Icon name="ellipsis" size={18} /></summary>
    <div class="mt-4"><RichText blocks={blocks.slice(index+1)}/></div>
  </details>
{/if}
<style>
  .quote-toggle { display:grid; place-items:center; width:32px; height:32px; border-radius:6px; cursor:pointer; list-style:none; }
  .quote-toggle::-webkit-details-marker { display:none; }
  .quote-toggle:hover { background:var(--color-brand-soft); }
</style>
