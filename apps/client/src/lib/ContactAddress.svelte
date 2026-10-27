<script lang="ts">
  import {connectionAddress,type ConnectionAddress} from "./connection-address.js";
  import {onMount} from "svelte";
  import {identityMemory} from "./identity-memory.js";
  import {ADDRESS_NOTICE_MS,identityNotice,type IdentityHistory} from "./identity-history.js";
  let {owner,did,address}:{owner:string;did:string;address:string|null}=$props();
  let history=$state<IdentityHistory>([]),now=$state(Date.now()),mounted=$state(false);
  const explanationId=$props.id();
  let open=$state(false),left=$state(16),top=$state(16);
  function show(event:Event){
    const rect=(event.currentTarget as HTMLElement).getBoundingClientRect();
    left=Math.max(16,Math.min(rect.left,window.innerWidth-316));
    top=Math.max(16,Math.min(rect.bottom+6,window.innerHeight-260));
    open=true;
  }
  let verified=$state<ConnectionAddress|null>(null);
  let displayAddress=$derived(verified?.address??address);
  let observed=$derived(displayAddress?identityNotice(history,did,displayAddress,now):null);
  let recent=$derived(verified?.changedAt&&verified.previousAddress&&verified.previousAddress!==verified.address&&
    now>=Date.parse(verified.changedAt)&&now-Date.parse(verified.changedAt)<ADDRESS_NOTICE_MS);
  let notice=$derived(observed?.kind==='conflict'?observed:recent?{kind:"changed",text:
    `Their address changed from ${verified?.previousAddress} to ${verified?.address}`} : null);
  $effect(()=>{
    if(!mounted)return;
    const account=owner,peer=did;let disposed=false;verified=null;
    const refresh=()=>connectionAddress(account,peer).then(value=>{if(!disposed&&value!==undefined)verified=value;});
    void refresh();const timer=setInterval(refresh,60_000);
    return()=>{disposed=true;clearInterval(timer);};
  });
  $effect(()=>{
    if(!mounted)return;
    const memory=identityMemory(owner);
    if(displayAddress)memory.observe(did,displayAddress);
    const unsubscribe=memory.subscribe(value=>history=value);
    const refresh=(event:StorageEvent)=>{if(event.key===memory.key||event.key===null)memory.refresh();};
    window.addEventListener("storage",refresh);
    return()=>{unsubscribe();window.removeEventListener("storage",refresh);};
  });
  onMount(()=>{mounted=true;const timer=setInterval(()=>now=Date.now(),60_000);return()=>clearInterval(timer);});
</script>
<span class="contact-address">
  <span class="address" title={`Hail identity: ${did}`}>{displayAddress??did}</span>
  {#if notice}
    <span class="indicator" class:conflict={notice.kind==='conflict'}>
      <button type="button" aria-label={notice.kind==='conflict'?'Address used by different identities':'Address changed'} aria-describedby={open?explanationId:undefined} aria-expanded={open}
        onmouseenter={show} onmouseleave={()=>open=false} onfocus={show} onblur={()=>open=false}
        onclick={show} onkeydown={event=>{if(event.key==='Escape')open=false;}}>{notice.kind==='conflict'?'!':'↔'}</button>
      {#if open}<span class="explanation" id={explanationId} role="tooltip" style:left={`${left}px`} style:top={`${top}px`}>{notice.text}{#if notice.kind==='conflict'}<span class="identity">Identity: {did}</span>{/if}</span>{/if}
    </span>
  {/if}
</span>
<style>
  .contact-address { display:inline-flex; align-items:center; gap:6px; max-width:100%; min-width:0; vertical-align:middle; }
  .address { overflow-wrap:anywhere; min-width:0; }
   .indicator { position:relative; flex-shrink:0; z-index:2; color:var(--color-brand-strong); font-weight:400; }
  button { display:grid; place-items:center; width:28px; height:28px; border-radius:50%; cursor:pointer; border:0; color:inherit; font:inherit; background:var(--color-brand-soft); font-weight:700; list-style:none; }
  button:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
  .conflict { color:var(--color-warning); }
  .conflict button { background:var(--color-warning-soft); }
  .explanation { display:block; position:fixed; z-index:50; width:min(300px,calc(100vw - 32px)); box-sizing:border-box; padding:12px; border:1px solid var(--color-line); border-radius:10px; background:var(--color-surface); box-shadow:0 4px 16px #0002; color:var(--color-ink); font-size:12px; line-height:1.6; white-space:normal; }
  .identity { display:block; margin-top:8px; overflow-wrap:anywhere; font-size:11px; }
</style>
