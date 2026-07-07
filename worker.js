/* ============================================================================
   Venue dashboard - Worker shell (ships in the FC Member Dashboard Kit)

   You are the AI running this build. This file is YOURS to finish; the owner
   never sees it. The shell already does the hard plumbing:

     - serves the dashboard page
     - a metrics API with a fixed contract the page already understands
     - an OAuth2 begin/callback flow with token storage
     - automatic access-token refresh, INCLUDING rotating refresh tokens
       (Xero rotates the refresh token on every refresh - the store persists
       the new one every time; never cache tokens outside the store)
     - plain-English connection status for the Connections screen
     - the no-API rungs built in: POST /api/ingest (file/export data in),
       an email() handler stub for emailed reports, a scheduled() cron hook,
       and a KV day-store the export-fed adapters read from

   What you fill in: the three ADAPTERS (accounting / pos / rostering), each
   marked with  >>> ADAPTER ...  blocks. Wire them against the provider's
   CURRENT documentation, per capability-matrix.md and playbook.md.

   Rules that bind every adapter (kpi-spec.md is the law):
     - accounting supplies EVERY money figure, always ex GST/sales tax
     - pos supplies ONE number: completed transaction count (no voids/refunds)
     - rostering supplies rostered cost only (projected wage %)
     - read-only scopes/permissions everywhere
     - secrets ONLY via Worker secrets (wrangler secret put NAME) - never in
       this file, never in the repo, never echoed to the owner

   Bindings expected (wrangler.toml): TOKENS (KV). Secrets: see each adapter.
============================================================================ */

import dashboardHtml from './dashboard.html';

/* ----------------------------------------------------------------------------
   Provider adapters - THE PART YOU BUILD.
   Flip `configured: true` per source as you wire it. Until then the
   dashboard honestly shows "not configured" (never a fake zero).
---------------------------------------------------------------------------- */
/* OPTIONAL no-API hooks any adapter may add (the fallback-ladder rungs):
     mode: 'export'           - source is fed by exports, not a live API
     parseExport(env, h, raw) - raw = { text, contentType }: parse the tool's
                                exported CSV/report into day rows:
                                  pos:        [{ date:'YYYY-MM-DD', count }]
                                  accounting: [{ date, revenue, cogs, wagesSuper, overheads }]
                                  rostering:  [{ date, cost }]
                                Adding parseExport makes the dashboard's
                                Connections screen offer a file-upload panel
                                for this source (the guided-upload rung).
     scheduledPull(env, h)    - cron hook (uncomment [triggers] in
                                wrangler.toml): fetch the tool's own export
                                (its report scheduler's output, a saved export
                                URL) and h.saveIngestedRows(rows).
   In export mode, implement fetchRange/fetchMonthly via h.readIngested /
   h.monthlyIngested instead of provider calls. Emailed reports: complete the
   email() handler at the bottom (needs the owner's domain on their Cloudflare
   with Email Routing pointed at this Worker). Ingest auth: the INGEST_TOKEN
   secret; if the owner uploads by hand, that same value is their upload code. */
