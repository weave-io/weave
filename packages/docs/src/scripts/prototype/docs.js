/* Weave — docs behaviors: copy buttons, command palette, TOC scrollspy. */
(function () {
  /* ---------------- copy buttons ---------------- */
  document.addEventListener('click', (e) => {
    const button = e.target.closest('[data-copy]');
    if (!button) return;
    const element = document.querySelector(button.getAttribute('data-copy'));
    if (!element) return;
    navigator.clipboard.writeText(element.innerText.replace(/\n$/, '')).then(() => {
      const oldText = button.textContent;
      button.textContent = '✓ copied';
      setTimeout(() => {
        button.textContent = oldText;
      }, 1400);
    });
  });

  /* ---------------- command palette ---------------- */
  const palette = document.getElementById('palette');
  if (palette) {
    const input = document.getElementById('paletteInput');
    const resultsEl = document.getElementById('paletteResults');
    const trigger = document.getElementById('searchTrigger');
    const ICON = {
      page: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5"/></svg>',
      spec: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l4 4v14H7z"/><path d="M13 3v5h5M10 13h5M10 17h5"/></svg>'
    };
    /* Real-route search data is injected by the PageFrame override as a
       `<script id="paletteData" type="application/json">` block with
       base-path-resolved hrefs. Read and parse it; fall back to a minimal
       built-in set if the element is missing or malformed so the palette is
       never empty. */
    const FALLBACK_DATA = [
      { g: 'Pages', t: 'Introduction', s: 'get started', href: 'docs/', ic: 'page' },
      { g: 'Pages', t: 'Workflows', s: 'core dsl · the DAG model', href: 'docs/workflows/', ic: 'page' }
    ];
    const loadData = () => {
      const node = document.getElementById('paletteData');
      if (!node) return FALLBACK_DATA;
      try {
        const parsed = JSON.parse(node.textContent || '');
        return Array.isArray(parsed) && parsed.length ? parsed : FALLBACK_DATA;
      } catch {
        return FALLBACK_DATA;
      }
    };
    const DATA = loadData();
    let sel = 0;

    const render = (query) => {
      const q = (query || '').toLowerCase().trim();
      const filtered = DATA.filter((d) => {
        return !q || `${d.t} ${d.s}`.toLowerCase().indexOf(q) !== -1;
      });
      sel = 0;
      let html = '';
      let lastG = null;
      if (!filtered.length) {
        resultsEl.innerHTML = '<div class="grp">no matches</div>';
        return;
      }
      filtered.forEach((d, i) => {
        if (d.g !== lastG) {
          html += `<div class="grp">${d.g}</div>`;
          lastG = d.g;
        }
        html += `<div class="res${i === 0 ? ' sel' : ''}" data-i="${i}" data-href="${d.href}">` +
          `<span class="ic">${ICON[d.ic]}</span>` +
          `<span class="t"><b>${d.t}</b><span>${d.s}</span></span></div>`;
      });
      resultsEl.innerHTML = html;
    };
    const scrollSel = (node) => {
      const box = resultsEl.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      if (rect.bottom > box.bottom) resultsEl.scrollTop += rect.bottom - box.bottom;
      else if (rect.top < box.top) resultsEl.scrollTop -= box.top - rect.top;
    };
    const move = (dir) => {
      const nodes = resultsEl.querySelectorAll('.res');
      if (!nodes.length) return;
      const previous = nodes[sel];
      if (previous) previous.classList.remove('sel');
      sel = (sel + dir + nodes.length) % nodes.length;
      const selected = nodes[sel];
      selected.classList.add('sel');
      if (selected.scrollIntoView) scrollSel(selected);
    };
    const open = () => {
      palette.classList.add('open');
      render('');
      input.value = '';
      setTimeout(() => {
        input.focus();
      }, 30);
    };
    const close = () => {
      palette.classList.remove('open');
    };
    const go = () => {
      const nodes = resultsEl.querySelectorAll('.res');
      if (nodes[sel]) window.location.href = nodes[sel].getAttribute('data-href');
    };

    if (trigger) trigger.addEventListener('click', open);
    input.addEventListener('input', () => {
      render(input.value);
    });
    resultsEl.addEventListener('mousemove', (e) => {
      const result = e.target.closest('.res');
      if (!result) return;
      const nodes = resultsEl.querySelectorAll('.res');
      const previous = nodes[sel];
      if (previous) previous.classList.remove('sel');
      sel = +result.getAttribute('data-i');
      result.classList.add('sel');
    });
    resultsEl.addEventListener('click', (e) => {
      if (e.target.closest('.res')) go();
    });
    palette.addEventListener('click', (e) => {
      if (e.target === palette) close();
    });
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (palette.classList.contains('open')) close();
        else open();
        return;
      }
      if (!palette.classList.contains('open')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        go();
      }
    });
  }

  /* ---------------- TOC scrollspy ---------------- */
  const toc = document.querySelector('.toc ul');
  if (toc) {
    const links = Array.prototype.slice.call(toc.querySelectorAll('a'));
    const map = {};
    const targets = links.map((link) => {
      const id = link.getAttribute('href').slice(1);
      const element = document.getElementById(id);
      if (element) map[id] = link;
      return element;
    }).filter(Boolean);

    // smooth scroll with offset
    links.forEach((link) => {
      link.addEventListener('click', (e) => {
        const id = link.getAttribute('href').slice(1);
        const element = document.getElementById(id);
        if (!element) return;
        e.preventDefault();
        const y = element.getBoundingClientRect().top + window.scrollY - 72;
        window.scrollTo({ top: y, behavior: 'smooth' });
        history.replaceState(null, '', `#${id}`);
      });
    });

    const setActive = (id) => {
      links.forEach((link) => {
        link.classList.remove('active');
      });
      const activeLink = map[id];
      if (activeLink) activeLink.classList.add('active');
    };
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setActive(entry.target.id);
        });
      }, { rootMargin: '-72px 0px -65% 0px', threshold: 0 });
      targets.forEach((target) => {
        io.observe(target);
      });
    }
  }
})();
