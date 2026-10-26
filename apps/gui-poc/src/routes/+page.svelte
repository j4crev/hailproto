<script lang="ts">
  import {onMount} from "svelte";
  import PasskeySignIn from "$lib/PasskeySignIn.svelte";
  import Icon from "$lib/Icon.svelte";
  import {showInboxHeaders, loadHeaderPreference} from "$lib/preferences.js";
  let {data} = $props();
  const date = (value: string) => new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(new Date(value));
  onMount(loadHeaderPreference);
</script>

<svelte:head><title>{!data.configured ? 'Welcome' : data.view === 'connections' ? 'Messages' : 'Inbox'} · Haili</title></svelte:head>

{#if !data.configured}
  <section class="welcome">
    <div class="welcome-copy">
      <h1>Your inbox.<br /><span>Your permission.</span></h1>
      <p class="welcome-description">Choose who can reach you and what they can send.</p>
      <div class="welcome-signin"><PasskeySignIn /><p>Already have an invitation? Use your signup link.</p></div>
    </div>
    <div class="welcome-art" aria-hidden="true">
      <div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div>
      <div class="art-label"><span></span>A space for what matters</div>
      <div class="sample-message sample-back"><div class="sample-avatar"><Icon name="chat" size={22} /></div><div><strong>Good company.</strong><span>Conversations worth keeping.</span></div><Icon name="shield" size={17} /></div>
      <div class="sample-message sample-front"><div class="sample-top"><span class="sample-avatar"><Icon name="feed" size={22} /></span><div><strong>A fresh perspective</strong><span>Only because you asked.</span></div><span class="sample-dot"></span></div><div class="sample-landscape"><span class="sun"></span><span class="hill hill-one"></span><span class="hill hill-two"></span><span class="landscape-label">Room to breathe.</span></div><div class="sample-lines"><span></span><span></span></div></div>
      <div class="permission-note"><Icon name="shield" size={18} />You decide who gets in.</div>
    </div>
  </section>
  <div class="welcome-principles"><div><span>01</span><strong>Choose your senders</strong><p>Let the right updates in.</p></div><div><span>02</span><strong>Keep it personal</strong><p>Make room for real conversations.</p></div><div><span>03</span><strong>Stay in control</strong><p>Change your permissions anytime.</p></div></div>
{:else}
  <header class="feed-heading">
    <div><p class="hail-eyebrow">Your daily space</p><h1 class="hail-title">{data.view === 'connections' ? 'Messages' : 'Inbox'}</h1><p class="feed-description">{data.view === 'connections' ? 'A little closer to your people.' : 'The latest from the senders you choose.'}</p></div>
    <a class="hail-button-secondary" href={data.view === 'connections' ? '/compose?audience=connections' : '/permissions'}><Icon name={data.view === 'connections' ? 'plus' : 'people'} size={18} />{data.view === 'connections' ? 'New message' : 'Manage subscriptions'}</a>
  </header>
  <div class="feed-layout"><div class="min-w-0">
  <section class="grid gap-5" aria-label="Messages">

    {#if data.messages.length === 0}
      <div class="hail-card flex flex-col items-center gap-3 px-6 py-16 text-center"><span class="empty-symbol" aria-hidden="true"><Icon name={data.view === 'connections' ? 'chat' : 'feed'} size={30} /></span><h2 class="m-0 text-xl tracking-tight">No messages yet</h2><p class="m-0 max-w-sm text-sm text-muted">{data.view==='connections'?'Your people, your conversations. Start with a hello.':'A little quiet is a good start. Allow a sender to bring the updates you care about here.'}</p>{#if data.view !== 'connections'}<a class="hail-button-secondary mt-2" href="/permissions">Find your first sender <span aria-hidden="true">→</span></a>{/if}</div>
    {:else}
      {#each data.messages as message}
        <a class="hail-card flex min-w-0 flex-col overflow-hidden no-underline transition-[border-color,box-shadow] duration-150 hover:border-brand hover:shadow-md" href={`/message/${encodeURIComponent(message.sender)}/${message.messageId}${message.kind==='connection'?'?view=connections':''}`}>
          <span class="flex items-center gap-3 px-6 py-4">
            {#if message.avatar}<img class="grid size-[42px] flex-[0_0_42px] place-items-center rounded-[13px] object-cover" src={message.avatar.src} alt="" width={message.avatar.width} height={message.avatar.height} />
              {:else}<span class="grid size-[42px] flex-[0_0_42px] place-items-center rounded-[13px] bg-brand-soft text-[12px] font-extrabold text-brand" aria-hidden="true">{(message.senderAddress ?? message.sender).slice(0, 2).toUpperCase()}</span>{/if}
            <span class="flex min-w-0 flex-1 flex-col gap-[3px]"><strong class="truncate text-[14px]">{message.senderAddress ?? message.sender}</strong><time class="text-[11px] text-muted" datetime={message.deliveredAt}>{date(message.deliveredAt)}</time></span>
          </span>
          {#if $showInboxHeaders && message.header}
            <img class="block h-auto max-h-[320px] w-full border-0 border-y border-solid border-line object-cover" src={message.header.src} alt={message.header.alt} width={message.header.width} height={message.header.height} />
          {/if}
          <span class="px-6 pt-4 pb-6 font-serif text-[17px] leading-relaxed text-ink [overflow-wrap:anywhere]">{message.preview}</span>
        </a>
      {/each}
    {/if}
  </section>
  {#if data.paged||data.next}<nav aria-label={data.view === 'connections' ? 'Messages pages' : 'Inbox pages'} class="mt-6 flex flex-wrap justify-center gap-3">{#if data.paged}<a class="hail-button-secondary" href={data.view==='connections'?'/?view=connections':'/'}>← Newest messages</a>{/if}{#if data.next}<a class="hail-button-secondary" href={`/?${data.view==='connections'?'view=connections&':''}after=${encodeURIComponent(data.next)}`}>Older messages →</a>{/if}</nav>{/if}
  </div><aside class="feed-aside"><div class="aside-heading"><Icon name="shield" size={18} /><span>On your terms</span></div><h2>{data.view === 'connections' ? 'Good conversations start here.' : 'An inbox with intention.'}</h2><p>{data.view === 'connections' ? 'Share your connection code to invite someone into your space.' : 'Choose who can reach you and what they can send.'}</p><a href={data.view === 'connections' ? '/connections' : '/permissions'}>{data.view === 'connections' ? 'Your connection codes' : 'Your subscriptions'}<Icon name="arrow" size={16} /></a></aside></div>
{/if}

<style>
  .welcome { display:grid; grid-template-columns:1.1fr 1fr; align-items:center; gap:48px; min-height:490px; padding:28px 0 55px; }
  .welcome-copy { align-self:start; padding-top:40px; }
  .welcome-copy h1 { margin:0 0 22px; font-size:clamp(42px,5.3vw,66px); line-height:1.08; letter-spacing:-.055em; font-weight:650; }
  .welcome-copy h1 span { color:var(--color-brand); }
  .welcome-description { font-size:16px; color:var(--color-muted); line-height:1.9; margin:0; }
  .welcome-signin { margin-top:32px; max-width:340px; }
  .welcome-signin > p { font-size:11px; color:var(--color-muted); margin:13px 0 0; }
  .welcome-art { position:relative; height:430px; min-width:0; display:flex; align-items:center; justify-content:center; }
  .art-orbit { position:absolute; border:1px solid var(--color-line); border-radius:50%; width:390px; height:390px; max-width:100%; }
  .orbit-two { width:290px; height:290px; background:var(--color-brand-soft); border:0; }
  .art-label { position:absolute; top:6px; font-size:10px; font-weight:650; letter-spacing:.09em; color:var(--color-muted); text-transform:uppercase; display:flex; align-items:center; gap:7px; }
  .art-label > span, .sample-dot { width:6px; height:6px; border-radius:50%; background:var(--color-brand); }
  .sample-message { position:absolute; border:1px solid var(--color-line); border-radius:18px; background:var(--color-surface); box-shadow:0 12px 40px #172b2d0c; }
  .sample-back { top:53px; right:0; width:85%; padding:19px; display:flex; align-items:center; gap:12px; transform:rotate(5deg); }
  .sample-back > :global(svg) { margin-left:auto; color:var(--color-brand); flex-shrink:0; }
  .sample-message strong { display:block; font-size:12px; font-weight:650; }
  .sample-message div > span:not(.sample-avatar):not(.sample-dot):not(.sun):not(.hill):not(.landscape-label) { font-size:10px; color:var(--color-muted); }
  .sample-avatar { display:grid; place-items:center; width:38px; height:38px; border-radius:12px; background:var(--color-brand-soft); color:var(--color-brand); flex-shrink:0; }
  .sample-front { top:135px; left:0; width:86%; overflow:hidden; transform:rotate(-4deg); }
  .sample-top { padding:17px; display:flex; align-items:center; gap:11px; }
  .sample-dot { margin-left:auto; }
  .sample-landscape { height:130px; position:relative; overflow:hidden; background:var(--color-brand-soft); }
  .sun { position:absolute; top:18px; right:60px; width:36px; height:36px; border-radius:50%; background:var(--color-surface); }
  .hill { position:absolute; width:360px; height:180px; border-radius:50%; }
  .hill-one { background:var(--color-brand); opacity:.25; left:-80px; top:50px; transform:rotate(-15deg); }
  .hill-two { background:var(--color-brand-strong); left:90px; top:65px; transform:rotate(-20deg); }
  .landscape-label { position:absolute; bottom:16px; left:20px; color:white; font-size:19px; font-family:Georgia,serif; }
  .sample-lines { display:grid; gap:8px; padding:20px; }
  .sample-lines span { display:block; height:6px; width:90%; border-radius:4px; background:var(--color-line); }
  .sample-lines span:last-child { width:65%; }
  .permission-note { position:absolute; bottom:2px; right:0; padding:12px 18px; display:flex; align-items:center; gap:9px; border:1px solid var(--color-line); border-radius:12px; background:var(--color-surface); color:var(--color-brand-strong); font-size:11px; font-weight:650; box-shadow:0 6px 25px #172b2d08; }
  .welcome-principles { display:grid; grid-template-columns:repeat(3,1fr); gap:32px; padding:32px 0 10px; border-top:1px solid var(--color-line); }
  .welcome-principles > div { display:grid; grid-template-columns:auto 1fr; align-items:baseline; column-gap:14px; }
  .welcome-principles span { color:var(--color-brand); font-size:11px; font-weight:600; }
  .welcome-principles strong { font-size:13px; }
  .welcome-principles p { grid-column:2; margin:7px 0 0; font-size:12px; color:var(--color-muted); }
  .feed-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:20px; margin-bottom:32px; }
  .feed-heading .hail-eyebrow { margin-bottom:12px; }
  .feed-description { margin:12px 0 0; font-size:14px; color:var(--color-muted); }
  .feed-layout { display:grid; grid-template-columns:minmax(0,1fr) 218px; gap:32px; align-items:start; }
  .feed-aside { margin-top:0; padding:24px 0 24px 24px; border-left:1px solid var(--color-line); }
  .aside-heading { display:flex; align-items:center; gap:7px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--color-brand); }
  .feed-aside h2 { font-size:21px; line-height:1.4; letter-spacing:-.03em; margin:18px 0 12px; font-weight:600; }
  .feed-aside p { font-size:12px; line-height:1.8; color:var(--color-muted); margin:0 0 20px; }
  .feed-aside a { display:flex; align-items:center; gap:7px; min-height:44px; font-size:11px; font-weight:650; color:var(--color-brand-strong); text-decoration:none; }
  .feed-aside a:hover { text-decoration:underline; }
  .empty-symbol { display:grid; place-items:center; width:76px; height:76px; margin-bottom:14px; border:10px solid var(--color-canvas); border-radius:26px; background:var(--color-brand-soft); color:var(--color-brand); }
  @media(max-width:1200px) { .feed-layout { grid-template-columns:minmax(0,1fr); max-width:780px; margin:0 auto; } .feed-aside { display:none; } }
  @media(max-width:800px) { .welcome { gap:28px; } .welcome-art { height:370px; } .sample-front { top:120px; } .sample-back { padding:12px; } .sample-back > :global(svg) { display:none; } .welcome-principles { gap:18px; } }
  @media(max-width:640px) { .welcome { grid-template-columns:1fr; padding:10px 0 35px; gap:28px; } .welcome-copy { padding-top:0; } .welcome-copy h1 { font-size:clamp(38px, 12vw, 48px); } .welcome-description { font-size:14px; } .welcome-signin { max-width:none; margin-top:26px; } .welcome-art { height:355px; max-width:380px; width:100%; margin:0 auto; } .sample-front { top:100px; } .sample-back { top:40px; } .welcome-principles { grid-template-columns:1fr; gap:24px; } .feed-heading { gap:16px; margin-bottom:20px; } }
</style>
