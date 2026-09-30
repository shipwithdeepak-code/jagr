const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

document.documentElement.classList.toggle('reduce-motion', reduceMotion);

const observed = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) entry.target.dataset.visible = 'true';
    }
  },
  { threshold: 0.16 },
);

document.querySelectorAll('[data-reveal]').forEach((element) => observed.observe(element));

if (!reduceMotion) {
  const updateScroll = () => {
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    document.documentElement.style.setProperty('--page-progress', String(scrollY / max));
    document.querySelectorAll('[data-scroll-stage]').forEach((element) => {
      const rect = element.getBoundingClientRect();
      const travel = innerHeight + rect.height;
      const progress = Math.max(0, Math.min(1, (innerHeight - rect.top) / travel));
      element.style.setProperty('--stage', String(progress));
    });
  };
  updateScroll();
  addEventListener('scroll', updateScroll, { passive: true });
  addEventListener('resize', updateScroll);
}

document.querySelectorAll('[data-filter-control]').forEach((button) => {
  button.addEventListener('click', () => {
    const container = button.closest('[data-filter-demo]');
    if (!container) return;
    const active = button.dataset.filterControl;
    container.dataset.filter = active;
    container.querySelectorAll('[data-filter-control]').forEach((item) => {
      item.setAttribute('aria-pressed', String(item === button));
    });
  });
});

document.querySelectorAll('[data-accordion-button]').forEach((button) => {
  button.addEventListener('click', () => {
    const item = button.closest('[data-accordion-item]');
    const open = item.dataset.open === 'true';
    item.dataset.open = String(!open);
    button.setAttribute('aria-expanded', String(!open));
  });
});

document.querySelectorAll('[data-year]').forEach((element) => {
  element.textContent = String(new Date().getFullYear());
});
