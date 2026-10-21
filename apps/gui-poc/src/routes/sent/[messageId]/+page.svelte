<script lang="ts">
  import RichText from "$lib/RichText.svelte";
  import {deliveryDescription,deliveryIcon} from "$lib/delivery-status.js";
  let {data,form}=$props();
  let created=$derived(new Intl.DateTimeFormat(undefined,{dateStyle:"long",timeStyle:"short"}).format(new Date(data.message.createdAt)));
  let icon=$derived(deliveryIcon(data.message.state));
</script>

<a class="back" href="/sent">← Sent</a>
<article class="card">
  <header><div><span>To</span><strong>{data.message.recipientAddress??data.message.recipient}</strong>{#if data.message.recipientAddress}<small>{data.message.recipient}</small>{/if}</div><span class:accepted={data.message.state==='accepted'} class="status" aria-label={`Status: ${data.message.state}`}><b aria-hidden="true">{icon}</b> {data.message.state}</span></header>
  <section class="delivery"><p>{deliveryDescription(data.message)}</p>{#if data.message.state==='indeterminate'}<form method="POST" action="?/retry"><button>Retry submission</button></form>{/if}{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}</section>
  <div class="body"><RichText blocks={data.message.blocks} header={data.message.header}/></div>
  <footer><time datetime={data.message.createdAt}>{created}</time><span>{data.message.messageId}</span></footer>
</article>

<style>
  .back{display:inline-block;margin-bottom:18px;color:#286446;font-size:14px;font-weight:700;text-decoration:none}article{overflow:hidden}header,footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 24px}header{border-bottom:1px solid #e7ebe8}header>div{display:flex;min-width:0;flex-direction:column;gap:5px}header span{color:#778179;font-size:12px}header strong,header small{overflow:hidden;text-overflow:ellipsis}header small{color:#778179;font-family:ui-monospace,monospace;font-size:11px}.status{color:#202723;font-weight:750;text-transform:capitalize;white-space:nowrap}.status b{font-size:17px}.status.accepted{color:#168244}.delivery{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 24px;background:#f1f5f2;color:#4b5b52;font-size:13px}.delivery p{margin:0}.delivery button{padding:8px 11px;border:0;border-radius:8px;background:#17633f;color:white;font-weight:750;white-space:nowrap;cursor:pointer}.delivery .error{color:#852f28}.body{min-height:220px;padding:28px 24px;font-family:ui-serif,Georgia,serif;font-size:18px;line-height:1.7}footer{border-top:1px solid #e7ebe8;color:#778179;font-family:ui-monospace,monospace;font-size:11px}footer span{overflow:hidden;text-overflow:ellipsis}@media(max-width:560px){header,footer,.body{padding-left:18px;padding-right:18px}.delivery{align-items:flex-start;flex-direction:column}footer span{display:none}}
</style>
