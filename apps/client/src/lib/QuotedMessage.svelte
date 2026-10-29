<script lang="ts">
  import RichText from './RichText.svelte';
  import {replyQuoteIndex} from './reply.js';
  import type {MessageBlock,MessageImage} from './messages.js';
  let {blocks,header=null}:{blocks:MessageBlock[];header?:MessageImage|null}=$props();
  const index=$derived(replyQuoteIndex(blocks));
</script>
<RichText blocks={index<0?blocks:blocks.slice(0,index)} {header}/>
{#if index>=0}
  <details class="mt-5 border-0 border-t border-solid border-line pt-4">
    <summary class="cursor-pointer font-sans text-sm text-muted">Show quoted message</summary>
    <div class="mt-4"><RichText blocks={blocks.slice(index+1)}/></div>
  </details>
{/if}
