// Native detail page (TMDB metadata; Watch loads the source embed player).

const IMG = (p, size) => (p ? `https://image.tmdb.org/t/p/${size}${p}` : '');

function detailBackTo() { showBrowse(); }

async function showDetail(kind, id) {
  hideAll();
  $('detail').hidden = false;
  $('detail').replaceChildren(emptyMsg('Loading…'));
  const type = kind === 'movie' ? 'movie' : 'tv';
  let d;
  try {
    d = await tmdbGet(`/${type}/${id}`, { append_to_response: 'credits,videos,external_ids,watch/providers' });
  } catch { d = null; }
  if (!d || d.error || (!d.title && !d.name)) {
    $('detail').replaceChildren(detailHeaderBar(), emptyMsg('Could not load details (check your TMDB key).'));
    return;
  }
  renderDetail(kind, type, id, d);
}

function detailHeaderBar() {
  const bar = document.createElement('div');
  bar.className = 'detail-back';
  const back = document.createElement('button');
  back.textContent = '← Browse';
  back.onclick = detailBackTo;
  bar.append(back);
  return bar;
}

function renderDetail(kind, type, id, d) {
  const el = $('detail');
  const title = d.title || d.name;
  const year = (d.release_date || d.first_air_date || '').slice(0, 4);
  const rating = d.vote_average ? d.vote_average.toFixed(1) : null;
  const genres = (d.genres || []).map((g) => g.name);
  const trailer = (d.videos?.results || []).find((v) => v.site === 'YouTube' && /Trailer|Teaser/i.test(v.type))
    || (d.videos?.results || []).find((v) => v.site === 'YouTube');

  // hero
  const hero = document.createElement('div');
  hero.className = 'detail-hero';
  if (d.backdrop_path) hero.style.backgroundImage = `linear-gradient(to right, rgba(20,22,26,.96), rgba(20,22,26,.55)), url(${IMG(d.backdrop_path, 'w1280')})`;

  const poster = document.createElement('img');
  poster.className = 'detail-poster';
  poster.src = IMG(d.poster_path, 'w342');
  poster.onerror = () => poster.remove();

  const info = document.createElement('div');
  info.className = 'detail-info';
  const h = document.createElement('h1');
  h.textContent = title;
  info.append(h);
  if (d.tagline) { const t = document.createElement('div'); t.className = 'detail-tagline'; t.textContent = `“${d.tagline}”`; info.append(t); }

  const meta = document.createElement('div');
  meta.className = 'detail-meta';
  const bits = [];
  if (year) bits.push(year);
  if (type === 'tv') { if (d.number_of_seasons) bits.push(`${d.number_of_seasons} Season${d.number_of_seasons > 1 ? 's' : ''}`); if (d.number_of_episodes) bits.push(`${d.number_of_episodes} Episodes`); }
  else if (d.runtime) bits.push(`${d.runtime}m`);
  if (rating) bits.push(`★ ${rating}`);
  meta.textContent = bits.join('  ·  ');
  info.append(meta);
  if (genres.length) { const g = document.createElement('div'); g.className = 'detail-genres'; g.append(...genres.map((n) => { const s = document.createElement('span'); s.textContent = n; return s; })); info.append(g); }

  // TV: season + episode selectors bound to the Watch button
  let curSeason = type === 'tv' ? ((d.seasons || []).find((s) => s.season_number > 0)?.season_number ?? 1) : null;
  let curEpisode = type === 'tv' ? 1 : null;

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  const playSrcs = sourcesFor(kind);
  if (playSrcs.length > 1) {
    const srcSel = document.createElement('select');
    srcSel.className = 'detail-source';
    srcSel.title = 'Source';
    srcSel.append(...playSrcs.map((s) => {
      const o = document.createElement('option');
      o.value = s.url; o.textContent = s.name;
      if (s.url === (defaultSource || lastSourceUrl)) o.selected = true;
      return o;
    }));
    actions.append(srcSel);
  }
  const watchBtn = document.createElement('button');
  watchBtn.className = 'btn-primary';
  const setWatchLabel = () => { watchBtn.textContent = type === 'tv' ? `▶ Watch S${curSeason}E${curEpisode}` : '▶ Watch'; };
  setWatchLabel();
  watchBtn.onclick = () => playOn(kind, type, id, curSeason, curEpisode);
  actions.append(watchBtn);
  if (trailer) {
    const tb = document.createElement('button');
    tb.textContent = '🎬 Trailer';
    tb.onclick = () => open(`https://www.youtube.com/embed/${trailer.key}?autoplay=1`);
    actions.append(tb);
  }
  const wl = document.createElement('button');
  wl.textContent = '+ Watch Later';
  wl.onclick = () => {
    const src = sourcesFor(kind)[0];
    const url = src ? buildUrl(src, type, id, curSeason, curEpisode) : `tmdb:${type}/${id}`;
    const key = mediaKey(url);
    later = later.filter((c) => c.key !== key);
    later.unshift({ key, title, url, poster: IMG(d.poster_path, 'w342'), season: curSeason, episode: curEpisode, type: kind === 'anime' ? 'tv' : type, addedAt: Date.now() });
    store('watchlater', later);
    wl.textContent = '✓ Added';
    setTimeout(() => { wl.textContent = '+ Watch Later'; }, 1500);
  };
  actions.append(wl);
  info.append(actions);

  hero.append(poster, info);
  el.replaceChildren(detailHeaderBar(), hero);

  // overview
  if (d.overview) {
    const ov = document.createElement('div');
    ov.className = 'detail-section';
    ov.innerHTML = '<h2>Overview</h2>';
    const p = document.createElement('p');
    p.textContent = d.overview;
    ov.append(p);
    el.append(ov);
  }

  // TV episodes
  if (type === 'tv') {
    const sec = document.createElement('div');
    sec.className = 'detail-section';
    const head = document.createElement('div');
    head.className = 'episodes-head';
    const hh = document.createElement('h2'); hh.textContent = 'Episodes';
    const sel = document.createElement('select');
    sel.className = 'season-select';
    for (const s of (d.seasons || []).filter((s) => s.season_number > 0)) {
      const o = document.createElement('option'); o.value = s.season_number; o.textContent = s.name || `Season ${s.season_number}`; sel.append(o);
    }
    sel.value = curSeason;
    head.append(hh, sel);
    sec.append(head);
    const epGrid = document.createElement('div');
    epGrid.className = 'episodes';
    sec.append(epGrid);
    el.append(sec);

    const loadSeason = async (n) => {
      curSeason = +n;
      epGrid.replaceChildren(emptyMsg('Loading…'));
      let s;
      try { s = await tmdbGet(`/tv/${id}/season/${n}`, {}); } catch { s = null; }
      epGrid.replaceChildren(...(s?.episodes || []).map((ep) => episodeCard(kind, type, id, ep, () => { curEpisode = ep.episode_number; setWatchLabel(); })));
    };
    sel.onchange = () => loadSeason(sel.value);
    loadSeason(curSeason);
  }

  // cast
  const cast = (d.credits?.cast || []).slice(0, 12);
  if (cast.length) {
    const sec = document.createElement('div');
    sec.className = 'detail-section';
    sec.innerHTML = '<h2>Cast</h2>';
    const row = document.createElement('div');
    row.className = 'cast-row';
    row.append(...cast.map((c) => {
      const card = document.createElement('div'); card.className = 'cast';
      const img = document.createElement('img'); img.src = IMG(c.profile_path, 'w185'); img.onerror = () => img.classList.add('noimg');
      const nm = document.createElement('div'); nm.className = 'cast-name'; nm.textContent = c.name;
      const ch = document.createElement('div'); ch.className = 'cast-char'; ch.textContent = c.character || '';
      card.append(img, nm, ch);
      return card;
    }));
    sec.append(row);
    el.append(sec);
  }

  // where to watch (legal providers)
  const provs = (d['watch/providers']?.results?.US || d['watch/providers']?.results?.GB || {});
  const flat = [...(provs.flatrate || []), ...(provs.free || []), ...(provs.ads || [])];
  if (flat.length) {
    const sec = document.createElement('div');
    sec.className = 'detail-section';
    sec.innerHTML = '<h2>Where to Watch</h2>';
    const row = document.createElement('div');
    row.className = 'providers';
    row.append(...flat.slice(0, 12).map((pv) => { const img = document.createElement('img'); img.src = IMG(pv.logo_path, 'w92'); img.title = pv.provider_name; return img; }));
    sec.append(row);
    el.append(sec);
  }
}

function episodeCard(kind, type, id, ep, onPick) {
  const el = document.createElement('div');
  el.className = 'episode';
  const still = document.createElement('img');
  still.src = IMG(ep.still_path, 'w300');
  still.onerror = () => still.classList.add('noimg');
  const body = document.createElement('div');
  body.className = 'episode-body';
  const t = document.createElement('div'); t.className = 'episode-title';
  t.textContent = `E${ep.episode_number} · ${ep.name || 'Episode ' + ep.episode_number}`;
  const ov = document.createElement('div'); ov.className = 'episode-ov'; ov.textContent = ep.overview || '';
  body.append(t, ov);
  el.append(still, body);
  el.onclick = () => { onPick(); playOn(kind, type, id, ep.season_number, ep.episode_number); };
  return el;
}