const ADAPTERS = {

  /* >>> ADAPTER 1: ACCOUNTING (connect this FIRST - it feeds most of the board)
     Contract:
       auth: 'oauth' with the oauth{} block filled, or 'token' for a pasted key
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { revenue, cogs, wagesSuper, overheads }
                                 (numbers, ex GST/sales tax, for q.from..q.to
                                  inclusive, dates in the venue's books)
       fetchMonthly(env, h, q)-> { months:['YYYY-MM',...], revenue:[...],
                                   cogs:[...], wagesSuper:[...], overheads:[...] }
                                 (align arrays to months; null where no data)
     Map the owner's P&L faithfully: Revenue/Income section (trading income
     only - Other Income excluded), Cost of Sales section, wage + super
     accounts, Operating Expenses less wages/super. Do not re-categorise
     their books. See kpi-spec.md.
     Example (Xero): oauth with tokenAuth:'basic' (the token endpoint wants
     HTTP Basic client auth), scopes 'offline_access
     accounting.reports.profitandloss.read', P&L report endpoint, org name
     from the connections endpoint, sandbox = tenant name contains
     'Demo Company'. Secrets: ACCOUNTING_CLIENT_ID, ACCOUNTING_CLIENT_SECRET.
  */
  accounting: {
    /* Xero - wired July 2026 for Future Magic Brewing Co.
       Money per kpi-spec.md: Revenue = trading Income section (Other Income
       excluded); COGS = Cost of Sales section; wagesSuper = keyword-matched
       lines inside Operating Expenses (owner confirms the list at
       reconciliation); Overheads = Operating Expenses total minus wagesSuper.
       All figures from the Xero P&L report (ex GST by report design). */
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      scopes: 'offline_access accounting.reports.profitandloss.read',
      clientIdSecret: 'ACCOUNTING_CLIENT_ID',
      clientSecretSecret: 'ACCOUNTING_CLIENT_SECRET',
      tokenAuth: 'basic' /* Xero token endpoint requires client_secret_basic */
    },

    /* Resolve (and cache) the Xero tenant. */
    async _tenant(env, h) {
      const tokens = await h.getTokens();
      if (!tokens) { const e = new Error('no tokens'); e.status = 401; throw e; }
      if (tokens.tenantId) return { id: tokens.tenantId, name: tokens.tenantName || '' };
      const conns = await h.fetchJson('https://api.xero.com/connections', {
        headers: { Accept: 'application/json' }
      });
      const org = (conns || []).find((c) => (c.tenantType || '') === 'ORGANISATION') || (conns || [])[0];
      if (!org) { const e = new Error('no organisation connected'); e.status = 401; throw e; }
      const fresh = await h.getTokens();
      await h.saveTokens({ ...fresh, tenantId: org.tenantId, tenantName: org.tenantName || '' });
      return { id: org.tenantId, name: org.tenantName || '' };
    },

    async _pnl(env, h, params) {
      const t = await this._tenant(env, h);
      const u = new URL('https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss');
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      const data = await h.fetchJson(u.toString(), {
        headers: { 'Xero-Tenant-Id': t.id, Accept: 'application/json' }
      });
      await h.noteSync();
      return (data.Reports && data.Reports[0]) || { Rows: [] };
    },

    /* --- P&L walking, shared by fetchRange and fetchMonthly --- */
    _num(v) {
      const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
      return isFinite(n) ? n : 0;
    },
    /* Owner-confirmed wage/super accounts (reconciliation, 7 Jul 2026).
       Exact labels only - a new payroll-ish account never silently joins
       Wage % without the owner re-confirming here. */
    _wageLabels: ['wages and salaries', 'superannuation'],
    _isWageLine(label) {
      return this._wageLabels.includes(String(label || '').trim().toLowerCase());
    },
    _sectionKind(title) {
      const s = (title || '').trim();
      if (/other income/i.test(s)) return 'otherIncome';           /* excluded */
      if (/^(trading\s+)?(income|revenue)$/i.test(s)) return 'income';
      if (/^(less\s+)?cost of (sales|goods)/i.test(s)) return 'cogs';
      if (/^(less\s+)?(operating\s+)?expenses$/i.test(s)) return 'opex';
      return null;
    },
    /* Walk one report. nCols = number of amount columns (1 for a range pull,
       one per month for a multi-period pull). Returns per-column
       { revenue, cogs, wagesSuper, overheads } plus the matched wage labels. */
    _walk(report, nCols) {
      const zero = () => new Array(nCols).fill(0);
      const out = { revenue: zero(), cogs: zero(), opexTotal: zero(), wagesSuper: zero(), wageLabels: [] };
      const rowsOf = (sec) => (sec && sec.Rows) || [];
      const amounts = (cells) => {
        const a = [];
        for (let i = 1; i <= nCols; i++) a.push(this._num(cells && cells[i] && cells[i].Value));
        return a;
      };
      for (const sec of (report.Rows || [])) {
        if (sec.RowType !== 'Section') continue;
        const kind = this._sectionKind(sec.Title);
        if (!kind || kind === 'otherIncome') continue;
        let summary = null;
        let rowSum = zero();
        for (const row of rowsOf(sec)) {
          if (row.RowType === 'SummaryRow') { summary = amounts(row.Cells); continue; }
          if (row.RowType !== 'Row') continue;
          const label = row.Cells && row.Cells[0] && row.Cells[0].Value;
          const vals = amounts(row.Cells);
          rowSum = rowSum.map((x, i) => x + vals[i]);
          if (kind === 'opex' && this._isWageLine(label)) {
            out.wageLabels.push(label);
            out.wagesSuper = out.wagesSuper.map((x, i) => x + vals[i]);
          }
        }
        const total = summary || rowSum;
        if (kind === 'income') out.revenue = out.revenue.map((x, i) => x + total[i]);
        if (kind === 'cogs') out.cogs = out.cogs.map((x, i) => x + total[i]);
        if (kind === 'opex') out.opexTotal = out.opexTotal.map((x, i) => x + total[i]);
      }
      out.overheads = out.opexTotal.map((x, i) => x - out.wagesSuper[i]);
      return out;
    },

    async status(env, h) {
      const tokens = await h.getTokens();
      if (!tokens || !tokens.access_token) return { connected: false };
      try {
        const t = await this._tenant(env, h);
        return {
          connected: true,
          org: t.name,
          sandbox: /demo company/i.test(t.name),
          lastSync: await lastSync(env, 'accounting')
        };
      } catch (e) {
        return { connected: false, error: plainError(e.status || 500) };
      }
    },

    /* Single explicit range -> one-column report. */
    async fetchRange(env, h, q) {
      const report = await this._pnl(env, h, { fromDate: q.from, toDate: q.to });
      const w = this._walk(report, 1);
      return { revenue: w.revenue[0], cogs: w.cogs[0], wagesSuper: w.wagesSuper[0], overheads: w.overheads[0] };
    },

    /* Monthly trend. Xero caps `periods` at 12, so pull in <=12-month blocks
       (timeframe=MONTH) and map columns to months via the report header row -
       Xero orders period columns newest-first, so never assume order. */
    async fetchMonthly(env, h, q) {
      const months = [];
      { /* enumerate q.fromMonth..q.toMonth inclusive (YYYY-MM) */
        let [y, m] = q.fromMonth.split('-').map(Number);
        const [ey, em] = q.toMonth.split('-').map(Number);
        while (y < ey || (y === ey && m <= em)) {
          months.push(y + '-' + String(m).padStart(2, '0'));
          m++; if (m > 12) { m = 1; y++; }
        }
      }
      const byMonth = {};
      const MONTHS_ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
      for (let i = 0; i < months.length; i += 12) {
        const block = months.slice(i, i + 12);
        const last = block[block.length - 1];
        const [ly, lm] = last.split('-').map(Number);
        const lastDay = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
        const report = await this._pnl(env, h, {
          fromDate: block[0] + '-01',
          toDate: last + '-' + String(lastDay).padStart(2, '0'),
          periods: String(block.length),
          timeframe: 'MONTH'
        });
        /* Header row cells (after the first) title each period column, e.g.
           "31 Jul 25" or "Jul-25"; parse each to YYYY-MM. */
        const header = (report.Rows || []).find((r) => r.RowType === 'Header');
        const colMonths = [];
        if (header && header.Cells) {
          for (let c = 1; c < header.Cells.length; c++) {
            const txt = String(header.Cells[c].Value || '');
            const m1 = txt.match(/([A-Za-z]{3})[a-z]*[\s-]+('?\d{2}|\d{4})/);
            if (m1 && MONTHS_ABBR[m1[1].toLowerCase()]) {
              let yy = m1[2].replace("'", '');
              if (yy.length === 2) yy = '20' + yy;
              colMonths.push(yy + '-' + String(MONTHS_ABBR[m1[1].toLowerCase()]).padStart(2, '0'));
            } else colMonths.push(null);
          }
        }
        const nCols = colMonths.length || block.length;
        const w = this._walk(report, nCols);
        for (let c = 0; c < nCols; c++) {
          /* Fall back to newest-first order if a header cell didn't parse */
          const mo = colMonths[c] || block[block.length - 1 - c];
          if (!mo) continue;
          byMonth[mo] = { revenue: w.revenue[c], cogs: w.cogs[c], wagesSuper: w.wagesSuper[c], overheads: w.overheads[c] };
        }
      }
      return {
        months,
        revenue: months.map((m) => (byMonth[m] ? byMonth[m].revenue : null)),
        cogs: months.map((m) => (byMonth[m] ? byMonth[m].cogs : null)),
        wagesSuper: months.map((m) => (byMonth[m] ? byMonth[m].wagesSuper : null)),
        overheads: months.map((m) => (byMonth[m] ? byMonth[m].overheads : null))
      };
    }
  },

  /* >>> ADAPTER 2: POS
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { count }   (completed transactions only;
                                  exclude voided/cancelled; refunds never
                                  reduce the count; q.rollover shifts the
                                  trading-day boundary by that many hours)
       fetchMonthly(env, h, q)-> { months:[...], count:[...] }
     NEVER return a dollar figure from the POS.
     Example (Square): pasted production personal access token (secret
     POS_API_TOKEN); sandbox sign = token only answers on
     connect.squareupsandbox.com.
  */
  pos: {
    /* Lightspeed O-Series (Kounta) - wired July 2026, export mode.
       Live API is plan/partner-gated, so this runs on the fallback ladder:
       the Insights "Total Sales" card, scheduled DAILY and scoped to
       YESTERDAY, delivered to /api/ingest?source=pos&token=... Each delivery
       is one trading day's completed-sales count (Insights' "sales" figure;
       voids excluded by the report itself). A dated per-day CSV (e.g. a Back
       Office export) is also accepted, for backfill and as a better future
       rung. ONLY the count is ever read; every dollar figure is ignored. */
    configured: true,
    auth: null,
    mode: 'export',
    oauth: {},

    _venueYesterday() {
      /* Australia/Brisbane is UTC+10, no DST. */
      const now = new Date(Date.now() + 10 * 3600 * 1000);
      now.setUTCDate(now.getUTCDate() - 1);
      return now.toISOString().slice(0, 10);
    },

    /* If the delivery is multipart (webhook senders attach the file), pull the
       text of the attached part; otherwise return the body as-is. */
    _unwrap(raw) {
      const ct = (raw.contentType || '').toLowerCase();
      let text = raw.text || '';
      const m = ct.match(/boundary="?([^";]+)"?/);
      if (ct.includes('multipart') && m) {
        const parts = text.split('--' + m[1]);
        let best = '';
        for (const p of parts) {
          const idx = p.indexOf('\r\n\r\n') >= 0 ? p.indexOf('\r\n\r\n') + 4
                    : p.indexOf('\n\n') >= 0 ? p.indexOf('\n\n') + 2 : -1;
          if (idx < 0) continue;
          const body = p.slice(idx).trim();
          if (body.length > best.length) best = body;
        }
        if (best) text = best;
      }
      return text;
    },

    _toIsoDate(s) {
      const t = String(s || '').trim().replace(/^"|"$/g, '');
      let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);                 /* YYYY-MM-DD */
      if (m) return m[1] + '-' + m[2] + '-' + m[3];
      m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);               /* DD/MM/YYYY (AU) */
      if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
      return null;
    },

    async parseExport(env, h, raw) {
      const text = this._unwrap(raw);

      /* Shape A: a dated per-day CSV. Find rows starting with a date and a
         column that is a plain integer count (never a $ column). Column pick:
         prefer a header matching count-ish names; otherwise the first
         all-integer, non-currency column. Handles Insights' two-row headers. */
      const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
      const rows = lines.map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').trim()));
      const dataRows = rows.filter((r) => this._toIsoDate(r[0]));
      if (dataRows.length) {
        const headerRows = rows.slice(0, Math.max(0, rows.indexOf(dataRows[0])));
        const nameOf = (c) => headerRows.map((hr) => hr[c] || '').join(' ').toLowerCase();
        const isCountName = (s) => /(number of sales|sales count|sale count|count of|orders|transactions|# ?sales|no\.? of)/.test(s);
        const colOk = (c) => dataRows.every((r) => {
          const v = (r[c] || '').replace(/,/g, '');
          return v === '' || /^\d+$/.test(v);   /* integers only; $ values fail */
        });
        let col = -1;
        const width = Math.max(...dataRows.map((r) => r.length));
        for (let c = 1; c < width; c++) if (isCountName(nameOf(c)) && colOk(c)) { col = c; break; }
        if (col < 0) for (let c = 1; c < width; c++) if (colOk(c) && dataRows.some((r) => (r[c] || '') !== '')) { col = c; break; }
        if (col >= 0) {
          return dataRows.map((r) => ({
            date: this._toIsoDate(r[0]),
            count: parseInt((r[col] || '0').replace(/,/g, ''), 10) || 0
          }));
        }
        /* Dated rows but no clean count column (e.g. a revenue-by-day file):
           REJECT. Never guess a $ column, never fall through to the summary
           shape - a wrong file must fail loudly, not save a junk row. */
        return [];
      }

      /* Shape B: the Total Sales summary card ("2154 sales at an average
         sale total of $31.46."), no date - a daily, yesterday-scoped
         delivery, dated on arrival in the venue's timezone. Requires an
         explicit sales-count match; "no sales" is a real zero day. */
      const m = text.match(/([\d,]+)\s+sales?\b/i);
      if (m) {
        const count = parseInt(m[1].replace(/,/g, ''), 10);
        if (isFinite(count)) return [{ date: this._venueYesterday(), count }];
      }
      if (/\bno sales\b/i.test(text)) {
        return [{ date: this._venueYesterday(), count: 0 }];
      }

      return []; /* unrecognised file: apiIngest reports "nothing parsed" */
    },

    async status(env, h) {
      const ls = await lastSync(env, 'pos');
      if (!ls) return { connected: false };
      return { connected: true, org: 'Lightspeed (daily report feed)', sandbox: false, lastSync: ls };
    },

    async fetchRange(env, h, q) {
      const r = await h.readIngested(q.from, q.to);
      if (!r.daysWithData) return { count: null };
      return { count: r.sums.count || 0 };
    },

    async fetchMonthly(env, h, q) {
      const r = await h.monthlyIngested(q.fromMonth, q.toMonth);
      return { months: r.months, count: r.byMonth.map((m) => (m ? (m.count || 0) : null)) };
    }
  },

  /* >>> ADAPTER 3: ROSTERING (optional - only if the owner has one)
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { cost }    (rostered labour cost for the
                                  period; powers the PROJECTED wage % only)
     If this source is gated or absent, leave configured:false - the actual
     Wage % from accounting already covers the board (fallback ladder).
     Example (Deputy): pasted permanent token (secret ROSTERING_API_TOKEN).
  */
  rostering: {
    /* Connecteam - wired July 2026 for projected Wage % only.
       Rostered cost = published, assigned shift hours (unpaid breaks
       deducted) x each user's effective hourly pay rate, x 1.12 super
       loading (SG 12%) so PROJECTED is comparable to the ACTUAL Wage %,
       which includes super per kpi-spec.md. Secret: ROSTERING_API_TOKEN
       (X-API-KEY header). If no pay rates are configured in Connecteam,
       the projected card honestly shows not configured - never a $0 cost. */
    configured: true,
    auth: 'token',
    oauth: {},
    _base: 'https://api.connecteam.com',
    _superLoading: 1.12,

    async _get(env, path) {
      const res = await fetch(this._base + path, {
        headers: { 'X-API-KEY': env.ROSTERING_API_TOKEN || '', Accept: 'application/json' }
      });
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    },

    async _schedulers(env) {
      const data = await this._get(env, '/scheduler/v1/schedulers');
      const list = (data && data.data && (data.data.schedulers || data.data)) || data.schedulers || [];
      return Array.isArray(list) ? list : [];
    },

    /* userId -> hourly rate effective at `asOf` (YYYY-MM-DD). Entries are
       effective-dated; pick the latest effectiveDate <= asOf per user. */
    async _rateMap(env, asOf) {
      const data = await this._get(env, '/pay-rates/v1/pay-rates');
      const entries = (data && data.data && (data.data.payRates || data.data)) || data.payRates || [];
      const rateOf = (e) => {
        for (const k of ['payRate', 'hourlyRate', 'rate', 'amount', 'value']) {
          if (typeof e[k] === 'number' && isFinite(e[k])) return e[k];
        }
        return null;
      };
      const map = {};
      for (const e of (Array.isArray(entries) ? entries : [])) {
        const uid = e.userId; const rate = rateOf(e);
        if (!uid || rate == null) continue;
        const eff = String(e.effectiveDate || '0000-00-00').slice(0, 10);
        if (eff > asOf) continue;
        if (!map[uid] || eff >= map[uid].eff) map[uid] = { eff, rate };
      }
      const out = {};
      for (const [uid, v] of Object.entries(map)) out[uid] = v.rate;
      return out;
    },

    /* All published shifts across all schedules, unix range, paginated. */
    async _shifts(env, startUnix, endUnix) {
      const scheds = await this._schedulers(env);
      const all = [];
      for (const s of scheds.slice(0, 20)) {
        const sid = s.id || s.schedulerId;
        if (!sid) continue;
        let offset = 0, pages = 0;
        for (;;) {
          const data = await this._get(env,
            '/scheduler/v2/schedulers/' + sid + '/shifts?startTime=' + startUnix +
            '&endTime=' + endUnix + '&isPublished=true&limit=500&offset=' + offset);
          const shifts = (data && data.data && data.data.shifts) || [];
          all.push(...shifts);
          pages++;
          if (shifts.length < 500 || pages >= 10) break;
          offset = (data.paging && data.paging.offset) || (offset + 500);
        }
      }
      return all;
    },

    _cost(shifts, rates) {
      let cost = 0, rated = 0, unrated = 0;
      for (const sh of shifts) {
        const users = sh.assignedUserIds || [];
        if (!users.length) continue; /* unassigned/open: no committed cost */
        let hours = (sh.endTime - sh.startTime) / 3600;
        for (const b of (sh.breaks || [])) {
          if (b.type === 'unpaid') hours -= (b.duration || 0) / 60;
        }
        if (!(hours > 0)) continue;
        for (const uid of users) {
          const rate = rates[uid];
          if (rate == null) { unrated++; continue; }
          rated++;
          cost += hours * rate * this._superLoading;
        }
      }
      return { cost, rated, unrated };
    },

    async status(env, h) {
      if (!env.ROSTERING_API_TOKEN) return { connected: false };
      try {
        const scheds = await this._schedulers(env);
        if (!scheds.length) return { connected: false, error: 'Connected, but no schedule was found in this Connecteam account.' };
        await h.noteSync();
        return {
          connected: true,
          org: 'Connecteam: ' + (scheds[0].name || scheds[0].title || 'schedule') + (scheds.length > 1 ? ' +' + (scheds.length - 1) + ' more' : ''),
          sandbox: false,
          lastSync: await lastSync(env, 'rostering')
        };
      } catch (e) {
        return { connected: false, error: plainError(e.status || 500) };
      }
    },

    async fetchRange(env, h, q) {
      /* Venue-local range -> unix. Brisbane is UTC+10, no DST. */
      const startUnix = Math.floor(Date.parse(q.from + 'T00:00:00+10:00') / 1000);
      const endUnix = Math.floor(Date.parse(q.to + 'T23:59:59+10:00') / 1000);
      const [shifts, rates] = [await this._shifts(env, startUnix, endUnix), await this._rateMap(env, q.to)];
      if (!Object.keys(rates).length) throw new NotConfigured('rostering'); /* no pay rates set up: never fake a $0 */
      const r = this._cost(shifts, rates);
      if (r.rated === 0 && r.unrated > 0) throw new NotConfigured('rostering');
      await h.noteSync();
      return { cost: r.cost };
    },

    async fetchMonthly(env, h, q) { return { months: [], cost: [] }; }
  }
};

