import { NextResponse }      from 'next/server'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { cookies }           from 'next/headers'

export const runtime = 'nodejs'

// ─── Role & Task Matrix V5 — scaffold content ──────────────────────────────

const MATRIX_DESIGN_TOKENS: Record<string, string> = {
  'col-axis':    '#34d399',
  'col-proj':    '#a78bfa',
  'col-obs':     '#fbbf24',
  'col-dev':     '#fb923c',
  'col-data':    '#38bdf8',
  'col-forge':   '#f472b6',
  'col-mkt-ax':  '#f0abfc',
  'col-mkt-gr':  '#c084fc',
  'col-dealer':  '#93c5fd',
  'bg-dark':     '#0f172a',
  'bg-card':     '#1e293b',
  'bg-surface':  '#0f172a',
  'text-primary':'#f8fafc',
  'text-muted':  '#94a3b8',
  'border-col':  '#334155',
  'accent':      '#38bdf8',
}

const MATRIX_CSS = `
/* ── Base ── */
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;background:{{bg-dark}};color:{{text-primary}};min-height:100vh}
.matrix-app{display:flex;flex-direction:column;height:100vh;overflow:hidden}

/* ── Header ── */
.mhdr{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid {{border-col}};background:{{bg-card}};flex-shrink:0;flex-wrap:wrap;gap:8px}
.mtitle{font-size:1rem;font-weight:700;color:{{text-primary}}}
.morgname{font-size:0.75rem;color:{{text-muted}};margin-top:2px}
.mhdr-right{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.legend{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.legend-item{display:flex;align-items:center;gap:4px;font-size:11px;color:{{text-muted}};cursor:pointer;padding:3px 6px;border-radius:4px;border:1px solid transparent;transition:all .15s}
.legend-item:hover,.legend-item.active{border-color:currentColor;opacity:1}
.legend-dot{width:10px;height:10px;border-radius:2px;flex-shrink:0}
.ctrl-bar{display:flex;gap:6px}
.ctrl-btn{padding:5px 10px;border-radius:6px;border:1px solid {{border-col}};background:transparent;color:{{text-muted}};cursor:pointer;font-size:11px;transition:all .15s;white-space:nowrap}
.ctrl-btn:hover{color:{{text-primary}};border-color:{{text-muted}}}

/* ── Status bar ── */
.status-bar{padding:6px 16px;font-size:11px;color:{{text-muted}};background:{{bg-surface}};border-bottom:1px solid {{border-col}};flex-shrink:0;min-height:28px}

/* ── Matrix ── */
.matrix-wrap{flex:1;overflow:auto;padding:0}
.mtable{border-collapse:collapse;width:max-content;min-width:100%}
.mtable th,.mtable td{border:1px solid {{border-col}};padding:0}

/* Entity group headers */
.entity-hdr{text-align:center;font-weight:700;font-size:11px;letter-spacing:.05em;padding:6px 8px;color:#000;cursor:pointer;transition:opacity .15s}
.entity-hdr:hover{opacity:.8}

/* Column headers */
.col-hdr{text-align:center;font-size:10px;font-weight:600;padding:5px 6px;color:{{text-muted}};background:{{bg-card}};white-space:nowrap;max-width:90px;cursor:pointer;transition:background .15s}
.col-hdr:hover,.col-hdr.hi{background:{{border-col}};color:{{text-primary}}}

/* Row label cells */
.row-lbl{white-space:nowrap;padding:5px 10px;font-size:11px;color:{{text-muted}};background:{{bg-card}};min-width:140px;position:sticky;left:0;z-index:2;border-right:2px solid {{border-col}}}
.section-hdr-cell{padding:5px 10px;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:{{accent}};background:{{bg-surface}};border-bottom:1px solid {{border-col}};position:sticky;left:0;z-index:2}

/* Role cells */
.role-cell{vertical-align:top;padding:4px;min-width:88px;max-width:120px;min-height:36px;cursor:pointer;transition:background .15s}
.role-cell:hover,.role-cell.hi{background:rgba(255,255,255,.04)}
.role-cell.col-hi{background:rgba(56,189,248,.06)}
.role-cell.entity-hi{outline:1px solid rgba(255,255,255,.08)}

/* Role boxes */
.role-box{border-radius:5px;padding:5px 6px;margin-bottom:3px;font-size:11px;border-left:3px solid transparent;background:rgba(255,255,255,.05);transition:transform .1s,box-shadow .1s;cursor:pointer}
.role-box:hover,.role-box.selected{transform:translateX(2px);box-shadow:0 2px 8px rgba(0,0,0,.3)}
.role-title{font-weight:600;color:{{text-primary}};line-height:1.3}
.role-initials{font-size:10px;color:{{text-muted}};margin-top:2px}
.role-note{font-size:10px;color:{{text-muted}};margin-top:2px;opacity:.7}
.role-badges{display:flex;flex-wrap:wrap;gap:3px;margin-top:3px}
.badge{font-size:9px;padding:1px 5px;border-radius:10px;border:1px solid rgba(255,255,255,.2);color:{{text-muted}}}

/* Corner cell */
.corner-cell{position:sticky;left:0;z-index:3;background:{{bg-card}};border-right:2px solid {{border-col}}}

/* Headcount panel */
.hc-panel{border-top:1px solid {{border-col}};padding:12px 16px;background:{{bg-card}};flex-shrink:0}
.hc-panel h3{font-size:12px;font-weight:600;color:{{text-muted}};margin-bottom:8px;letter-spacing:.06em;text-transform:uppercase}
.hc-grid{display:flex;flex-wrap:wrap;gap:8px}
.hc-card{padding:8px 12px;border-radius:6px;border:1px solid {{border-col}};min-width:80px}
.hc-entity{font-size:10px;color:{{text-muted}};margin-bottom:2px}
.hc-fte{font-size:18px;font-weight:700;color:{{text-primary}}}
.hc-label{font-size:10px;color:{{text-muted}}}

/* Highlight classes for entity types */
.hi-axis   { border-color: {{col-axis}}   !important }
.hi-proj   { border-color: {{col-proj}}   !important }
.hi-obs    { border-color: {{col-obs}}    !important }
.hi-dev    { border-color: {{col-dev}}    !important }
.hi-data   { border-color: {{col-data}}   !important }
.hi-forge  { border-color: {{col-forge}}  !important }
.hi-mkt-ax { border-color: {{col-mkt-ax}} !important }
.hi-mkt-gr { border-color: {{col-mkt-gr}} !important }
.hi-dealer { border-color: {{col-dealer}} !important }

/* Light theme overrides */
.matrix-app.light { --t-bg:#f8fafc; --t-card:#ffffff; --t-surface:#f1f5f9; --t-text:#0f172a; --t-muted:#64748b; --t-border:#e2e8f0 }
.matrix-app.light { background:#f8fafc; color:#0f172a }
.matrix-app.light .mhdr { background:#ffffff; border-color:#e2e8f0 }
.matrix-app.light .status-bar { background:#f1f5f9; border-color:#e2e8f0 }
.matrix-app.light .col-hdr { background:#f8fafc; color:#64748b }
.matrix-app.light .row-lbl,.matrix-app.light .corner-cell { background:#f8fafc; color:#64748b }
.matrix-app.light .role-cell { background:transparent }
.matrix-app.light .role-box { background:rgba(0,0,0,.04); color:#0f172a }
.matrix-app.light .role-title { color:#0f172a }
.matrix-app.light .hc-panel { background:#ffffff; border-color:#e2e8f0 }
.matrix-app.light .hc-card { border-color:#e2e8f0 }
.matrix-app.light .section-hdr-cell { background:#f1f5f9 }
`

