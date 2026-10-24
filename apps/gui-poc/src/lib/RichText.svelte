<script lang="ts">
  import { groupMessageBlocks, type MessageBlock, type MessageImage, type MessageSpan } from "$lib/messages.js";
  let { blocks, header = null }: { blocks: MessageBlock[]; header?: MessageImage | null } = $props();
  const tag = (style: MessageBlock["style"]) => style === "caption" ? "p" : style;
  let groups = $derived(groupMessageBlocks(blocks));
</script>

{#if header}
  <figure class="m-0 mb-[1em]"><img class="block h-auto max-h-[28rem] w-full rounded-[.6em] object-cover" src={header.src} alt={header.alt} width={header.width} height={header.height} />{#if header.caption}<figcaption class="mt-[.45em] text-[.72em] text-[#68766e]">{header.caption}</figcaption>{/if}</figure>
{/if}

{#snippet spans(values: MessageSpan[])}
  {#each values as span}
    {#if span.link}
      <a href={span.link.href} title={span.link.title ?? undefined} rel="noopener noreferrer" target="_blank"
        class={["text-[#17633f] decoration-[.08em] underline-offset-[.16em]", span.strong && "font-[750]", span.emphasis && "italic", span.code && "rounded-[.3em] bg-[#edf0ed] px-[.3em] py-[.08em] font-mono text-[.88em]"]}>{span.text}<small class="ml-[.4em] inline-block font-[ui-sans-serif,system-ui,sans-serif] text-[.6em] font-medium text-[#718078] not-italic">{span.link.hostname}</small></a>
    {:else}
      <span class={[span.strong && "font-[750]", span.emphasis && "italic", span.code && "rounded-[.3em] bg-[#edf0ed] px-[.3em] py-[.08em] font-mono text-[.88em]"]}>{span.text}</span>
    {/if}
  {/each}
{/snippet}

{#each groups as group}
  {#if group.listItem === "bullet"}
    <ul class="m-0 mb-[1em] pl-[calc(1.5em_+_(var(--level)_-_1)_*_1.25em)]" style={`--level:${group.level}`}>{#each group.blocks as block}<li>{@render spans(block.spans)}</li>{/each}</ul>
  {:else if group.listItem === "number"}
    <ol class="m-0 mb-[1em] pl-[calc(1.5em_+_(var(--level)_-_1)_*_1.25em)]" style={`--level:${group.level}`}>{#each group.blocks as block}<li>{@render spans(block.spans)}</li>{/each}</ol>
  {:else}
    {@const block = group.blocks[0]}
    <svelte:element this={tag(block.style)} class={["m-0 mb-[1em]", block.style === "caption" && "text-[.82em] text-[#68766e]", block.style === "h1" && "text-[1.8em]", block.style === "h2" && "text-[1.45em]", block.style === "h3" && "text-[1.2em]", block.style === "blockquote" && "border-0 border-l-[3px] border-solid border-[#91ad9d] pl-4 text-[#45584d]"]}>{@render spans(block.spans)}</svelte:element>
  {/if}
{/each}
