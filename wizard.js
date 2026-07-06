// Step-by-step "Add player / source" modal wizard, with a per-field hover example + live preview.

function openAddWizard() {
  const data = { name: '', category: 'vod', url: '', template: '', catalogUrl: '' };
  let i = 0;
  const wiz = $('wizard');
  const close = () => { wiz.hidden = true; wiz.replaceChildren(); };

  const urlStep = {
    key: 'url', title: 'Paste the address', label: 'The player or site web address', placeholder: 'https://example-player.com',
    example: 'The site that hosts the embed player. Example: https://example-player.com',
    valid: () => /\./.test(data.url.trim()) };
  const steps = () => {
    const s = [
      { key: 'name', title: 'Name it', label: 'What do you want to call this?', placeholder: 'e.g. My Player',
        example: 'A short label shown in your list and the source picker. Example: “My Player”.',
        valid: () => data.name.trim().length > 0 },
      { key: 'category', title: 'Pick a type', label: 'What kind of source is this?',
        example: 'Movies/TV & Anime play through an embed pattern. Live TV is a website or a built-in catalog.',
        choices: [['vod', 'Movies / TV Shows'], ['anime', 'Anime'], ['live', 'Live TV']] },
    ];
    if (data.category === 'live') {
      s.push({
        key: 'liveKind', title: 'Live source', label: 'How do you want to add this live source?',
        example: '“Live catalog” reads a JSON API of live streams (paste its URL) and lists them to click. “A website” just opens the site.',
        choices: [['site', 'A website (opens the site)'], ['catalog', 'Live catalog (JSON API)']] });
      s.push(data.liveKind === 'catalog'
        ? { key: 'catalogUrl', title: 'Catalog API URL', label: 'The JSON endpoint that lists live streams', placeholder: 'https://example.com/api/streams',
            example: 'Returns a list of streams, each with an embed URL. Example shape: { streams: [ { name, category, embed_url, thumbnail_url } ] }.',
            valid: () => /\./.test(data.catalogUrl.trim()) }
        : urlStep);
    } else {
      s.push(urlStep, {
        key: 'template', title: 'Watch-link pattern', label: 'How does it build a watch link? (optional)',
        placeholder: '{origin}/embed/{type}/{id}/{season}/{episode}', preview: true,
        example: 'Leave blank for the common /embed/ format. Tokens: {origin}=site · {type}=movie/tv · {id}=TMDB id · {season}/{episode} for TV (blank on movies).' });
    }
    return s;
  };

  const render = () => {
    const S = steps();
    if (i >= S.length) i = S.length - 1;
    const step = S[i], total = S.length, isLast = i === total - 1;

    const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
    const card = document.createElement('div'); card.className = 'wiz-card';

    const head = document.createElement('div'); head.className = 'wiz-head';
    const dots = document.createElement('div'); dots.className = 'wiz-dots';
    for (let d = 0; d < total; d++) { const dot = document.createElement('span'); if (d === i) dot.className = 'on'; dots.append(dot); }
    const count = document.createElement('span'); count.className = 'wiz-count'; count.textContent = `Step ${i + 1} of ${total}`;
    const x = document.createElement('button'); x.className = 'wiz-x'; x.textContent = '✕'; x.onclick = close;
    head.append(dots, count, x);
    const h = document.createElement('h3'); h.textContent = step.title;
    const label = document.createElement('div'); label.className = 'wiz-label'; label.textContent = step.label;
    card.append(head, h, label);

    // nav buttons created early so field handlers can toggle Next
    const nav = document.createElement('div'); nav.className = 'wiz-nav';
    const back = document.createElement('button'); back.className = 'wiz-back'; back.textContent = i === 0 ? 'Cancel' : 'Back';
    back.onclick = () => { if (i === 0) close(); else { i--; render(); } };
    const next = document.createElement('button'); next.className = 'wiz-next'; next.textContent = isLast ? 'Add' : 'Next';
    const isValid = () => (step.valid ? step.valid() : true);
    next.disabled = !isValid();
    next.onclick = () => { if (!isValid()) return; if (isLast) { addSource(data); close(); } else { i++; render(); } };
    nav.append(back, next);

    const field = document.createElement('div'); field.className = 'wiz-field';
    let prev;
    function updatePreview() {
      if (!prev) return;
      const src = { url: data.url.trim() || 'https://example-player.com', template: data.template.trim() || undefined };
      prev.textContent = `Preview ▸ Movie: ${buildUrl(src, 'movie', 27205)}  ·  TV S1E1: ${buildUrl(src, 'tv', 27205, 1, 1)}`;
    }
    if (step.choices) {
      const row = document.createElement('div'); row.className = 'wiz-choices';
      for (const [val, txt] of step.choices) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = txt;
        b.className = data[step.key] === val ? 'on' : '';
        b.onclick = () => { data[step.key] = val; render(); };
        row.append(b);
      }
      field.append(row);
    } else {
      const inp = document.createElement('input'); inp.className = 'wiz-input';
      inp.placeholder = step.placeholder || ''; inp.value = data[step.key] || '';
      inp.oninput = () => { data[step.key] = inp.value; next.disabled = !isValid(); updatePreview(); };
      inp.onkeydown = (e) => { if (e.key === 'Enter' && !next.disabled) next.click(); };
      field.append(inp);
      setTimeout(() => inp.focus(), 0);
    }
    const ex = document.createElement('div'); ex.className = 'wiz-example'; ex.textContent = step.example;
    field.append(ex);
    if (step.preview) { prev = document.createElement('div'); prev.className = 'wiz-preview'; field.append(prev); updatePreview(); }

    card.append(field, nav);
    overlay.append(card);
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    wiz.replaceChildren(overlay);
    wiz.hidden = false;
  };
  render();
}
