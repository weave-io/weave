/* Weave — docs behaviors: copy buttons, command palette, TOC scrollspy. */
(function () {
  /* ---------------- copy buttons ---------------- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy]');
    if (!b) return;
    var el = document.querySelector(b.getAttribute('data-copy'));
    if (!el) return;
    navigator.clipboard.writeText(el.innerText.replace(/\n$/, '')).then(function () {
      var old = b.textContent; b.textContent = '✓ copied';
      setTimeout(function () { b.textContent = old; }, 1400);
    });
  });

  /* ---------------- command palette ---------------- */
  var palette = document.getElementById('palette');
  if (palette) {
    var input = document.getElementById('paletteInput');
    var resultsEl = document.getElementById('paletteResults');
    var trigger = document.getElementById('searchTrigger');
    var ICON = {
      page: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5"/></svg>',
      spec: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l4 4v14H7z"/><path d="M13 3v5h5M10 13h5M10 17h5"/></svg>'
    };
    /* Real-route search data is injected by the PageFrame override as a
       `<script id="paletteData" type="application/json">` block with
       base-path-resolved hrefs. Read and parse it; fall back to a minimal
       built-in set if the element is missing or malformed so the palette is
       never empty. */
    var FALLBACK_DATA = [
      { g: 'Pages', t: 'Introduction', s: 'get started', href: 'docs/', ic: 'page' },
      { g: 'Pages', t: 'Workflows', s: 'core dsl · the DAG model', href: 'docs/workflows/', ic: 'page' }
    ];
    function loadData() {
      var node = document.getElementById('paletteData');
      if (!node) return FALLBACK_DATA;
      try {
        var parsed = JSON.parse(node.textContent || '');
        return Array.isArray(parsed) && parsed.length ? parsed : FALLBACK_DATA;
      } catch (err) {
        return FALLBACK_DATA;
      }
    }
    var DATA = loadData();
    var flat = [], sel = 0;

    function render(q) {
      q = (q || '').toLowerCase().trim();
      var filtered = DATA.filter(function (d) {
        return !q || (d.t + ' ' + d.s).toLowerCase().indexOf(q) !== -1;
      });
      flat = filtered;
      sel = 0;
      var html = '', lastG = null;
      if (!filtered.length) {
        resultsEl.innerHTML = '<div class="grp">no matches</div>';
        return;
      }
      filtered.forEach(function (d, i) {
        if (d.g !== lastG) { html += '<div class="grp">' + d.g + '</div>'; lastG = d.g; }
        html += '<div class="res' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '" data-href="' + d.href + '">' +
          '<span class="ic">' + ICON[d.ic] + '</span>' +
          '<span class="t"><b>' + d.t + '</b><span>' + d.s + '</span></span></div>';
      });
      resultsEl.innerHTML = html;
    }
    function move(dir) {
      var nodes = resultsEl.querySelectorAll('.res');
      if (!nodes.length) return;
      nodes[sel] && nodes[sel].classList.remove('sel');
      sel = (sel + dir + nodes.length) % nodes.length;
      nodes[sel].classList.add('sel');
      nodes[sel].scrollIntoView ? scrollSel(nodes[sel]) : null;
    }
    function scrollSel(node) {
      var box = resultsEl.getBoundingClientRect(), n = node.getBoundingClientRect();
      if (n.bottom > box.bottom) resultsEl.scrollTop += n.bottom - box.bottom;
      else if (n.top < box.top) resultsEl.scrollTop -= box.top - n.top;
    }
    function open() {
      palette.classList.add('open');
      render('');
      input.value = '';
      setTimeout(function () { input.focus(); }, 30);
    }
    function close() { palette.classList.remove('open'); }
    function go() {
      var nodes = resultsEl.querySelectorAll('.res');
      if (nodes[sel]) window.location.href = nodes[sel].getAttribute('data-href');
    }

    if (trigger) trigger.addEventListener('click', open);
    input.addEventListener('input', function () { render(input.value); });
    resultsEl.addEventListener('mousemove', function (e) {
      var r = e.target.closest('.res'); if (!r) return;
      var nodes = resultsEl.querySelectorAll('.res');
      nodes[sel] && nodes[sel].classList.remove('sel');
      sel = +r.getAttribute('data-i'); r.classList.add('sel');
    });
    resultsEl.addEventListener('click', function (e) {
      if (e.target.closest('.res')) go();
    });
    palette.addEventListener('click', function (e) { if (e.target === palette) close(); });
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.classList.contains('open') ? close() : open(); return; }
      if (!palette.classList.contains('open')) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); go(); }
    });
  }

  /* ---------------- TOC scrollspy ---------------- */
  var toc = document.querySelector('.toc ul');
  if (toc) {
    var links = Array.prototype.slice.call(toc.querySelectorAll('a'));
    var map = {};
    var targets = links.map(function (a) {
      var id = a.getAttribute('href').slice(1);
      var el = document.getElementById(id);
      if (el) map[id] = a;
      return el;
    }).filter(Boolean);

    // smooth scroll with offset
    links.forEach(function (a) {
      a.addEventListener('click', function (e) {
        var id = a.getAttribute('href').slice(1);
        var el = document.getElementById(id);
        if (!el) return;
        e.preventDefault();
        var y = el.getBoundingClientRect().top + window.scrollY - 72;
        window.scrollTo({ top: y, behavior: 'smooth' });
        history.replaceState(null, '', '#' + id);
      });
    });

    function setActive(id) {
      links.forEach(function (a) { a.classList.remove('active'); });
      if (map[id]) map[id].classList.add('active');
    }
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) setActive(en.target.id);
        });
      }, { rootMargin: '-72px 0px -65% 0px', threshold: 0 });
      targets.forEach(function (t) { io.observe(t); });
    }
  }
})();