/* ============================================================================
   Everything below is the shell. You should rarely need to edit it.
============================================================================ */

class NotConfigured extends Error {
  constructor(source) { super('not configured: ' + source); this.source = source; }
}

const PLAIN_ERRORS = {
  401: 'This connection needs reconnecting. Click Reconnect and log in again.',
  403: 'This connection is missing a permission it needs. Your AI will sort out the access.',
  429: 'The tool is asking us to slow down. Wait a few minutes, then refresh.',
  500: 'The tool had a problem at its end. Try refresh in a little while.',
  504: 'This tool took too long to answer and was skipped this time. The rest of the board is up to date; try refresh.'
};
function plainError(status) {
  return PLAIN_ERRORS[status] || ('Something went wrong talking to this tool (code ' + status + '). Try refresh; if it persists, tell your AI.');
}

/* ---------------- Token store (KV) with refresh built in ---------------- */

async function getTokens(env, source) {
  const raw = await env.TOKENS.get('tokens:' + source);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(env, source, tokens) {
  await env.TOKENS.put('tokens:' + source, JSON.stringify(tokens));
}
async function clearTokens(env, source) {
  await env.TOKENS.delete('tokens:' + source);
}
async function noteSync(env, source) {
  await env.TOKENS.put('lastSync:' + source, new Date().toISOString());
}
async function lastSync(env, source) {
  return await env.TOKENS.get('lastSync:' + source);
}

/* Build the POST to an OAuth token endpoint, honouring the adapter's client-auth
   method. tokenAuth:'basic' -> client id+secret in an HTTP Basic Authorization
   header, NOT in the body (Xero and most OpenID providers expect this); 'post'
   (or unset, for back-compat) -> client_id/client_secret in the form body. */
function tokenRequestInit(cfg, params, env) {
  const id = env[cfg.clientIdSecret] || '';
  const secret = env[cfg.clientSecretSecret] || '';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if ((cfg.tokenAuth || 'post') === 'basic') {
    headers['Authorization'] = 'Basic ' + btoa(id + ':' + secret);
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }
  return { method: 'POST', headers: headers, body: body.toString() };
}

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed.
   COLLISION-PROOF: providers with single-use refresh tokens (Xero) revoke a
   connection if two requests refresh with the same token, so (a) concurrent
   callers in this isolate share ONE in-flight refresh, and (b) if a refresh
   fails, re-read KV first - a parallel isolate may have already refreshed
   and saved a newer token - and only then declare the connection dead. */
const REFRESH_INFLIGHT = {};
async function getValidAccessToken(env, source) {
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  if (REFRESH_INFLIGHT[source]) return REFRESH_INFLIGHT[source];
  REFRESH_INFLIGHT[source] = (async () => {
    try {
      /* refresh */
      const cfg = adapter.oauth || {};
      if (!tokens.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
      const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token
      }, env));
      if (!res.ok) {
        /* Before giving up: another isolate may have spent this single-use
           refresh token and saved the rotated pair. Re-read and use it. */
        const latest = await getTokens(env, source);
        if (latest && latest.access_token && latest.expires_at && Date.now() < latest.expires_at - skewMs) {
          return latest.access_token;
        }
        const e = new Error('refresh failed'); e.status = 401; throw e;
      }
      const fresh = await res.json();
      const updated = {
        ...tokens,
        access_token: fresh.access_token,
        /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
        refresh_token: fresh.refresh_token || tokens.refresh_token,
        expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
      };
      await saveTokens(env, source, updated);
      return updated.access_token;
    } finally {
      delete REFRESH_INFLIGHT[source];
    }
  })();
  return REFRESH_INFLIGHT[source];
}

