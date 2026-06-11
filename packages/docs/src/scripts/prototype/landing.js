/* Weave — landing.html behaviors */
(function () {
  var SVGNS = "http://www.w3.org/2000/svg";

  /* ---------- shared gradient defs ---------- */
  function defs() {
    return '<defs>' +
      '<linearGradient id="gf" x1="0" y1="0" x2="1" y2="0">' +
        '<stop offset="0" stop-color="var(--cyan)" stop-opacity="0"/>' +
        '<stop offset="0.25" stop-color="var(--cyan)"/>' +
        '<stop offset="0.55" stop-color="var(--primary)"/>' +
        '<stop offset="0.82" stop-color="var(--secondary)"/>' +
        '<stop offset="1" stop-color="var(--tertiary)" stop-opacity="0"/>' +
      '</linearGradient>' +
      '<linearGradient id="gr" x1="0" y1="0" x2="1" y2="0">' +
        '<stop offset="0" stop-color="var(--tertiary)" stop-opacity="0"/>' +
        '<stop offset="0.25" stop-color="var(--secondary)"/>' +
        '<stop offset="0.55" stop-color="var(--primary)"/>' +
        '<stop offset="0.82" stop-color="var(--cyan)"/>' +
        '<stop offset="1" stop-color="var(--cyan)" stop-opacity="0"/>' +
      '</linearGradient>' +
      '<marker id="arw" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">' +
        '<path d="M0 0L6 3L0 6" fill="none" stroke="var(--text-3)" stroke-width="1.2"/></marker>' +
    '</defs>';
  }

  function box(x, y, w, h, label, accent) {
    var st = accent || 'var(--border-strong)';
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="6" ' +
      'fill="var(--bg-elev-1)" stroke="' + st + '" stroke-width="1"/>' +
      '<text x="' + (x + w / 2) + '" y="' + (y + h / 2 + 4) + '" text-anchor="middle" ' +
      'font-family="var(--font-mono)" font-size="12" fill="var(--text-2)">' + label + '</text>';
  }
  function dashbox(x, y, w, h, label) {
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="8" ' +
      'fill="none" stroke="var(--secondary)" stroke-width="1.2" stroke-dasharray="4 4"/>' +
      '<text x="' + (x + w / 2) + '" y="' + (y - 8) + '" text-anchor="middle" ' +
      'font-family="var(--font-mono)" font-size="11" fill="var(--secondary-2)" letter-spacing="0.04em">' + label + '</text>';
  }
  function col(x, label) {
    return '<text x="' + x + '" y="28" text-anchor="middle" font-family="var(--font-mono)" ' +
      'font-size="11" fill="var(--text-4)" letter-spacing="0.08em">' + label + '</text>';
  }
  // curved connector with draw animation
  function link(x1, y1, x2, y2, grad, cls) {
    var mx = (x1 + x2) / 2;
    return '<path class="draw ' + (cls || '') + '" d="M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ',' + mx + ' ' + y2 + ',' + x2 + ' ' + y2 +
      '" fill="none" stroke="url(#' + grad + ')" stroke-width="2" pathLength="1"/>';
  }

  /* ---------- HERO DIAGRAM ---------- */
  function heroDiagram() {
    var W = 1200, H = 380;
    var cx = [110, 360, 600, 850, 1090];
    var s = defs();
    s += col(cx[0], 'DEFINE') + col(cx[1], 'COMPOSE') + col(cx[2], 'DELEGATE') + col(cx[3], 'ADAPT') + col(cx[4], 'EXECUTE');
    // agent boxes (define)
    var agents = ['orchestrator', 'planner', 'executor', 'reviewer', 'security'];
    var ay0 = 70, ah = 44, ag = 12;
    agents.forEach(function (a, i) {
      s += box(40, ay0 + i * (ah + ag), 140, ah, a, i === 0 ? 'var(--primary-dim)' : 'var(--border-strong)');
    });
    // compose: workflow box
    s += box(290, 150, 140, 70, 'migrate_repo', 'var(--primary-dim)');
    s += '<text x="360" y="138" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-4)">workflow</text>';
    // delegate: category router
    s += box(530, 150, 140, 70, 'category', 'var(--secondary)');
    s += '<text x="600" y="138" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-4)">routing</text>';
    // adapt: dashed adapter boundary
    s += dashbox(790, 120, 130, 130, 'adapter boundary');
    s += box(810, 150, 90, 70, 'adapt', 'var(--secondary)');
    // execute: harness boxes
    var harness = ['claude-code', 'opencode', 'cursor', 'custom'];
    harness.forEach(function (hn, i) {
      s += box(1010, 60 + i * 74, 160, 50, hn, 'var(--border-strong)');
    });
    // links: agents -> workflow
    [70, 126, 182, 238, 294].forEach(function (y, i) {
      s += link(180, y + 22 - 22, 290, 185, 'gf', i % 2 ? 'd2' : '');
    });
    // workflow -> category
    s += link(430, 185, 530, 185, 'gf', 'd2');
    // category -> adapter
    s += link(670, 185, 810, 185, 'gf', 'd3');
    // adapter -> harness
    [85, 159, 233, 307].forEach(function (y, i) {
      s += link(900, 185, 1010, y, 'gf', 'd4');
    });
    document.getElementById('heroDiagram').innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '">' + s + '</svg>';
  }

  /* ---------- CAPABILITIES ---------- */
  function capabilities() {
    var ic = {
      agent: '<circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M8 11l8-4M8 13l8 4"/>',
      route: '<rect x="3" y="13" width="18" height="6" rx="1.5"/><path d="M7 13V8h10v5M12 8V5"/>',
      flow: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M7.6 7.5l3 8M16.4 7.5l-3 8M8 6h8"/>',
      compose: '<path d="M12 3l8 4-8 4-8-4 8-4Z"/><path d="M4 12l8 4 8-4"/>',
      skill: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
      adapter: '<path d="M4 12h6M14 12h6"/><rect x="9" y="8" width="6" height="8" rx="1"/>'
    };
    var data = [
      ['01', 'agent', 'Agent definitions', 'Six canonical roles plus first-class custom roles, each with inputs, delegates and a model hint.'],
      ['02', 'route', 'Category routing', 'Intent tags route work to roles by capability — not by name — so swaps stay safe.'],
      ['03', 'flow', 'Workflow orchestration', 'Declare stages; dependencies are inferred from references. Cycles and dead-ends fail to compile.'],
      ['04', 'compose', 'Prompt composition', 'Intent compiles into prompts and scaffolding, normalized into one typed graph.'],
      ['05', 'skill', 'Skill matching', 'Capability signatures bind to roles at compile time, eliminating duplication.'],
      ['06', 'adapter', 'Adapter architecture', 'A one-way boundary keeps core agnostic while adapters add native surfaces.']
    ];
    var S = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">';
    document.getElementById('capGrid').innerHTML = data.map(function (d) {
      return '<div class="cap"><span class="idx">' + d[0] + '</span>' +
        S + ic[d[1]] + '</svg>' +
        '<h3>' + d[2] + '</h3><p>' + d[3] + '</p></div>';
    }).join('');
  }

  /* ---------- DSL NOTES ---------- */
  function dslNotes() {
    var S = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">';
    var ic = {
      flow: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M7.5 7.5l9 9"/>',
      agent: '<circle cx="12" cy="8" r="3"/><path d="M5 20a7 7 0 0 1 14 0"/>',
      model: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="3.5"/>',
      cat: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/><path d="M11 7.5h2.5M7.5 11v2.5"/>'
    };
    var data = [
      ['flow', 'Workflow blocks', 'Stages in declaration order; dependencies inferred, cycles rejected.'],
      ['agent', 'Agent definitions', 'Role, inputs, delegates and skills — custom roles are first-class.'],
      ['model', 'Model preference', 'prefer(reasoning, fallback: fast) is a hint; adapters resolve it.'],
      ['cat', 'Categories & routing', 'Tags route work to roles by capability, never by hard-coded name.']
    ];
    document.getElementById('dslNotes').innerHTML = data.map(function (d) {
      return '<div class="dsl-note"><span class="chip">' + S + ic[d[0]] + '</svg></span>' +
        '<div><h4>' + d[1] + '</h4><p>' + d[2] + '</p></div></div>';
    }).join('');
  }

  /* ---------- HOW IT WORKS ---------- */
  var howGlyphs = {
    define: defs() +
      box(40, 40, 220, 40, 'agent planner {', 'var(--primary-dim)') +
      '<text x="60" y="115" font-family="var(--font-mono)" font-size="12" fill="var(--ok)">✓ parser</text>' +
      '<text x="60" y="145" font-family="var(--font-mono)" font-size="12" fill="var(--ok)">✓ resolver</text>' +
      '<text x="60" y="175" font-family="var(--font-mono)" font-size="12" fill="var(--ok)">✓ verifier</text>' +
      box(40, 200, 220, 40, '}', 'var(--border-strong)'),
    compose: defs() +
      box(40, 110, 130, 50, 'survey', 'var(--primary-dim)') +
      box(230, 110, 130, 50, 'plan') +
      box(420, 110, 130, 50, 'apply') +
      box(610, 110, 110, 50, 'verify', 'var(--secondary)') +
      link(170, 135, 230, 135, 'gf') + link(360, 135, 420, 135, 'gf', 'd2') + link(550, 135, 610, 135, 'gf', 'd3'),
    delegate: defs() +
      box(280, 110, 160, 50, 'category edit', 'var(--secondary)') +
      box(40, 50, 150, 44, 'executor', 'var(--primary-dim)') +
      box(40, 180, 150, 44, 'reviewer') +
      box(540, 50, 150, 44, 'reason') +
      box(540, 180, 150, 44, 'verify') +
      link(190, 72, 280, 125, 'gr') + link(190, 202, 280, 145, 'gr', 'd2') +
      link(440, 125, 540, 72, 'gf', 'd2') + link(440, 145, 540, 202, 'gf', 'd3'),
    adapt: defs() +
      dashbox(250, 70, 230, 150, 'adapter boundary') +
      box(40, 120, 150, 50, 'intent graph', 'var(--primary-dim)') +
      box(290, 120, 150, 50, 'adapter', 'var(--secondary)') +
      box(560, 120, 150, 50, 'native surface') +
      link(190, 145, 290, 145, 'gf') + link(440, 145, 560, 145, 'gf', 'd2'),
    execute: defs() +
      box(40, 110, 150, 50, 'graph runtime', 'var(--primary-dim)') +
      box(540, 40, 170, 44, 'claude-code') +
      box(540, 96, 170, 44, 'opencode') +
      box(540, 152, 170, 44, 'cursor') +
      box(540, 208, 170, 44, 'custom') +
      link(190, 135, 540, 62, 'gf') + link(190, 135, 540, 118, 'gf', 'd2') +
      link(190, 135, 540, 174, 'gf', 'd3') + link(190, 135, 540, 230, 'gf', 'd4')
  };
  function renderHow(step) {
    document.getElementById('howCanvas').innerHTML =
      '<svg viewBox="0 0 760 280">' + howGlyphs[step] + '</svg>';
  }
  function wireHow() {
    var tabs = document.getElementById('howTabs');
    renderHow('define');
    tabs.addEventListener('click', function (e) {
      var b = e.target.closest('.how-tab');
      if (!b) return;
      tabs.querySelectorAll('.how-tab').forEach(function (t) { t.classList.remove('active'); });
      b.classList.add('active');
      renderHow(b.getAttribute('data-step'));
    });
  }

  /* ---------- REVEAL ON SCROLL ---------- */
  function reveal() {
    var els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (e) { e.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12 });
    els.forEach(function (e) { io.observe(e); });
  }

  /* ---------- COPY ---------- */
  function wireCopy() {
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-copy]');
      if (!b) return;
      var el = document.querySelector(b.getAttribute('data-copy'));
      if (!el) return;
      navigator.clipboard.writeText(el.innerText.trim()).then(function () {
        var old = b.textContent; b.textContent = '✓ copied';
        setTimeout(function () { b.textContent = old; }, 1400);
      });
    });
  }

  /* init */
  heroDiagram();
  capabilities();
  dslNotes();
  wireHow();
  reveal();
  wireCopy();
})();
