// Native detail page (TMDB metadata; Watch loads the source embed player).

const IMG = (p, size) => (p ? `https://image.tmdb.org/t/p/${size}${p}` : '');
const fmtRuntime = (m) => m ? (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`) : '';

let detailOrigin = null;   // { kind, id } — where the person page returns to

// A horizontal poster rail (Recommendations / More Like This). Empty -> null so the caller hides it.
function detailRail(title, kind, items) {
  const rows = (items || []).filter((r) => r.poster_path || r.title || r.name).slice(0, 20);
  if (!rows.length) return null;                               // empty → hidden (house style)
  const sec = mk('div', 'detail-section'); sec.append(mk('h2', null, title));
  const rail = mk('div', 'detail-rail'); rail.append(...rows.map((r) => posterCard(kind, r)));
  sec.append(rail); wireRail(rail); return sec;
}

// Photos lightbox — a single module-level overlay; Esc closes it via keyboard.js's chain.
let lightboxEl = null;
function openLightbox(shots, i) {
  closeLightbox();
  const ov = mk('div', 'modal-overlay lightbox');
  const img = document.createElement('img'); img.src = IMG(shots[i].file_path, 'w1280');
  const close = mk('button', 'lightbox-close', '×'); close.onclick = closeLightbox; close.setAttribute('aria-label', 'Close');
  ov.append(img, close);
  ov.onclick = (e) => { if (e.target === ov) closeLightbox(); };   // click backdrop to close
  document.body.append(ov); lightboxEl = ov;
}
function closeLightbox() { if (lightboxEl) { lightboxEl.remove(); lightboxEl = null; } }

// Genre chip -> browse that genre. Anime detail carries type='tv' (TV genre-ids -> TV tab).
function openGenre(type, g) {
  const tab = type === 'movie' ? 'movie' : 'tv';
  browseTab = tab; browseFilters = loadFiltersFor(tab);
  browseFilters.genre = String(g.id);
  browseFiltersAll[tab] = browseFilters; store('browseFilters', browseFiltersAll);
  browsePage = 1; showBrowse();
}

function detailBackTo() { showBrowse(); }

// Shared Watch-Later add for a KNOWN TMDB id (detail page + hover preview). Mirrors the detail WL
// button's exact semantics: buildUrl via the first source (tmdb: fallback), dedupe by key, anime->tv.
// (app.js's topbar handler adds the CURRENT webview page — a different shape — so it does NOT use this.)
function addLater(kind, type, id, title, poster, season = null, episode = null) {
  const src = sourcesFor(kind)[0];
  const url = src ? buildUrl(src, type, id, season, episode) : `tmdb:${type}/${id}`;
  const key = mediaKey(url);
  later = later.filter((c) => c.key !== key);
  later.unshift({ key, title, url, poster, season, episode, type: kind === 'anime' ? 'tv' : type, addedAt: Date.now() });
  store('watchlater', later); toast(`Added to Watch Later — ${title}`);
}

async function showDetail(kind, id) {
  hideAll();
  $('detail').hidden = false;
  $('detail').replaceChildren(stateNode('loading', 'Loading…'));
  const type = kind === 'movie' ? 'movie' : 'tv';
  let d;
  try {
    // include_image_language is required or TMDB omits logos from the images append
    d = await tmdbGet(`/${type}/${id}`, { append_to_response: 'credits,videos,external_ids,watch/providers,images,recommendations,similar', include_image_language: 'en,null' });
  } catch { d = null; }
  if (!d || d.error || (!d.title && !d.name)) {
    $('detail').replaceChildren(detailHeaderBar(), stateNode('error', 'Could not load details (check your TMDB key).'));
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
  detailOrigin = { kind, id };
  const el = $('detail');
  const title = d.title || d.name;
  const posterUrl = IMG(d.poster_path, 'w342'); // carried into openOn so capture uses the TMDB title/poster
  const year = (d.release_date || d.first_air_date || '').slice(0, 4);
  const rating = d.vote_average ? d.vote_average.toFixed(1) : null;
  const trailer = (d.videos?.results || []).find((v) => v.site === 'YouTube' && /Trailer|Teaser/i.test(v.type))
    || (d.videos?.results || []).find((v) => v.site === 'YouTube');

  // cinematic backdrop: a sticky full-bleed layer the content scrolls over. It lives INSIDE
  // renderDetail's children (never on #detail itself) so the live source page — which shares this
  // container — replaceChildren's it away for free. #detail is the scroll box (body never scrolls).
  const backdrop = mk('div', 'detail-backdrop');
  if (d.backdrop_path) {
    const bimg = document.createElement('img');
    bimg.src = IMG(d.backdrop_path, 'w1280');
    bimg.alt = '';
    bimg.onerror = () => { bimg.style.display = 'none'; }; // hide, don't remove — the panel bg covers
    backdrop.append(bimg);
  }
  const cover = mk('div', 'detail-cover'); // fades in with scroll, settling the page onto --bg
  backdrop.append(cover);

  // hero content block (scrolls over the backdrop)
  const hero = document.createElement('div');
  hero.className = 'detail-hero';

  const poster = document.createElement('img');
  poster.className = 'detail-poster';
  poster.src = IMG(d.poster_path, 'w342');
  poster.onerror = () => poster.remove();

  const info = document.createElement('div');
  info.className = 'detail-info';
  // TMDB logo art over the (kept, visually-hidden) h1 — the h1 is the fallback + accessible title
  const logo = (d.images?.logos || []).find((l) => l.iso_639_1 === 'en') || (d.images?.logos || [])[0];
  if (logo && logo.file_path) {
    const li = document.createElement('img');
    li.className = 'detail-logo';
    li.src = IMG(logo.file_path, 'w500');
    li.alt = title;
    li.onerror = () => { li.classList.add('dead'); li.style.display = 'none'; }; // sibling CSS un-hides the h1
    info.append(li);
  }
  const h = document.createElement('h1');
  h.textContent = title;
  info.append(h);
  if (d.tagline) { const t = document.createElement('div'); t.className = 'detail-tagline'; t.textContent = `“${d.tagline}”`; info.append(t); }

  const meta = document.createElement('div');
  meta.className = 'detail-meta';
  const bits = [];
  if (year) bits.push(year);
  if (type === 'tv') { if (d.number_of_seasons) bits.push(`${d.number_of_seasons} Season${d.number_of_seasons > 1 ? 's' : ''}`); if (d.number_of_episodes) bits.push(`${d.number_of_episodes} Episodes`); }
  else if (d.runtime) bits.push(fmtRuntime(d.runtime));
  if (rating) bits.push(`★ ${rating}`);
  meta.textContent = bits.join('  ·  ');
  info.append(meta);
  const who = type === 'movie' ? (d.credits?.crew || []).find((c) => c.job === 'Director') : (d.created_by || [])[0];
  if (who) info.append(mk('div', 'detail-crew', `${type === 'movie' ? 'Director' : 'Creator'}: ${who.name}`));
  if ((d.genres || []).length) {
    const g = document.createElement('div'); g.className = 'detail-genres';
    g.append(...d.genres.map((gen) => {
      const s = document.createElement('span'); s.textContent = gen.name; s.tabIndex = 0;
      s.onclick = () => openGenre(type, gen);
      s.onkeydown = (e) => { if (e.key === 'Enter') openGenre(type, gen); };
      return s;
    }));
    info.append(g);
  }

  // TV: season + episode selectors bound to the Watch button
  let curSeason = type === 'tv' ? ((d.seasons || []).find((s) => s.season_number > 0)?.season_number ?? 1) : null;
  let curEpisode = type === 'tv' ? 1 : null;

  const playSrcs = sourcesFor(kind);
  // the source the app already treats as default (URL-keyed globals: defaultSource picked in Settings,
  // else last-watched, else the first available) — mirrors sources.js's playingSource() resolution.
  const defSrc = playSrcs.find((s) => s.url === defaultSource) || playSrcs.find((s) => s.url === lastSourceUrl) || playSrcs[0];
  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  // ▶ Play is the loud primary action — FIRST child, routes straight to the default source.
  const playBtn = mk('button', 'detail-play');
  playBtn.append(icon('play'), document.createTextNode(type === 'tv' ? ` Play S${curSeason} E${curEpisode}` : ' Play'));
  if (defSrc) playBtn.onclick = () => openOn(defSrc, kind, type, id, curSeason, curEpisode, title, posterUrl); // closure reads live curSeason/curEpisode
  else { playBtn.disabled = true; playBtn.title = 'Add a source in Settings first'; }
  actions.append(playBtn);
  if (trailer) {
    const tb = document.createElement('button');
    tb.append(icon('play'), document.createTextNode(' Trailer')); // word kept — selected by text (users + e2e)
    tb.onclick = () => open(`https://www.youtube.com/embed/${trailer.key}?autoplay=${settings.autoplayTrailers === false ? 0 : 1}`);
    actions.append(tb);
  }
  const wl = document.createElement('button');
  wl.textContent = '+ Watch Later';
  wl.onclick = () => addLater(kind, type, id, title, posterUrl, curSeason, curEpisode);
  actions.append(wl);
  if (!playSrcs.length) { // no source at all → give a way out instead of a dead disabled button
    const hint = mk('span', 'detail-play-hint', 'Add a source in Settings to watch');
    hint.style.cursor = 'pointer'; hint.onclick = () => showSettings();
    actions.append(hint);
  }
  info.append(actions);

  hero.append(poster, info);
  el.replaceChildren(backdrop, detailHeaderBar(), hero);

  // scroll-linked cover + topbar blend — self-cleaning: the next render (or the live picker)
  // replaceChildren's the backdrop away, and the handler unhooks itself when that happens.
  const topbar = $('topbar');
  const onDetailScroll = () => {
    if (!backdrop.isConnected) { el.onscroll = null; topbar.classList.remove('at-top'); return; }
    cover.style.opacity = Math.min(el.scrollTop / 500, 1);
    topbar.classList.toggle('at-top', el.scrollTop < 40);
  };
  el.onscroll = onDetailScroll;
  el.scrollTop = 0;
  onDetailScroll();

  // "Watch on" source list (replaces the source dropdown): pick a player to watch the current title/episode.
  const watchSec = document.createElement('div'); watchSec.className = 'detail-section';
  const wh = document.createElement('h2'); wh.textContent = 'Watch on'; watchSec.append(wh);
  watchSec.append(sourceList([{ name: '', rows: playSrcs.map((s) => ({
    label: s.name,
    onPick: () => openOn(s, kind, type, id, curSeason, curEpisode, title, posterUrl),
  })) }]));
  el.append(watchSec);

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
      epGrid.replaceChildren(...skeletonCards(4, 'skel-episode'));
      let s;
      try { s = await tmdbGet(`/tv/${id}/season/${n}`, {}); } catch { s = null; }
      epGrid.replaceChildren(...(s?.episodes || []).map((ep) => episodeCard(kind, type, id, ep, () => { curSeason = ep.season_number; curEpisode = ep.episode_number; }, title, posterUrl)));
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
      const castCard = document.createElement('div'); castCard.className = 'cast';
      castCard.tabIndex = 0; castCard.onclick = () => showPerson(c.id);
      const img = document.createElement('img'); img.loading = 'lazy'; img.src = IMG(c.profile_path, 'w185'); img.onerror = () => img.classList.add('noimg');
      const nm = document.createElement('div'); nm.className = 'cast-name'; nm.textContent = c.name;
      const ch = document.createElement('div'); ch.className = 'cast-char'; ch.textContent = c.character || '';
      castCard.append(img, nm, ch);
      return castCard;
    }));
    sec.append(row);
    wireRail(row);
    el.append(sec);
  }

  // where to watch (legal providers) — prefer the user's region, then US/GB
  const wp = d['watch/providers']?.results || {};
  const provs = wp[settings.watchRegion] || wp.US || wp.GB || {};
  const flat = [...(provs.flatrate || []), ...(provs.free || []), ...(provs.ads || [])];
  if (flat.length) {
    const sec = document.createElement('div');
    sec.className = 'detail-section';
    sec.innerHTML = '<h2>Where to Watch</h2>';
    const row = document.createElement('div');
    row.className = 'providers';
    row.append(...flat.slice(0, 12).map((pv) => { const img = document.createElement('img'); img.src = IMG(pv.logo_path, 'w92'); img.title = pv.provider_name; return img; }));
    sec.append(row);
    wireRail(row);
    el.append(sec);
  }

  // photos (backdrops) -> lightbox
  const shots = (d.images?.backdrops || []).filter((b) => b.file_path).slice(0, 12);
  if (shots.length) {
    const sec = mk('div', 'detail-section'); sec.append(mk('h2', null, 'Photos'));
    const grid = mk('div', 'detail-photos');
    grid.append(...shots.map((b, i) => {
      const img = document.createElement('img'); img.loading = 'lazy'; img.src = IMG(b.file_path, 'w780');
      img.onerror = function () { this.onerror = null; this.removeAttribute('src'); this.classList.add('noimg'); }; // keep the el (clickable) — no torn-image glyph
      img.onclick = () => openLightbox(shots, i);
      return img;
    }));
    sec.append(grid); el.append(sec);
  }

  // recommendations + more-like-this rails (empty -> hidden)
  const recSec = detailRail('Recommendations', kind, d.recommendations?.results);
  if (recSec) el.append(recSec);
  const simSec = detailRail('More Like This', kind, d.similar?.results);
  if (simSec) el.append(simSec);
}

