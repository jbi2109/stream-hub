// Shared horizontal-rail behavior: hidden scrollbar (CSS), hover chevrons, edge fades. One rail system
// for the dashboard rails, the detail recs/similar/cast/providers rails, and the person "Known For" rail.
// Operates on an existing rail element in a position:relative parent (chevrons absolute-anchor to it).
function wireRail(rail, { chevrons = true } = {}) {
  const parent = rail.parentElement;
  parent.classList.add('has-rail');                 // CSS reveals chevrons on hover of a has-rail parent
  let chevL, chevR;
  if (chevrons) {
    chevL = mk('button', 'rail-chev prev'); chevL.append(icon('chevron-l'));
    chevR = mk('button', 'rail-chev next'); chevR.append(icon('chevron-r'));
    const scrollBy = (dir) => rail.scrollBy({ left: dir * rail.clientWidth * 0.8, behavior: document.body.classList.contains('reduced-motion') ? 'auto' : 'smooth' });
    chevL.onclick = () => scrollBy(-1); chevR.onclick = () => scrollBy(1);
    parent.append(chevL, chevR);
  }
  let fadePending = false;
  const fades = () => {
    if (fadePending) return; fadePending = true;
    requestAnimationFrame(() => {
      fadePending = false;
      rail.classList.toggle('fade-l', rail.scrollLeft > 8);
      rail.classList.toggle('fade-r', rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 8);
      if (chevL) chevL.disabled = rail.scrollLeft <= 8;
      if (chevR) chevR.disabled = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 8;
    });
  };
  rail.onscroll = fades;
  new ResizeObserver(fades).observe(rail);
  return rail;
}
