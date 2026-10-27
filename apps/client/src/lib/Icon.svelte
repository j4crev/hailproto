<script lang="ts">
  let {name, size = 20}: {name: string; size?: number} = $props();
  const paths: Record<string, string> = {
    'double-check': 'M18 6 7 17l-5-5 M22 6 11 17l-3-3',
    feed: 'M4 5h16v14H4z M4 9h16 M8 13h8 M8 16h5',
    chat: 'M4 4h16v12H9l-5 4z M8 8h8 M8 12h5',
    trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
    sent: 'm3 11 18-8-8 18-3-8-7-2Z M10 13 21 3',
    people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 8l2 2 3-3',
    settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
    shield: 'm12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Z m-4 9 3 3 5-5',
    user: 'M20 21v-2a7 7 0 0 0-14 0v2 M17 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    plus: 'M12 5v14 M5 12h14', menu: 'M4 6h16 M4 12h16 M4 18h16',
    close: 'm6 6 12 12 M6 18 18 6', arrow: 'M5 12h14 m-5-5 5 5-5 5',
    key: 'M14 7a5 5 0 1 1-3 9l-6 5H2v-3l6-6a5 5 0 0 1 6-5Z M15 10h.01',
    logout: 'M9 4H4v16h5 M9 12h12 m-4-4 4 4-4 4',
    chevron: 'm9 5 7 7-7 7', image: 'M3 3h18v18H3z m0 14 5-5 4 4 4-6 5 7 M8 7h.01'
  };
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.feed} /></svg>