function episodeCard(kind, type, id, ep, onPick, title, poster) {
  const el = document.createElement('div');
  el.className = 'episode';
  el.tabIndex = 0;
  const still = document.createElement('img');
  still.loading = 'lazy';
  still.src = IMG(ep.still_path, 'w300');
  still.onerror = () => still.classList.add('noimg');
  const body = document.createElement('div');
  body.className = 'episode-body';
  const t = document.createElement('div'); t.className = 'episode-title';
  t.textContent = `E${ep.episode_number} · ${ep.name || 'Episode ' + ep.episode_number}`;
  const ov = document.createElement('div'); ov.className = 'episode-ov'; ov.textContent = ep.overview || '';
  body.append(t, ov);
  el.append(still, body);
  const unaired = ep.air_date && Date.parse(ep.air_date) > Date.now();   // unknown air_date → treated as aired
  if (unaired) { el.classList.add('unaired'); body.append(mk('span', 'ep-chip', 'Coming Soon')); }
  // Select the episode (highlight) — the "Watch on" source list then plays the selected episode.
  if (!unaired) {
    el.onclick = () => {
      [...el.parentElement.children].forEach((c) => c.classList.remove('selected'));
      el.classList.add('selected');
      onPick();
    };
  }
  return el;
}

function personBackBar() {
  const bar = mk('div', 'detail-back');
  const back = document.createElement('button');
  back.textContent = '← Back';
  back.onclick = () => { detailOrigin ? showDetail(detailOrigin.kind, detailOrigin.id) : showBrowse(); };
  bar.append(back); return bar;
}
async function showPerson(id) {
  hideAll(); $('person').hidden = false;
  $('person').replaceChildren(stateNode('loading', 'Loading…'));
  let d; try { d = await tmdbGet(`/person/${id}`, { append_to_response: 'combined_credits,images' }); } catch { d = null; }
  if (!d || d.error || !d.name) { $('person').replaceChildren(personBackBar(), stateNode('error', 'Could not load this person.')); return; }
  renderPerson(d);
}
function renderPerson(d) {
  const el = $('person');
  const header = mk('div', 'person-header');
  const photo = document.createElement('img'); photo.className = 'person-photo';
  photo.src = IMG((d.images?.profiles?.[0]?.file_path) || d.profile_path, 'w342');
  photo.onerror = () => photo.remove();
  const info = mk('div', 'person-info');
  info.append(mk('h1', null, d.name));
  if (d.known_for_department) info.append(mk('div', 'person-role', d.known_for_department));
  if (d.biography) info.append(mk('p', 'person-bio', d.biography.slice(0, 600)));
  header.append(photo, info);
  el.replaceChildren(personBackBar(), header);
  // "Known For" rail — combined credits mix movie + tv, so each card MUST route to its own media_type
  // (do NOT use detailRail, which forces one kind). Dedupe by id, sort by popularity.
  const cast = (d.combined_credits?.cast || []).filter((c) => c.poster_path && (c.media_type === 'movie' || c.media_type === 'tv'));
  const seen = new Set(); const uniq = cast.filter((c) => !seen.has(c.id) && seen.add(c.id)).sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  if (uniq.length) {
    const sec = mk('div', 'detail-section'); sec.append(mk('h2', null, 'Known For'));
    const rail = mk('div', 'detail-rail');
    rail.append(...uniq.slice(0, 20).map((c) => posterCard(c.media_type, c)));   // per-card kind → correct showDetail
    sec.append(rail); wireRail(rail); el.append(sec);
  }
}