const MATRIX_JS = `
(function(){
  function readSlot(id, fallback){
    var el = document.getElementById(id);
    if(!el) return fallback;
    try{ return JSON.parse(el.textContent||'null')||fallback; }catch(e){ return fallback; }
  }

  var entities    = readSlot('slot-entities',  []);
  var colDefs     = readSlot('slot-columns',   []);
  var sections    = readSlot('slot-sections',  []);
  var roleData    = readSlot('slot-roles',     {});
  var hcData      = readSlot('slot-hc',        []);

  var app         = document.getElementById('app');
  var status      = document.getElementById('status');
  var table       = document.getElementById('matrix');
  var hcPanel     = document.getElementById('hc-panel');
  var hcContent   = document.getElementById('hc-content');
  var legend      = document.getElementById('legend');

  var selection   = { type: null, value: null };

  /* entity colour map */
  var entityColour = {};
  entities.forEach(function(e){ entityColour[e.code] = e.colour || '#888'; });

  /* ── Build legend ── */
  entities.forEach(function(e){
    var item = document.createElement('div');
    item.className = 'legend-item';
    item.title = e.name;
    item.setAttribute('data-entity', e.code);
    item.innerHTML = '<span class="legend-dot" style="background:'+e.colour+'"></span><span>'+e.name+'</span>';
    item.addEventListener('click', function(){ selectEntity(e.code, e.name); });
    legend.appendChild(item);
  });

  /* ── Build headcount panel ── */
  function buildHC(){
    var grid = document.createElement('div');
    grid.className = 'hc-grid';
    hcData.forEach(function(h){
      var col = entityColour[h.entity] || '#888';
      var card = document.createElement('div');
      card.className = 'hc-card';
      card.style.borderLeftColor = col;
      card.style.borderLeftWidth = '3px';
      card.innerHTML = '<div class="hc-entity" style="color:'+col+'">'+h.name+'</div>'
        + '<div class="hc-fte">'+h.fte+'</div>'
        + '<div class="hc-label">FTE</div>';
      grid.appendChild(card);
    });
    hcContent.appendChild(grid);
  }
  buildHC();

  /* ── Build matrix table ── */
  var thead = document.createElement('thead');
  var tbody = document.createElement('tbody');

  /* Flatten all columns */
  var allCols = [];
  colDefs.forEach(function(grp){
    grp.columns.forEach(function(col){
      allCols.push({ entity: grp.entity_code, code: col.code, label: col.label });
    });
  });

  /* Row 1: entity group headers */
  var row1 = document.createElement('tr');
  var corner = document.createElement('th');
  corner.rowSpan = 2;
  corner.className = 'corner-cell';
  row1.appendChild(corner);
  colDefs.forEach(function(grp){
    var th = document.createElement('th');
    th.colSpan = grp.columns.length;
    th.className = 'entity-hdr';
    var ent = entities.find(function(e){ return e.code === grp.entity_code; });
    var col = (ent && ent.colour) || '#888';
    th.style.background = col;
    th.textContent = (ent && ent.name) || grp.entity_code;
    th.setAttribute('data-entity', grp.entity_code);
    th.addEventListener('click', function(){ selectEntity(grp.entity_code, (ent&&ent.name)||grp.entity_code); });
    row1.appendChild(th);
  });
  thead.appendChild(row1);

  /* Row 2: column headers */
  var row2 = document.createElement('tr');
  allCols.forEach(function(col, ci){
    var th = document.createElement('th');
    th.className = 'col-hdr';
    th.textContent = col.label;
    th.setAttribute('data-col', col.code);
    th.setAttribute('data-colidx', ci);
    th.addEventListener('click', function(){ selectColumn(col.code, col.label, ci); });
    row2.appendChild(th);
  });
  thead.appendChild(row2);

  /* Body rows */
  sections.forEach(function(section){
    /* Section header row */
    var secRow = document.createElement('tr');
    var secTd = document.createElement('td');
    secTd.colSpan = allCols.length + 1;
    secTd.className = 'section-hdr-cell';
    secTd.textContent = section.label;
    secRow.appendChild(secTd);
    tbody.appendChild(secRow);

    (section.rows || []).forEach(function(row){
      var tr = document.createElement('tr');

      /* Row label */
      var lbl = document.createElement('td');
      lbl.className = 'row-lbl';
      lbl.textContent = row.label;
      tr.appendChild(lbl);

      /* Data cells */
      allCols.forEach(function(col, ci){
        var td = document.createElement('td');
        td.className = 'role-cell';
        td.setAttribute('data-row', row.code);
        td.setAttribute('data-col', col.code);
        td.setAttribute('data-colidx', ci);
        td.setAttribute('data-entity', col.entity);

        var key = row.code + '-' + col.code;
        var roles = roleData[key] || [];
        roles.forEach(function(r){
          var box = document.createElement('div');
          box.className = 'role-box';
          var entCol = entityColour[r.entity||col.entity] || '#888';
          box.style.borderLeftColor = entCol;

          var html = '<div class="role-title">'+escH(r.title||'')+'</div>';
          if(r.initials && r.initials.length){
            html += '<div class="role-initials">'+r.initials.join(', ')+'</div>';
          }
          if(r.note){ html += '<div class="role-note">'+escH(r.note)+'</div>'; }
          if(r.badges && r.badges.length){
            html += '<div class="role-badges">'
              + r.badges.map(function(b){ return '<span class="badge">'+escH(b)+'</span>'; }).join('')
              + '</div>';
          }
          box.innerHTML = html;
          box.addEventListener('click', function(e){
            e.stopPropagation();
            selectRole(r, box);
          });
          td.appendChild(box);
        });

        td.addEventListener('click', function(){
          selectCell(row.code, col.code, row.label, col.label);
        });
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  });

  table.appendChild(thead);
  table.appendChild(tbody);

  /* ── Selection / highlighting ── */
  function clearHighlight(){
    document.querySelectorAll('.hi,.col-hi,.entity-hi,.active').forEach(function(el){
      el.classList.remove('hi','col-hi','entity-hi','active','selected');
    });
  }

  function setStatus(msg){ status.textContent = msg; }

  function selectEntity(code, name){
    if(selection.type==='entity' && selection.value===code){ clearSel(); return; }
    clearHighlight();
    selection = {type:'entity', value:code};
    document.querySelectorAll('[data-entity="'+code+'"]').forEach(function(el){
      el.classList.add(el.tagName==='TH'?'hi':'entity-hi');
    });
    document.querySelectorAll('.legend-item[data-entity="'+code+'"]').forEach(function(el){ el.classList.add('active'); });
    setStatus('Entity: ' + name);
  }

  function selectColumn(code, label, idx){
    if(selection.type==='col' && selection.value===code){ clearSel(); return; }
    clearHighlight();
    selection = {type:'col', value:code};
    document.querySelectorAll('[data-col="'+code+'"]').forEach(function(el){ el.classList.add('hi'); });
    document.querySelectorAll('[data-colidx="'+idx+'"]').forEach(function(el){ el.classList.add('col-hi'); });
    setStatus('Column: ' + label);
  }

  function selectCell(rowCode, colCode, rowLabel, colLabel){
    clearHighlight();
    selection = {type:'cell', value: rowCode+'-'+colCode};
    setStatus('Cell: ' + rowLabel + ' / ' + colLabel);
  }

  function selectRole(r, box){
    clearHighlight();
    box.classList.add('selected');
    selection = {type:'role', value: r.title};
    setStatus('Role: ' + (r.title||'') + (r.initials&&r.initials.length?' — '+r.initials.join(', '):''));
  }

  window.clearSel = function(){
    clearHighlight();
    selection = {type:null, value:null};
    setStatus('Click any cell, column, or entity to highlight');
  };

  window.toggleTheme = function(){
    app.classList.toggle('light');
  };

  window.toggleHC = function(){
    hcPanel.style.display = hcPanel.style.display==='none'?'block':'none';
  };

  function escH(str){
    return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

})();
`