/* Helpers handed to every adapter call */
function makeHelpers(env, source) {
  return {
    getValidAccessToken: () => getValidAccessToken(env, source),
    getTokens: () => getTokens(env, source),
    saveTokens: (t) => saveTokens(env, source, t),
    noteSync: () => noteSync(env, source),
    saveIngestedRows: (rows) => saveIngestedRows(env, source, rows),
    readIngested: (from, to) => readIngested(env, source, from, to),
    monthlyIngested: (fromMonth, toMonth) => monthlyIngested(env, source, fromMonth, toMonth),
    /* fetch JSON with one automatic refresh-and-retry on 401 (OAuth sources) */
    fetchJson: async (url, init, opts) => {
      const useAuth = !opts || opts.auth !== false;
      const doFetch = async () => {
        const headers = new Headers((init && init.headers) || {});
        if (useAuth && ADAPTERS[source].auth === 'oauth') {
          headers.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
        }
        return fetch(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    }
  };
}

/* ---------------- OAuth begin + callback (generic, per-source) ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Owner login: one passcode + a signed session cookie ----
   The owner sets the dashboard password on the dashboard's own FIRST-RUN screen;
   it is stored PBKDF2-hashed in KV (sys:passcode_hash) - no Cloudflare Variables
   step. (env.DASHBOARD_PASSCODE still works as an override, e.g. when the
   one-click button collected it in its wizard.) The session-signing key is
   generated and stored in KV on first run (env.SESSION_SECRET overrides if set).
   Until a password exists the dashboard shows the SET-PASSWORD screen, never an
   open page; once set, the page and every data route require a valid session. */
const SESSION_TTL = 60 * 60 * 24 * 30;
/* A password exists if the owner set one (first-run -> KV) or the deploy provided
   one as an env override (the one-click button's wizard). */
async function passcodeSet(env) {
  if (env.DASHBOARD_PASSCODE) return true;
  if (env.TOKENS) return !!(await env.TOKENS.get('sys:passcode_hash'));
  return false;
}
/* PBKDF2-SHA256 of a passcode with a hex salt -> base64url (at-rest hashing). */
async function pbkdf2B64(passcode, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
let _sessionKeyCache = null;
async function getSessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_sessionKeyCache) return _sessionKeyCache;
  if (env.TOKENS) {
    let k = await env.TOKENS.get('sys:session_secret');
    if (!k) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      k = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.TOKENS.put('sys:session_secret', k);
    }
    _sessionKeyCache = k;
    return k;
  }
  return env.DASHBOARD_PASSCODE || 'unset';
}
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function shaB64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeSession(env) {
  const payload = 'v1.' + Math.floor(Date.now() / 1000);
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function validSession(env, token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return false;
  const issued = parseInt(payload.split('.')[1], 10);
  return !!issued && (Date.now() / 1000 - issued) <= SESSION_TTL;
}
function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'vd_session'));
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
async function apiLogin(env, request) {
  if (!(await passcodeSet(env))) return json({ ok: false, error: 'no_passcode' }, 400);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  let okPass = false;
  if (env.DASHBOARD_PASSCODE) {
    okPass = timingSafeEqual(await shaB64(passcode), await shaB64(env.DASHBOARD_PASSCODE));
  } else if (env.TOKENS) {
    const stored = await env.TOKENS.get('sys:passcode_hash');
    if (stored) {
      const dot = stored.indexOf('.');
      okPass = timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1));
    }
  }
  if (!okPass) return json({ ok: false }, 401);
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}

