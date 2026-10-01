import '../shared/explorations.js';

const nav = document.querySelector('.nav');
const chapters = [...document.querySelectorAll('[data-nav-tone]')];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const updateNav = () => {
  nav?.classList.toggle('is-scrolled', window.scrollY > 28);
  const current = chapters.find((chapter) => {
    const bounds = chapter.getBoundingClientRect();
    return bounds.top <= 72 && bounds.bottom > 72;
  });
  if (current) document.body.dataset.navTone = current.dataset.navTone;
};
updateNav();
window.addEventListener('scroll', updateNav, { passive: true });
window.addEventListener('hashchange', updateNav);
window.addEventListener('load', updateNav, { once: true });
requestAnimationFrame(() => requestAnimationFrame(updateNav));
setTimeout(updateNav, 600);

const toneObserver = new IntersectionObserver(
  (entries) => {
    const current = entries.find((entry) => entry.isIntersecting);
    if (current) document.body.dataset.navTone = current.target.dataset.navTone;
  },
  { rootMargin: '-8% 0px -82% 0px', threshold: 0 },
);
chapters.forEach((chapter) => toneObserver.observe(chapter));

if (!reduceMotion) {
  document.querySelectorAll('.source-list article').forEach((source, index) => {
    source.style.setProperty('--source-delay', `${index * 0.55}s`);
  });
}
