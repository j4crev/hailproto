<script lang="ts">
  import RichText from "$lib/RichText.svelte";
  let {data}=$props();
  let created=$derived(new Intl.DateTimeFormat(undefined,{dateStyle:"long",timeStyle:"short"}).format(new Date(data.message.createdAt)));
</script>

<svelte:head><title>{data.message.title} · Sent · Haili</title></svelte:head>
<a class="hail-back" href="/sent">← Sent messages</a>
<h1 class="sr-only">{data.message.title}</h1>
<article class="hail-card overflow-hidden">
  <header class="border-0 border-b border-solid border-line p-5 text-sm text-muted sm:px-7">{data.message.kind==='category'?`Category: ${data.message.category}`:data.message.kind==='connections'?'Connections':'Sent message'}</header>
  <div class="min-h-[220px] px-5 py-8 font-serif text-[18px] leading-[1.7] [overflow-wrap:anywhere] sm:px-7"><RichText blocks={data.message.blocks} header={data.message.header}/></div>
  <footer class="border-0 border-t border-solid border-line p-5 text-xs text-muted sm:px-7"><time datetime={data.message.createdAt}>{created}</time></footer>
</article>
