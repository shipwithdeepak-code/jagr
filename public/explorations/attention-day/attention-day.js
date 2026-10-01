import '../shared/explorations.js';

const nav = document.querySelector('[data-nav]');
const menuButton = document.querySelector('.menu-button');
const mobileMenu = document.querySelector('.mobile-menu');
const scenes = [...document.querySelectorAll('[data-scene]')];
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const paint = () => {
  nav?.classList.toggle('scrolled', window.scrollY > 24);
  const current = scenes.find((scene) => {
    const rect = scene.getBoundingClientRect();
    return rect.top <= 64 && rect.bottom > 64;
  });
  if (current) document.body.dataset.scene = current.dataset.scene;
};

paint();
window.addEventListener('scroll', paint, { passive: true });
window.addEventListener('resize', paint);

const setMenu = (open) => {
  menuButton?.setAttribute('aria-expanded', String(open));
  mobileMenu?.setAttribute('aria-hidden', String(!open));
  document.body.classList.toggle('menu-open', open);
  menuButton?.querySelector('span')?.replaceChildren(open ? 'Close' : 'Menu');
};

menuButton?.addEventListener('click', () => setMenu(menuButton.getAttribute('aria-expanded') !== 'true'));
mobileMenu?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setMenu(false)));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menuButton?.getAttribute('aria-expanded') === 'true') {
    setMenu(false);
    menuButton.focus();
  }
});
window.addEventListener('resize', () => {
  if (window.innerWidth > 700) setMenu(false);
});

if (!reduced) {
  const details = document.querySelectorAll('.workstream li');
  details.forEach((item, index) => item.style.setProperty('--delay', `${index * .65}s`));
}

const progressive = document.querySelectorAll('[data-progressive]');
if (reduced || !('IntersectionObserver' in window)) {
  progressive.forEach((item) => item.classList.add('is-visible'));
} else {
  const progressiveObserver = new IntersectionObserver(
    (entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        progressiveObserver.unobserve(entry.target);
      }
    }),
    { threshold: .03, rootMargin: '0px 0px 12% 0px' },
  );
progressive.forEach((item) => progressiveObserver.observe(item));
}

const investigationPoster = document.querySelector('.investigation-poster');
if (investigationPoster) {
  if (reduced || !('IntersectionObserver' in window)) {
    investigationPoster.classList.add('is-resolved');
  } else {
    const resolveInvestigation = () => investigationPoster.classList.add('is-resolved');
    const investigationObserver = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      resolveInvestigation();
      investigationObserver.disconnect();
    }, { threshold: .1 });
    investigationObserver.observe(investigationPoster);
    requestAnimationFrame(() => {
      const rect = investigationPoster.getBoundingClientRect();
      if (rect.top < window.innerHeight * .9 && rect.bottom > window.innerHeight * .1) {
        resolveInvestigation();
        investigationObserver.disconnect();
      }
    });
  }
}

const closing = document.querySelector('[data-closing]');
if (closing) {
  if (reduced || !('IntersectionObserver' in window)) {
    closing.classList.add('is-visible');
  } else {
    const closingObserver = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      closing.classList.add('is-visible');
      closingObserver.disconnect();
    }, { threshold: .15 });
    closingObserver.observe(closing);
  }
}