const MATRIX_HTML = `<div class="matrix-app" id="app">
  <header class="mhdr">
    <div class="mhdr-left">
      <h1 class="mtitle">{{matrix_title}}</h1>
      <p class="morgname">{{organisation_name}} &nbsp;&middot;&nbsp; {{version_label}}</p>
    </div>
    <div class="mhdr-right">
      <div id="legend" class="legend"></div>
      <div class="ctrl-bar">
        <button class="ctrl-btn" onclick="toggleTheme()">&#9788;/&#9790;</button>
        <button class="ctrl-btn" onclick="toggleHC()">Headcount</button>
        <button class="ctrl-btn" onclick="clearSel()">Clear</button>
      </div>
    </div>
  </header>

  <div class="status-bar" id="status">Click any cell, column, entity or role to highlight</div>

  <div class="matrix-wrap">
    <table id="matrix" class="mtable"></table>
  </div>

  <div class="hc-panel" id="hc-panel" style="display:none;">
    <h3>Headcount Summary</h3>
    <div id="hc-content"></div>
  </div>
</div>

<script type="application/json" id="slot-entities">{{entity_definitions}}</script>
<script type="application/json" id="slot-columns">{{column_definitions}}</script>
<script type="application/json" id="slot-sections">{{section_definitions}}</script>
<script type="application/json" id="slot-roles">{{role_data}}</script>
<script type="application/json" id="slot-hc">{{headcount_summary}}</script>`

