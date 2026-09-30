import { useEffect, useMemo } from 'react';
import { useExploreLocally } from '@/state/exploreLocally';
import { serverApi } from '@/state/serverApi';
import { markSigningIn, useServerSession } from '@/state/serverSession';
import approvedDocument from './attention-day.production.html?raw';

function approvedMarkup() {
  const body = approvedDocument.match(/<body[^>]*>([\s\S]*?)<script type="module"/i)?.[1];
  if (!body) throw new Error('The approved Jagr homepage markup is missing its body.');
  return body;
}

/** The frozen public homepage. Product routes and workspace state remain owned by App.tsx. */
export function LandingPage() {
  const markup = useMemo(approvedMarkup, []);
  const session = useServerSession();
  const exploreLocally = useExploreLocally();
  const googleAvailable = session.checked && !!session.server?.signIn.includes('google');
  useEffect(() => {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/explorations/attention-day/attention-day.css';
    stylesheet.dataset.jagrPublic = 'approved-homepage';
    document.head.appendChild(stylesheet);
    document.body.classList.add('jagr-public-home');
    const nav = document.querySelector<HTMLElement>('[data-nav]');
    const menuButton = document.querySelector<HTMLButtonElement>('.menu-button');
    const mobileMenu = document.querySelector<HTMLElement>('.mobile-menu');
    const scenes = [...document.querySelectorAll<HTMLElement>('[data-scene]')];
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const paint = () => {
      nav?.classList.toggle('scrolled', window.scrollY > 24);
      const current = scenes.find((scene) => { const rect = scene.getBoundingClientRect(); return rect.top <= 64 && rect.bottom > 64; });
      if (current?.dataset.scene) document.body.dataset.scene = current.dataset.scene;
    };
    const setMenu = (open: boolean) => {
      menuButton?.setAttribute('aria-expanded', String(open));
      mobileMenu?.setAttribute('aria-hidden', String(!open));
      document.body.classList.toggle('menu-open', open);
      menuButton?.querySelector('span')?.replaceChildren(open ? 'Close' : 'Menu');
    };
    const toggleMenu = () => setMenu(menuButton?.getAttribute('aria-expanded') !== 'true');
    const closeMenu = () => setMenu(false);
    const escapeMenu = (event: KeyboardEvent) => { if (event.key === 'Escape') { closeMenu(); menuButton?.focus(); } };
    const resize = () => { paint(); if (window.innerWidth > 700) closeMenu(); };
    paint();
    window.addEventListener('scroll', paint, { passive: true });
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', escapeMenu);
    menuButton?.addEventListener('click', toggleMenu);
    const menuLinks = [...(mobileMenu?.querySelectorAll('a') ?? [])];
    menuLinks.forEach((link) => link.addEventListener('click', closeMenu));
    const observed: IntersectionObserver[] = [];
    const progressive = document.querySelectorAll<HTMLElement>('[data-progressive]');
    if (reduced || !('IntersectionObserver' in window)) progressive.forEach((item) => item.classList.add('is-visible'));
    else {
      const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); } }), { threshold: .03, rootMargin: '0px 0px 12% 0px' });
      progressive.forEach((item) => observer.observe(item));
      observed.push(observer);
    }
    const poster = document.querySelector<HTMLElement>('.investigation-poster');
    const closing = document.querySelector<HTMLElement>('[data-closing]');
    for (const [element, className, threshold] of [[poster, 'is-resolved', .1], [closing, 'is-visible', .15]] as const) {
      if (!element) continue;
      if (reduced || !('IntersectionObserver' in window)) element.classList.add(className);
      else {
        const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) { element.classList.add(className); observer.disconnect(); } }, { threshold });
        observer.observe(element);
        observed.push(observer);
        requestAnimationFrame(() => {
          const rect = element.getBoundingClientRect();
          if (rect.top < window.innerHeight * .9 && rect.bottom > window.innerHeight * .1) {
            element.classList.add(className);
            observer.disconnect();
          }
        });
      }
    }
    document.querySelectorAll<HTMLElement>('[data-year]').forEach((year) => year.replaceChildren(String(new Date().getFullYear())));
    return () => {
      window.removeEventListener('scroll', paint);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', escapeMenu);
      menuButton?.removeEventListener('click', toggleMenu);
      menuLinks.forEach((link) => link.removeEventListener('click', closeMenu));
      observed.forEach((observer) => observer.disconnect());
      stylesheet.remove();
      document.body.classList.remove('jagr-public-home', 'menu-open');
      delete document.body.dataset.scene;
    };
  }, []);
  useEffect(() => {
    const entries = [...document.querySelectorAll<HTMLAnchorElement>('[data-google-entry]')];
    entries.forEach((entry) => {
      entry.hidden = !googleAvailable;
      if (googleAvailable) {
        entry.href = serverApi.signInUrl('google', '/');
        entry.addEventListener('click', markSigningIn);
      }
    });
    return () => entries.forEach((entry) => entry.removeEventListener('click', markSigningIn));
  }, [googleAvailable]);
  useEffect(() => {
    const entries = [...document.querySelectorAll<HTMLButtonElement>('[data-local-entry]')];
    const open = () => exploreLocally('sample');
    entries.forEach((entry) => entry.addEventListener('click', open));
    return () => entries.forEach((entry) => entry.removeEventListener('click', open));
  }, [exploreLocally]);
  return <div className="approved-homepage" dangerouslySetInnerHTML={{ __html: markup }} />;
}