/* First-run (or authenticated change): set the dashboard password. Allowed only
   when none is set yet, OR when the caller already holds a valid session - so a
   stranger can never overwrite an existing password. Stored PBKDF2-hashed in KV. */
async function apiSetup(env, request) {
  if (!env.TOKENS) return json({ ok: false, error: 'no_store' }, 400);
  if ((await passcodeSet(env)) && !(await isLoggedIn(request, env))) return json({ ok: false, error: 'exists' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:passcode_hash', saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
}
function loginPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Your dashboard</h1><p>Enter the password for this dashboard.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="Password" autofocus>'
    + '<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:document.getElementById("p").value})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="That password did not match. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

function setupPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set your password</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Set your password</h1><p>Choose a password for your dashboard. You\u2019ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="new-password" placeholder="New password" autofocus>'
    + '<input id="p2" type="password" autocomplete="new-password" placeholder="Confirm password" style="margin-top:10px">'
    + '<button type="submit">Save and open my dashboard</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'var p=document.getElementById("p").value,p2=document.getElementById("p2").value;'
    + 'if(p.length<6){e.textContent="Use at least 6 characters.";return;}'
    + 'if(p!==p2){e.textContent="The two passwords do not match.";return;}'
    + 'fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="Could not save that. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

async function authStart(env, source, url) {
  const adapter = ADAPTERS[source];
  if (!adapter || adapter.auth !== 'oauth' || !adapter.oauth.authorizeUrl) {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const cfg = adapter.oauth;
  const state = randomState();
  await env.TOKENS.put('oauthstate:' + source, state, { expirationTtl: 600 });
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env[cfg.clientIdSecret] || '',
    redirect_uri: redirectUri,
    scope: cfg.scopes || '',
    state
  });
  return Response.redirect(cfg.authorizeUrl + '?' + p.toString(), 302);
}

async function authCallback(env, source, url) {
  const adapter = ADAPTERS[source];
  const cfg = (adapter && adapter.oauth) || {};
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const wantState = await env.TOKENS.get('oauthstate:' + source);
  if (!code || !gotState || gotState !== wantState) {
    return new Response('That authorisation didn’t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    return new Response('The connection couldn’t be finished (the tool said no: ' + res.status + '). Your AI will check the app settings - the usual cause is a redirect address that doesn’t match exactly.', { status: 502 });
  }
  const t = await res.json();
  await saveTokens(env, source, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    token_type: t.token_type || 'Bearer',
    expires_at: Date.now() + ((t.expires_in || 1800) * 1000),
    obtained_at: new Date().toISOString()
  });
  /* After token storage, adapters' status() should resolve org name etc. */
  return Response.redirect(url.origin + '/', 302);
}

/* ---------------- No-API ingest: KV day-store + endpoint ---------------- */

/* Day rows live at data:<source>:<YYYY-MM-DD> as JSON objects of numeric
   fields. Same-day re-uploads overwrite (idempotent; re-ingesting a corrected
   export is safe and expected). */
async function saveIngestedRows(env, source, rows) {
  if (!Array.isArray(rows)) return 0;
  let saved = 0;
  for (const r of rows) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'date' && typeof v === 'number' && isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) continue;
    await env.TOKENS.put('data:' + source + ':' + r.date, JSON.stringify(clean));
    saved++;
  }
  return saved;
}