const MATRIX_SLOTS = [
  { name: 'matrix_title',       label: 'Matrix Title',           type: 'text',   description: 'Title displayed in the header',                                  required: true,  data_source: 'manual',           default: 'Role & Task Matrix' },
  { name: 'organisation_name',  label: 'Organisation Name',      type: 'text',   description: 'Organisation or group name shown in the subheading',              required: true,  data_source: 'manual',           default: 'My Organisation' },
  { name: 'version_label',      label: 'Version Label',          type: 'text',   description: 'Version string, e.g. "V5 · March 2026"',                          required: false, data_source: 'manual',           default: 'V5' },
  { name: 'entity_definitions', label: 'Entity Definitions',     type: 'object', description: 'JSON array of {code,name,colour,prefix,fte} for each entity',     required: true,  data_source: 'manual' },
  { name: 'column_definitions', label: 'Column Definitions',     type: 'object', description: 'JSON array of {entity_code, columns:[{code,label}]} groups',      required: true,  data_source: 'manual' },
  { name: 'section_definitions',label: 'Section Definitions',    type: 'object', description: 'JSON array of {label, rows:[{code,label}]} defining matrix rows',  required: true,  data_source: 'manual' },
  { name: 'role_data',          label: 'Role Data',              type: 'object', description: 'JSON object keyed "rowCode-colCode" with arrays of role boxes',   required: false, data_source: 'manual' },
  { name: 'headcount_summary',  label: 'Headcount Summary',      type: 'object', description: 'JSON array of {entity,name,fte} for the headcount panel',         required: false, data_source: 'manual' },
]

