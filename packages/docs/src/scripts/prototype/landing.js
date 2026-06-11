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
    s += col(cx[0], 'DEFINE') + col(cx[1], 'VALIDATE') + col(cx[2], 'COMPOSE') + col(cx[3], 'ADAPT') + col(cx[4], 'USE');
    // built-in agents that ship in packages/config/src/builtins.ts
    var agents = ['loom', 'tapestry', 'shuttle', 'thread', 'weft'];
    var ay0 = 70, ah = 44, ag = 12;
    agents.forEach(function (a, i) {
      s += box(40, ay0 + i * (ah + ag), 140, ah, a, i === 0 ? 'var(--primary-dim)' : 'var(--border-strong)');
    });
    // validate: parser + schema box
    s += box(290, 150, 140, 70, 'parse + schema', 'var(--primary-dim)');
    s += '<text x="360" y="138" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-4)">weave validate</text>';
    // compose: descriptor and prompt box
    s += box(530, 150, 140, 70, 'descriptor', 'var(--secondary)');
    s += '<text x="600" y="138" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-4)">prompt inspect</text>';
    // adapt: dashed adapter boundary
    s += dashbox(790, 120, 130, 130, 'adapter boundary');
    s += box(810, 150, 90, 70, 'plugin', 'var(--secondary)');
    // use: only OpenCode is implemented today; others are documented as placeholders
    var harness = ['opencode', '/start-work', '/weave:start', 'runtime journal'];
    harness.forEach(function (hn, i) {
      s += box(1010, 60 + i * 74, 160, 50, hn, 'var(--border-strong)');
    });
    // links: config -> validation
    [70, 126, 182, 238, 294].forEach(function (y, i) {
      s += link(180, y + 22 - 22, 290, 185, 'gf', i % 2 ? 'd2' : '');
    });
    // validation -> composed descriptors
    s += link(430, 185, 530, 185, 'gf', 'd2');
    // composed descriptors -> adapter
    s += link(670, 185, 810, 185, 'gf', 'd3');
    // adapter -> OpenCode surfaces
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
      ['01', 'agent', 'Agent definitions', 'Declare prompts, prompt files, model preference lists, modes, skills, triggers, and tool policy.'],
      ['02', 'route', 'Category shuttles', 'A category with file patterns generates a specialized shuttle agent for that area of the codebase.'],
      ['03', 'flow', 'Ordered workflows', 'Define autonomous, interactive, and gate steps with explicit completion methods and review behavior.'],
      ['04', 'compose', 'Prompt composition', 'Merge built-ins, project config, prompt files, and Mustache context into inspectable prompts.'],
      ['05', 'skill', 'Runtime journal', 'Track execution state and journal entries in the Weave runtime store for inspection and recovery.'],
      ['06', 'adapter', 'OpenCode adapter', 'Materialize Weave agents and slash commands into OpenCode without moving harness logic into core.']
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
      ['flow', 'Workflow blocks', 'Ordered steps use completion methods like agent_signal, plan_created, and review_verdict.'],
      ['agent', 'Agent definitions', 'Agents can use prompt, prompt_file, prompt_append, models, skills, triggers, and tool_policy.'],
      ['model', 'Model lists', 'models ["claude-sonnet-4-5"] is adapter-facing preference, not a hard runtime selection.'],
      ['cat', 'Categories', 'patterns plus prompt_append create focused shuttle variants for frontend, backend, docs, or other domains.']
    ];
    document.getElementById('dslNotes').innerHTML = data.map(function (d) {
      return '<div class="dsl-note"><span class="chip">' + S + ic[d[0]] + '</svg></span>' +
        '<div><h4>' + d[1] + '</h4><p>' + d[2] + '</p></div></div>';
    }).join('');
  }

  /* ---------- HOW IT WORKS ---------- */
  var howGlyphs = {
    define: defs() +
      box(40, 40, 220, 40, 'agent reviewer {', 'var(--primary-dim)') +
      '<text x="60" y="110" font-family="var(--font-mono)" font-size="12" fill="var(--ok)">prompt_file "reviewer.md"</text>' +
      '<text x="60" y="140" font-family="var(--font-mono)" font-size="12" fill="var(--ok)">models ["claude-sonnet-4-5"]</text>' +
      '<text x="60" y="170" font-family="var(--font-mono)" font-size="12" fill="var(--ok)">tool_policy { read allow }</text>' +
      box(40, 200, 220, 40, '}', 'var(--border-strong)'),
    validate: defs() +
      box(40, 100, 170, 50, 'weave validate', 'var(--primary-dim)') +
      box(300, 70, 150, 44, 'lexer/parser') +
      box(300, 136, 150, 44, 'zod schema') +
      box(540, 100, 170, 50, 'typed config', 'var(--secondary)') +
      link(210, 125, 300, 92, 'gf') + link(210, 125, 300, 158, 'gf', 'd2') +
      link(450, 92, 540, 125, 'gf', 'd2') + link(450, 158, 540, 125, 'gf', 'd3'),
    compose: defs() +
      box(40, 100, 150, 50, 'built-ins', 'var(--primary-dim)') +
      box(230, 70, 150, 44, 'project config') +
      box(230, 136, 150, 44, 'prompt files') +
      box(460, 100, 170, 50, 'agent descriptor', 'var(--secondary)') +
      box(650, 100, 90, 50, 'prompt') +
      link(190, 125, 230, 92, 'gf') + link(190, 125, 230, 158, 'gf', 'd2') +
      link(380, 92, 460, 125, 'gf', 'd2') + link(380, 158, 460, 125, 'gf', 'd3') +
      link(630, 125, 650, 125, 'gf'),
    materialize: defs() +
      dashbox(250, 60, 230, 170, 'adapter boundary') +
      box(40, 120, 150, 50, 'descriptors', 'var(--primary-dim)') +
      box(290, 120, 150, 50, 'opencode plugin', 'var(--secondary)') +
      box(560, 70, 150, 44, 'subagents') +
      box(560, 176, 150, 44, 'slash commands') +
      link(190, 145, 290, 145, 'gf') +
      link(440, 145, 560, 92, 'gf', 'd2') +
      link(440, 145, 560, 198, 'gf', 'd3'),
    use: defs() +
      box(40, 110, 150, 50, 'OpenCode TUI', 'var(--primary-dim)') +
      box(300, 55, 170, 44, '/start-work') +
      box(300, 118, 170, 44, '/weave:start') +
      box(300, 181, 170, 44, 'spawned agents') +
      box(560, 118, 170, 44, 'runtime journal', 'var(--secondary)') +
      link(190, 135, 300, 77, 'gf') + link(190, 135, 300, 140, 'gf', 'd2') +
      link(190, 135, 300, 203, 'gf', 'd3') + link(470, 140, 560, 140, 'gf', 'd4')
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

  /* ---------- CURSOR-FOLLOWING GLOW (final CTA) ---------- */
  function wireFinalGlow() {
    var section = document.querySelector('.final');
    if (!section) return;
    // Honour reduced-motion: leave the static centred glow from CSS untouched
    // and never attach the pointer listener.
    var mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq && mq.matches) return;

    var rafId = 0;
    var nextX = 0;
    var nextY = 0;
    var leaveTimer = 0;

    function apply() {
      rafId = 0;
      section.style.setProperty('--glow-x', nextX + 'px');
      section.style.setProperty('--glow-y', nextY + 'px');
    }
    function schedule() {
      if (rafId) return;
      rafId = window.requestAnimationFrame(apply);
    }
    function onMove(e) {
      var rect = section.getBoundingClientRect();
      nextX = e.clientX - rect.left;
      nextY = e.clientY - rect.top;
      if (leaveTimer) { window.clearTimeout(leaveTimer); leaveTimer = 0; }
      section.classList.add('is-tracking');
      schedule();
    }
    function onLeave() {
      // Fade the glow back to its resting state; the transform stays put so it
      // does not jump back to centre abruptly.
      leaveTimer = window.setTimeout(function () {
        section.classList.remove('is-tracking');
      }, 120);
    }

    // pointermove covers mouse + pen; touch is intentionally excluded so the
    // glow never fights with scrolling on touch devices.
    section.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') return;
      onMove(e);
    }, { passive: true });
    section.addEventListener('pointerleave', onLeave, { passive: true });
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
  wireFinalGlow();
})();