function eachDate(from, to, cap) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d.getTime() <= end.getTime() && out.length < (cap || 400)) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Sum stored day rows across a range. Returns { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const sums = {};
  let daysWithData = 0, lastDate = null;
  for (const date of eachDate(from, to)) {
    const raw = await env.TOKENS.get('data:' + source + ':' + date);
    if (!raw) continue;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  }
  return { sums, daysWithData, lastDate };
}

async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const out = { months, byMonth: [] };
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = await readIngested(env, source, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'));
    out.byMonth.push(r.daysWithData ? r.sums : null);
  }
  return out;
}

/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!['accounting', 'pos', 'rostering'].includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  /* Webhook senders (e.g. Lightspeed Insights' report scheduler) cannot set an
     Authorization header, so the same token is also accepted as ?token= in the
     delivery URL. Both compare against the single INGEST_TOKEN secret. */
  const qtoken = url.searchParams.get('token') || '';
  const ok = env.INGEST_TOKEN && (auth === 'Bearer ' + env.INGEST_TOKEN || qtoken === env.INGEST_TOKEN);
  if (!ok) {
    return json({ error: 'not authorised', plain: 'That upload code didn\u2019t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn\u2019t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it\u2019s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: 'That file couldn\u2019t be read. Check it\u2019s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/.exec(s);
  return m ? { fromMonth: m[1], toMonth: m[2] } : null;
}

/* Race any source call against a timeout: one slow/unreachable provider must
   never hang the whole board. On timeout the source degrades to its error
   state (the card shows a plain "took too long" note), everything else renders. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => {
      const e = new Error('timeout: ' + (label || '')); e.status = 504; reject(e);
    }, ms))
  ]);
}
const SOURCE_TIMEOUT_MS = 8000;

async function sourceStatus(env, source) {
  const adapter = ADAPTERS[source];
  if (!adapter || !adapter.configured) return { configured: false };
  try {
    const h = makeHelpers(env, source);
    const st = await withTimeout(adapter.status(env, h), SOURCE_TIMEOUT_MS, source);
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: !!(st && st.connected),
      org: (st && st.org) || null,
      sandbox: !!(st && st.sandbox),
      lastSync: (st && st.lastSync) || (await lastSync(env, source)) || null,
      error: null
    };
  } catch (err) {
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: false,
      org: null,
      sandbox: false,
      lastSync: (await lastSync(env, source)) || null,
      error: { code: err.status || 0, plain: plainError(err.status || 500) }
    };
  }
}

async function fetchSlot(env, q) {
  /* One period slot: pull each configured source; null where unavailable. */
  const out = {};
  for (const source of ['accounting', 'pos', 'rostering']) {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) { out[source] = null; continue; }
    try {
      const h = makeHelpers(env, source);
      out[source] = await withTimeout(adapter.fetchRange(env, h, q), SOURCE_TIMEOUT_MS, source);
      await noteSync(env, source);
    } catch (err) {
      out[source] = null; /* per-source failure/timeout never breaks the whole payload */
    }
  }
  return out;
}