// ─── POST /api/report-templates/seed ─────────────────────────────────────────
// One-time endpoint to seed the Role & Task Matrix V5 template for the active group.

export async function POST() {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  if (!activeGroupId) return NextResponse.json({ error: 'No active group' }, { status: 400 })

  // Admin check
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId)
    .single()
  if (!membership || !['super_admin', 'group_owner', 'group_admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('report_templates')
    .insert({
      group_id:           activeGroupId,
      name:               'Role & Task Matrix',
      description:        'Wide horizontal grid mapping customer segments, tasks, and roles across business entities. Supports dark/light theme, entity colour system, and interactive highlighting.',
      template_type:      'matrix',
      version:            1,
      design_tokens:      MATRIX_DESIGN_TOKENS,
      slots:              MATRIX_SLOTS,
      scaffold_html:      MATRIX_HTML,
      scaffold_css:       MATRIX_CSS,
      scaffold_js:        MATRIX_JS,
      data_sources:       [{ type: 'manual', description: 'All data provided manually via JSON slots' }],
      agent_instructions: "This template renders a role and task matrix. Slot 'role_data' should be a JSON object keyed by cell coordinates (e.g. 'row1-col1') containing arrays of role boxes with entity, title, note, badges, and initials arrays. Slot 'entity_definitions' should be an array of { code, name, colour, prefix, fte } objects. Slot 'column_definitions' should be an array of { entity_code, columns: [{code, label}] } objects. Slot 'section_definitions' should be an array of { label, rows: [{code, label}] } objects.",
      created_by:         session.user.id,
      updated_at:         new Date().toISOString(),
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data }, { status: 201 })
}
