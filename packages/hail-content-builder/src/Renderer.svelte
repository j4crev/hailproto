<script lang="ts">
  import {forwardedAttribution,groupMessageBlocks,type MessageBlock,type MessageImage,type MessageSpan} from './rendering.js';
  let {blocks,header=null,imagesUnavailable=false}:{blocks:MessageBlock[];header?:MessageImage|null;imagesUnavailable?:boolean}=$props();
  const tag=(style:MessageBlock['style'])=>style==='caption'||style==='normal'?'p':style;
  const groups=$derived(groupMessageBlocks(blocks));
  const forwarded=$derived(forwardedAttribution(blocks));
</script>
<div class="spt-content">
  {#if header}<figure>{#if imagesUnavailable}<p role="img" aria-label={header.alt}>{header.alt}</p>{:else}<img src={header.src} alt={header.alt} width={header.width} height={header.height}/>{/if}{#if header.caption}<figcaption>{header.caption}</figcaption>{/if}</figure>{/if}
  {#snippet spans(values:MessageSpan[])}
    {#each values as span}
      {#if span.link}<a class="whitespace-pre-wrap" href={span.link.href} title={span.link.title??undefined} rel="noopener noreferrer" target="_blank" class:strong={span.strong} class:emphasis={span.emphasis} class:code={span.code}>{span.text}<small>{span.link.hostname}</small></a>
      {:else}<span class="whitespace-pre-wrap" class:strong={span.strong} class:emphasis={span.emphasis} class:code={span.code}>{span.text}</span>{/if}
    {/each}
  {/snippet}
  {#each groups as group}
    {#if group.listItem==='bullet'}<ul style={`--level:${group.level}`}>{#each group.blocks as block}<li>{@render spans(block.spans)}</li>{/each}</ul>
    {:else if group.listItem==='number'}<ol style={`--level:${group.level}`}>{#each group.blocks as block}<li>{@render spans(block.spans)}</li>{/each}</ol>
    {:else}{@const block=group.blocks[0]}<svelte:element this={tag(block.style)} class:caption={block.style==='caption'} class:forward-heading={block===forwarded?.heading} class:forward-metadata={block===forwarded?.metadata}>{@render spans(block.spans)}</svelte:element>{/if}
  {/each}
</div>
<style>
  .spt-content{overflow-wrap:anywhere;line-height:1.65}
  p,h1,h2,h3,blockquote,ul,ol,figure{margin:0 0 1em}h1{font-size:1.8em}h2{font-size:1.45em}h3{font-size:1.2em}
  ul,ol{padding-left:calc(1.5em + (var(--level) - 1)*1.25em)}
  blockquote{border-left:3px solid var(--color-brand,#127365);padding-left:1rem;color:var(--color-muted,#667775)}
  span,a{white-space:pre-wrap}.strong{font-weight:750}.emphasis{font-style:italic}.code{border-radius:.3em;background:var(--color-canvas,#edf3f2);padding:.08em .3em;font-family:monospace;font-size:.88em}
  a{color:var(--color-brand,#127365);text-decoration-thickness:.08em;text-underline-offset:.16em}small{display:inline-block;margin-left:.4em;font:500 .6em system-ui;color:var(--color-muted,#667775)}
  img{display:block;width:100%;height:auto;max-height:28rem;object-fit:contain;border-radius:.6em}.caption,figcaption{font-size:.82em;color:var(--color-muted,#667775)}figcaption{margin-top:.45em;font-size:.72em}
  .forward-heading{margin-top:1.75em;padding-top:1.25em;border-top:1px solid var(--color-line,#ddd);font:650 .85em system-ui}.forward-metadata{padding-bottom:1.25em;border-bottom:1px solid var(--color-line,#ddd);font:.75em/1.65 system-ui;color:var(--color-muted,#667775)}
</style>
