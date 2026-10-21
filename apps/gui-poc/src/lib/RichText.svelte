<script lang="ts">
  import { groupMessageBlocks, type MessageBlock, type MessageImage, type MessageSpan } from "$lib/messages.js";
  let { blocks, header = null }: { blocks: MessageBlock[]; header?: MessageImage | null } = $props();
  const tag = (style: MessageBlock["style"]) => style === "caption" ? "p" : style;
  let groups = $derived(groupMessageBlocks(blocks));
</script>

{#if header}
  <figure><img src={header.src} alt={header.alt} width={header.width} height={header.height} />{#if header.caption}<figcaption>{header.caption}</figcaption>{/if}</figure>
{/if}

{#snippet spans(values: MessageSpan[])}
  {#each values as span}
    {#if span.link}
      <a href={span.link.href} title={span.link.title ?? undefined} rel="noopener noreferrer" target="_blank"
        class:strong={span.strong} class:emphasis={span.emphasis} class:code={span.code}>{span.text}<small>{span.link.hostname}</small></a>
    {:else}
      <span class:strong={span.strong} class:emphasis={span.emphasis} class:code={span.code}>{span.text}</span>
    {/if}
  {/each}
{/snippet}

{#each groups as group}
  {#if group.listItem === "bullet"}
    <ul style={`--level:${group.level}`}>{#each group.blocks as block}<li>{@render spans(block.spans)}</li>{/each}</ul>
  {:else if group.listItem === "number"}
    <ol style={`--level:${group.level}`}>{#each group.blocks as block}<li>{@render spans(block.spans)}</li>{/each}</ol>
  {:else}
    {@const block = group.blocks[0]}
    <svelte:element this={tag(block.style)} class:caption={block.style === "caption"}>{@render spans(block.spans)}</svelte:element>
  {/if}
{/each}

<style>
  p, h1, h2, h3, blockquote, ul, ol, figure { margin: 0 0 1em; }
  figure img { display: block; width: 100%; height: auto; max-height: 28rem; border-radius: .6em; object-fit: cover; }
  figcaption { margin-top: .45em; color: #68766e; font-size: .72em; }
  h1 { font-size: 1.8em; } h2 { font-size: 1.45em; } h3 { font-size: 1.2em; }
  blockquote { margin-left: 0; padding-left: 16px; border-left: 3px solid #91ad9d; color: #45584d; }
  ul, ol { padding-left: calc(1.5em + (var(--level) - 1) * 1.25em); }
  .caption { color: #68766e; font-size: .82em; }
  .strong { font-weight: 750; } .emphasis { font-style: italic; }
  .code { padding: .08em .3em; border-radius: .3em; background: #edf0ed; font-family: ui-monospace, monospace; font-size: .88em; }
  a { color: #17633f; text-decoration-thickness: .08em; text-underline-offset: .16em; }
  a small { display: inline-block; margin-left: .4em; color: #718078; font-family: ui-sans-serif, system-ui, sans-serif; font-size: .6em; font-style: normal; font-weight: 500; }
</style>