const METRICS_CACHE_TTL = 120; /* seconds: brief cache for live provider data */

async function apiMetrics(env, url) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));

  const base = { tz, rollover };
  const [sAcc, sPos, sRos] = await Promise.all([
    sourceStatus(env, 'accounting'),
    sourceStatus(env, 'pos'),
    sourceStatus(env, 'rostering')
  ]);

  /* The provider calls (periods + trend) are the expensive part and the only
     thing that brushes provider rate limits on quick reopens/refreshes. Cache
     them briefly in KV, keyed by the requested ranges; source status stays live.
     generatedAt is stored with the data so the dashboard's "last synced" reflects
     the real fetch time even when served from cache. ?refresh=1 forces fresh. */
  const cacheKey = 'metricscache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', url.searchParams.get('trend') || '',
    tz, rollover
  ].join('|');
  const force = url.searchParams.get('refresh') === '1';
  let data = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { data = JSON.parse(cached); } catch (e) { data = null; } }
  }
  if (!data) {
    const periods = {};
    periods.cur = await fetchSlot(env, { ...base, ...cur });
    periods.prev = prev ? await fetchSlot(env, { ...base, ...prev }) : null;
    periods.yoy = yoy ? await fetchSlot(env, { ...base, ...yoy }) : null;

    let trendOut = null;
    if (trend) {
      trendOut = { months: monthList(trend.fromMonth, trend.toMonth) };
      for (const source of ['accounting', 'pos']) {
        const adapter = ADAPTERS[source];
        if (!adapter || !adapter.configured) { trendOut[source] = null; continue; }
        try {
          const h = makeHelpers(env, source);
          const series = await adapter.fetchMonthly(env, h, { ...base, ...trend });
          trendOut[source] = alignSeries(trendOut.months, series);
        } catch (err) { trendOut[source] = null; }
      }
    }
    data = { generatedAt: new Date().toISOString(), periods: periods, trend: trendOut };
    if (env.TOKENS) {
      try { await env.TOKENS.put(cacheKey, JSON.stringify(data), { expirationTtl: METRICS_CACHE_TTL }); } catch (e) {}
    }
  }

  return json({
    generatedAt: data.generatedAt,
    protected: true,
    sources: { accounting: sAcc, pos: sPos, rostering: sRos },
    periods: data.periods,
    trend: data.trend
  });
}

