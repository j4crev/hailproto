<script lang="ts">
  import RichText from "$lib/RichText.svelte";
  let {data}=$props();
  let created=$derived(new Intl.DateTimeFormat(undefined,{dateStyle:"long",timeStyle:"short"}).format(new Date(data.message.createdAt)));
  let icon=$derived(data.message.state==="accepted"?"✓":data.message.state==="delivered"?"✉":data.message.state==="on-hold"?"…":data.message.state==="indeterminate"?"?":"!");
</script>

<a class="back" href="/sent">← Sent</a>
<article class="card">
  <header><div><span>To</span><strong>{data.message.recipient}</strong></div><span class:accepted={data.message.state==='accepted'} class="status" aria-label={`Status: ${data.message.state}`}><b aria-hidden="true">{icon}</b> {data.message.state}</span></header>
  <div class="body"><RichText blocks={data.message.blocks} header={data.message.header}/></div>
  <footer><time datetime={data.message.createdAt}>{created}</time><span>{data.message.messageId}</span></footer>
</article>

<style>
  .back{display:inline-block;margin-bottom:18px;color:#286446;font-size:14px;font-weight:700;text-decoration:none}article{overflow:hidden}header,footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 24px}header{border-bottom:1px solid #e7ebe8}header>div{display:flex;min-width:0;flex-direction:column;gap:5px}header span{color:#778179;font-size:12px}header strong{overflow:hidden;text-overflow:ellipsis}.status{color:#202723;font-weight:750;text-transform:capitalize;white-space:nowrap}.status b{font-size:17px}.status.accepted{color:#168244}.body{min-height:220px;padding:28px 24px;font-family:ui-serif,Georgia,serif;font-size:18px;line-height:1.7}footer{border-top:1px solid #e7ebe8;color:#778179;font-family:ui-monospace,monospace;font-size:11px}footer span{overflow:hidden;text-overflow:ellipsis}@media(max-width:560px){header,footer,.body{padding-left:18px;padding-right:18px}footer span{display:none}}
</style>