function monthList(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
/* Adapters return {months:[...], <field>:[...]} - align onto the requested grid. */
function alignSeries(months, series) {
  if (!series || !Array.isArray(series.months)) return null;
  const idx = {};
  series.months.forEach((mo, i) => { idx[mo] = i; });
  const out = {};
  Object.keys(series).forEach((k) => {
    if (k === 'months') return;
    out[k] = months.map((mo) => (mo in idx && series[k] ? (series[k][idx[mo]] ?? null) : null));
  });
  return out;
}

/* ---------------- Router ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);

    const loggedIn = await isLoggedIn(request, env);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(dashboardHtml);
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url);
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering)\/(start|callback)$/.exec(path);
    if (authRoute && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return authRoute[2] === 'start' ? authStart(env, authRoute[1], url) : authCallback(env, authRoute[1], url);
    }
    if (path === '/api/disconnect' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source');
      if (['accounting', 'pos', 'rostering'].includes(source)) {
        await clearTokens(env, source);
        return json({ ok: true });
      }
      return json({ error: 'unknown source' }, 400);
    }
    return new Response('Not found', { status: 404 });
  },

  /* Cron rung: uncomment [triggers] in wrangler.toml and give any adapter a
     scheduledPull() to fetch its tool's own export on a schedule. */
  async scheduled(event, env, ctx) {
    for (const source of ['accounting', 'pos', 'rostering']) {
      const a = ADAPTERS[source];
      if (a && typeof a.scheduledPull === 'function') {
        try {
          await a.scheduledPull(env, makeHelpers(env, source));
          await noteSync(env, source);
        } catch (e) {
          console.log('scheduledPull failed for ' + source + ': ' + (e && e.message));
        }
      }
    }
  },

  /* Email rung (Path B): the tool's own report scheduler emails its export;
     the owner's domain on their Cloudflare routes that address here (Email
     Routing -> this Worker). Complete when this rung is chosen:
       1. parse the message with postal-mime (add the dependency)
       2. find the CSV/report attachment, work out which source sent it
          (sender address or subject)
       3. reuse adapter.parseExport + saveIngestedRows + noteSync, exactly
          like /api/ingest
     Until then this logs and discards. */
  async email(message, env, ctx) {
    console.log('email received from ' + message.from + '; email ingest not wired yet');
  }
};
// EOF worker.js
