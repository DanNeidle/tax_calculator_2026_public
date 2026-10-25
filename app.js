/*
(c) Tax Policy Associates Ltd, 2026, licensed under the MIT licence.
Permission is hereby granted, free of charge, to any person obtaining a copy of this software,
to use it however they wish provided they attribute it to Tax Policy Associates Ltd. Thank you!

Presentation only. Actual content comes from taxEngine.js.
*/
const { createApp, markRaw } = Vue;

/* Chart marks, validated against the dataviz six checks in light mode:
   lightness band, chroma floor, CVD separation (worst adjacent ΔE 29.2 protan),
   normal-vision floor (41.8) and contrast vs surface. Do not substitute by eye. */
const SERIES_1 = '#2B52D8';
const SERIES_2 = '#FF5733';
const INK = '#16181d';
const INK_3 = '#606879';
const GRID_LINE = '#e8ebf3';

const MAX_INCOME = 180000;
const STEP = 500;                 // chart sampling; marginal rates are for the next £1
const SLIDER_MAX = 250000;        // reaches past the top 1% notch at £207,000
const CURRENT_DATASET = '2026-27';
const MAX_ENTRY = 10000000;
const VERSION = 'v1.1';
// show the headroom line when the next threshold is this close
const HEADROOM_WINDOW = 10000;

function parseMoney(text, maximum) {
    const raw = text.trim().replace(/^£\s*/, '');
    if (!raw) return 0;
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{0,2})?$/.test(raw)) return null;
    const value = Number(raw.replace(/,/g, ''));
    return Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
}

/*
 * A £ a year field for the extra income and benefit boxes. Like the pay field,
 * it keeps what was typed while it has focus, so reformatting can't fight the keyboard.
 * Anything in the default slot (an information icon) sits beside the label.
 */
const MoneyInput = {
    props: { modelValue: { type: Number, default: 0 }, inputId: String, label: String },
    emits: ['update:modelValue'],
    data() { return { text: '', editing: false, error: '' }; },
    computed: {
        shown() {
            const v = Number(this.modelValue);
            return v > 0 ? v.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : '';
        }
    },
    methods: {
        onFocus(e) { this.editing = true; this.text = this.shown; e.target.select(); },
        // A half-typed "5," isn't an error yet, so a bad entry is only flagged on leaving the field.
        onBlur() {
            this.editing = false;
            this.error = parseMoney(this.text, MAX_ENTRY) === null ? 'Enter an amount from £0 to £10,000,000.' : '';
        },
        onInput(e) {
            this.text = e.target.value;
            const value = parseMoney(this.text, MAX_ENTRY);
            if (value === null) return;
            this.error = '';
            this.$emit('update:modelValue', value);
        }
    },
    template: `<div class="control">
        <div class="control__head"><label :for="inputId">{{ label }}</label><slot></slot></div>
        <div class="salary__field salary__field--sm">
            <span class="salary__prefix" aria-hidden="true">£</span>
            <input :id="inputId" class="salary__input" type="text" inputmode="decimal" autocomplete="off"
                   :value="editing || error ? text : shown" :aria-invalid="!!error" :aria-describedby="error ? inputId + '-error' : null"
                   @input="onInput" @focus="onFocus" @blur="onBlur">
            <span class="salary__suffix" aria-hidden="true">a year</span>
        </div>
        <p class="field-error" :id="inputId + '-error'" v-if="error" role="alert">{{ error }}</p>
    </div>`
};


/*
 * To prevent lazy tomfoolery, it refuses to run inside a frame it does
 * not recognise. Standalone use is always allowed.
 * we can't stop clever tomfoolery.
 */
const ALLOWED_FRAME_HOSTS = ['taxpolicy.org.uk', 'localhost', '127.0.0.1'];

function frameHostAllowed(hostname) {
    return ALLOWED_FRAME_HOSTS.indexOf(hostname) !== -1 || /\.taxpolicy\.org\.uk$/.test(hostname);
}

// Inside an article the page drops its own background and margins, so only the two panels show.
if (window.self !== window.top) document.documentElement.classList.add('is-framed');

function framingAllowed() {
    if (window.self === window.top) {
        return true;
    }
    // Chrome and Safari expose the full ancestor chain, which is unspoofable.
    try {
        const ancestors = window.location.ancestorOrigins;
        if (ancestors && ancestors.length) {
            for (let i = 0; i < ancestors.length; i++) {
                try {
                    if (!frameHostAllowed(new URL(ancestors[i]).hostname)) return false;
                } catch (e) { return false; }
            }
            return true;
        }
    } catch (e) { /* not available; fall through */ }
    // Firefox has no ancestorOrigins: the referrer is the framing document.
    try {
        if (document.referrer) {
            return frameHostAllowed(new URL(document.referrer).hostname);
        }
    } catch (e) { /* unparseable */ }
    return false;
}

function renderFrameBlock() {
    const host = document.getElementById('app');
    if (!host) return;
    host.removeAttribute('v-cloak');
    host.innerHTML =
        '<section class="frame-block">' +
        '<h1>This calculator is published by Tax Policy Associates</h1>' +
        '<p>It is not available for embedding on other sites. You can use it, free, on our own page.</p>' +
        '<p><a class="frame-block__link" href="https://taxpolicy.org.uk/uk-tax-calculator" target="_blank" rel="noopener">' +
        'Open the UK tax calculator</a></p>' +
        '</section>';
}

const APP_OPTIONS = {
    components: { 'money-input': MoneyInput },

    data() {
        return {
            taxData: {},
            ready: false,
            loadError: false,
            income: 60000,
            incomeDisplay: '60,000',
            editing: false,
            incomeError: '',
            pensionError: '',
            // The pension field keeps what was typed while it has focus, as the
            // income field does, so reformatting can't fight the keyboard.
            pensionEditing: false,
            pensionText: '',
            optionsOpen: false,
            childcareHelpOpen: false,
            exportingImage: false,
            downloadError: '',
            announcement: '',
            announcementTimer: null,
            resizeObserver: null,
            scotland: false,
            compareDataset: null,
            compareOpen: false,
            chartType: 'marginal',
            chartTypes: [
                { id: 'marginal', label: 'Marginal rate' },
                { id: 'effective', label: 'Effective rate' },
                { id: 'net', label: 'Net v gross' }
            ],
            employmentTypes: ['Employed', 'Self-employed', 'Partnership/LLP', 'Within IR35', 'Working past State Pension age', 'Pension income'],
            household: TaxEngine.household({}),
            chart: null,
            // On a phone the floating tooltip would cover the chart, so the values
            // under the finger go in a strip above it instead.
            compactChart: false,
            scrubGross: null,
            hasAnimatedIn: false,
            frame: null,
            pendingReplay: false,
            morphNext: false,
            openPanel: null,
            openTip: null,
            exportConfirm: null,
            exportAcknowledged: false,
            exportTrigger: null,
            wayOutDismissed: false,
            version: VERSION
        };
    },

    computed: {
        dataset() {
            return `${CURRENT_DATASET} ${this.scotland ? 'Scotland' : 'UK'}`;
        },
        activeData() { return this.taxData[this.dataset] || null; },
        compareData() { return this.compareDataset ? this.taxData[this.compareDataset] : null; },

        summary() {
            if (!this.activeData) return this.emptySummary();
            return TaxEngine.summary(this.income, this.activeData, this.household);
        },
        compareSummary() {
            if (!this.compareData) return null;
            return TaxEngine.summary(this.income, this.compareData, this.household);
        },
        /** Difference of the two displayed amounts, so the three figures agree. */
        compareDelta() {
            return this.compareSummary
                ? Math.round(this.compareSummary.netIncome) - Math.round(this.summary.netIncome) : 0;
        },
        compareVerdict() {
            const who = `Under ${this.datasetLabel(this.compareDataset)} you'd be`;
            if (this.compareDelta === 0) return `${who} no better or worse off`;
            return `${who} ${this.fmtMoney(Math.abs(this.compareDelta))} a year ${this.compareDelta > 0 ? 'better' : 'worse'} off`;
        },

        /**
         * The results list in whole pounds. Each figure is rounded so the
         * deductions add up exactly to the cash take-home shown on the card, and
         * the support lines add up to net income including support.
         */
        resultRows() {
            const s = this.summary;
            const rows = [
                { label: 'Income tax', amount: s.incomeTaxAmount },
                { label: `National insurance${s.employerNi ? ' (including employer NI)' : ''}`, amount: s.ni.total + s.employerNi }
            ];
            if (this.household.includeStudentLoan) rows.push({ label: 'Student loan repayments', amount: s.loanRepayments });
            if (s.capitalGainsTax > 0) rows.push({ label: 'Capital gains tax', amount: s.capitalGainsTax });
            if (s.pensionEmployeeOutlay > 0) {
                // Rounded on its own, so it matches the "you pay" hint; tax and NI absorb the spare pound.
                rows.push({ label: s.pensionMethod === 'relief_at_source'
                    ? 'Paid to your pension provider' : 'Pension contributions from pay', amount: s.pensionEmployeeOutlay, fixed: true });
            }
            if (s.otherSacrifice > 0) rows.push({ label: 'Other salary sacrifice', amount: s.otherSacrifice, fixed: true });
            const cash = Math.round(s.cashTakeHome);
            this.roundToTotal(rows, Math.round(s.cashIncome) - cash);
            rows.push({ label: 'Cash take-home', amount: cash, total: true });
            const support = [];
            if (s.childBenefitCredit) support.push({ label: 'Child benefit received', amount: s.childBenefitCredit });
            if (this.household.childcareSubsidyAmount) support.push({ label: 'Childcare support retained', amount: s.childcareCredit });
            if (support.length) {
                const net = Math.round(s.netIncome);
                this.roundToTotal(support, net - cash);
                rows.push(...support, { label: 'Net income including benefits and support', amount: net, total: true });
            }
            return rows;
        },

        /**
         * The axis normally stops at £180,000, but an income above that would fly
         * off the chart. Extend to 10% beyond what was entered, rounded up to a
         * clean figure so the labels stay readable. You're welcome, Elon.
         */
        chartMax() {
            if (this.income <= MAX_INCOME) return MAX_INCOME;
            const target = this.income * 1.1;
            const round = target > 1000000 ? 100000 : 10000;
            return Math.ceil(target / round) * round;
        },
        /** Keep the sample count roughly constant however far the axis extends. */
        chartStep() {
            return Math.max(STEP, Math.round(this.chartMax / 360 / STEP) * STEP);
        },
        curve() {
            if (!this.activeData) return null;
            return TaxEngine.curve(this.activeData, this.household, this.chartMax, this.chartStep);
        },
        compareCurve() {
            if (!this.compareData) return null;
            return TaxEngine.curve(this.compareData, this.household, this.chartMax, this.chartStep);
        },

        datasetNames() { return Object.keys(this.taxData); },
        yearDatasets() {
            return this.datasetNames.filter(n => this.taxData[n]._meta.kind === 'regime' && n !== this.dataset);
        },
        proposalDatasets() {
            return this.datasetNames.filter(n => this.taxData[n]._meta.kind === 'proposal');
        },
        loanPlans() { return TaxEngine.STUDENT_LOAN_PLANS; },

        pensionEnabled() { return this.household.employmentType !== 'Pension income'; },
        workplacePension() { return !TaxEngine.isSelfEmploymentType(this.household) && this.pensionEnabled; },
        investmentsTotal() {
            const i = this.summary.investments;
            return i ? i.savings + i.dividends + i.gains + (Number(this.household.rentalIncome) || 0) : 0;
        },
        pensionActive() { return Number(this.household.pensionContribution) > 0; },
        pensionDisplay() {
            const v = this.household.pensionContribution;
            if (!v) return '';
            return this.household.pensionBasis === 'percent' ? String(v) : Number(v).toLocaleString('en-GB');
        },
        pensionCapNotice() {
            const s = this.summary;
            if (!s.pensionCapped) return '';
            const amount = this.fmtMoney(s.pensionGross);
            if (s.pensionMethod === 'relief_at_source') {
                return `Tax relief is limited to ${amount}: the greater of your earnings and £3,600, so the calculator uses that amount.`;
            }
            return s.pensionMethod === 'sacrifice'
                ? `You can't sacrifice more than your pay, so the calculator uses ${amount}.`
                : `Net pay contributions can't exceed your pay, so the calculator uses ${amount}.`;
        },
        optionsWanted() {
            return this.pensionActive || this.household.includeStudentLoan || this.household.childcareSubsidyAmount > 0;
        },
        /** The last income that keeps childcare support, to the penny below. */
        childcareCliffText() {
            const cliff = this.childcareCliff;
            if (cliff === null) return '';
            const pence = Math.floor(cliff * 100 + 1e-6) / 100;
            return Math.abs(pence - Math.round(pence)) < 0.005 ? this.fmtMoney(pence) : this.fmtMoney(pence, true);
        },
        allowanceExcess() {
            return (this.summary.annualAllowance && this.summary.annualAllowance.excess) || 0;
        },

        childcareOptions() {
            return Array.from({ length: 9 }, (_, i) => ({ value: i * 2500,
                label: i === 0 ? 'None' : this.fmtMoney(i * 2500) }));
        },
        incomeLabel() {
            if (this.household.employmentType === 'Within IR35') return 'Annual contract income, including employer NI';
            if (TaxEngine.isSelfEmploymentType(this.household)) return 'Annual taxable profit';
            if (this.household.employmentType === 'Pension income') return 'Annual pension income before tax';
            return 'Annual income before tax and pension contributions';
        },
        incomeTip() {
            const extras = ' Use the boxes below the slider to add benefits in kind, pension income and investments. The chart follows this figure; the amounts in the boxes stay fixed.';
            if (TaxEngine.isSelfEmploymentType(this.household)) {
                return 'Your profit after the tax adjustments, not the figure in your accounts: add back disallowed expenses such as entertaining and depreciation, and deduct capital allowances. For a partner, your share of the partnership\'s taxable profit.' + extras;
            }
            if (this.household.employmentType === 'Within IR35') return 'The total the client pays for your work, out of which employer NI comes before your pay.' + extras;
            if (this.household.employmentType === 'Pension income') return 'Your pension income before tax. Use the Pension income box only for pensions you haven\'t included here.' + extras;
            return 'Your salary, before tax, NI and pension contributions.' + extras;
        },
        childcareCliff() { return this.activeData ? TaxEngine.childcareCliff(this.activeData, this.household, this.chartMax) : null; },
        comparisonNote() {
            const meta = this.compareData?._meta;
            if (!meta) return '';
            return meta.kind === 'proposal' ? `${meta.description} This is a proposal, not current law.`
                : 'Current 2026/27 rules for the selected nation. rUK means England, Wales and Northern Ireland.';
        },

        /**
         * The allowance leads the income tax breakdown: it is the first slice of
         * income and it bears no tax, so showing it as a £0 line makes the taper
         * visible instead of leaving the reader to infer it from a smaller band.
         */
        personalAllowanceRow() {
            const statutory = (this.activeData && this.activeData['statutory personal allowance']) || 0;
            const used = this.summary.personalAllowance || 0;
            return {
                label: used < statutory
                    ? `Personal allowance reduced to ${this.fmtMoney(used)}`
                    : `Personal allowance of ${this.fmtMoney(used)}`,
                amount: 0,
                tapered: used < statutory
            };
        },

        adjustments() {
            const out = [];
            for (const a of this.summary.incomeTax.adjustments || []) {
                out.push({ label: a.label, amount: a.amount, credit: a.type === 'credit' });
            }
            if (this.summary.childBenefitCredit > 0) {
                out.push({ label: 'Child benefit', amount: this.summary.childBenefitCredit, credit: true });
            }
            if (this.summary.childcareCredit > 0) {
                out.push({ label: 'Childcare support retained', amount: this.summary.childcareCredit, credit: true });
            }
            return out;
        },


        chartTitle() {
            if (this.chartType === 'marginal') return 'Your marginal tax rate';
            if (this.chartType === 'effective') return 'Your effective tax rate';
            return 'Net income including support';
        },
        chartSubtitle() {
            const where = this.scotland ? 'Scotland' : 'the rest of the UK';
            if (this.chartType === 'marginal') {
                return `Tax, repayments and support withdrawn, ${CURRENT_DATASET} in ${where}`
                    + (this.axisFloor() < 0 ? '. Below 0%, pension tax relief on the next £1 exceeds the tax on it.' : '');
            }
            if (this.chartType === 'effective') {
                const hasNegative = [this.curve, this.compareCurve].some(curve => curve?.effective.some(rate => rate < 0));
                return `Deductions less benefits, support and pension tax relief, as a share of income, ${CURRENT_DATASET} in ${where}`
                    + (hasNegative ? '. Negative effective rates aren’t shown.' : '');
            }
            return `What you keep, ${CURRENT_DATASET} in ${where}`;
        },
        chartAriaLabel() {
            return `${this.chartTitle}. At ${this.fmtMoney(this.income)} your marginal rate is ` +
                   `${this.fmtPct(this.summary.marginalRate)} and your cash take-home is ${this.fmtMoney(this.summary.cashTakeHome)}. ` +
                   `The same figures are shown as text above the chart.`;
        },

        sliderMax() { return Math.max(SLIDER_MAX, this.income); },
        sliderTicks() { return [0, 0.25, 0.5, 0.75, 1].map(f => this.fmtMoney(f * this.sliderMax)); },
        // where each pound of gross pay goes, for the take-home bar.
        takeHomeSplit() {
            const s = this.summary, gross = Math.max(1, s.cashIncome);
            const cash = Math.round(s.cashTakeHome);
            const deductions = [
                { key: 'tax', label: 'Income tax', amount: s.incomeTaxAmount },
                { key: 'ni', label: s.employerNi ? 'NI including employer NI' : 'National insurance', amount: s.ni.total + s.employerNi }
            ];
            if (this.household.includeStudentLoan) deductions.push({ key: 'loan', label: 'Student loan', amount: s.loanRepayments });
            if (s.capitalGainsTax > 0) deductions.push({ key: 'cgt', label: 'Capital gains tax', amount: s.capitalGainsTax });
            if (s.pensionEmployeeOutlay > 0) {
                deductions.push({ key: 'pension', label: s.pensionMethod === 'relief_at_source' ? 'Paid to your pension provider' : 'Pension from pay',
                    amount: s.pensionEmployeeOutlay, fixed: true });
            }
            if (s.otherSacrifice > 0) deductions.push({ key: 'other', label: 'Other salary sacrifice', amount: s.otherSacrifice, fixed: true });
            this.roundToTotal(deductions, Math.round(s.cashIncome) - cash);
            return [{ key: 'home', label: 'Take-home', amount: cash }, ...deductions]
                .filter(p => p.amount > 0).map(p => ({ ...p, pct: 100 * p.amount / gross }));
        },
        // line-by-line tables, with a comparison column when one is chosen.
        detailTables() {
            const cur = this.summary, cmp = this.compareSummary;
            const merge = (pick) => {
                const rows = new Map();
                for (const [side, s] of [['cur', cur], ['cmp', cmp]]) {
                    if (!s) continue;
                    for (const r of pick(s)) {
                        if (!rows.has(r.label)) rows.set(r.label, { label: r.label, cur: null, cmp: null, kind: r.kind });
                        rows.get(r.label)[side] = r.amount;
                    }
                }
                return [...rows.values()];
            };
            const tables = [
                { title: 'Income tax', rows: merge(s => [
                    { label: 'Personal allowance', amount: s.personalAllowance || 0, kind: 'allowance' },
                    ...s.incomeTax.bands.map(b => ({ label: b.label, amount: b.amount })),
                    ...(s.incomeTax.adjustments || []).filter(a => a.label !== 'Student loan')
                        .map(a => ({ label: a.label, amount: a.type === 'credit' ? -Math.abs(a.amount) : Math.abs(a.amount) }))
                ]) },
                { title: 'National insurance', rows: merge(s => [
                    ...s.ni.bands.map(b => ({ label: b.label.replace(/^NI /, ''), amount: b.amount })),
                    ...(s.employerNi > 0 ? [{ label: 'Employer NI', amount: s.employerNi }] : [])
                ]) },
                { title: 'What you end up with', rows: merge(s => this.roundedOutcome(s)) }
            ];
            // Scottish and rUK bands interleave in rate order when both are shown
            const order = ['Starter', 'Basic', 'Intermediate', 'Higher', 'Advanced', 'Additional', 'Top'];
            const rank = r => r.kind === 'allowance' ? -1 : order.includes(r.label) ? order.indexOf(r.label) : 99;
            tables[0].rows.sort((x, y) => rank(x) - rank(y));
            return tables;
        },
        // reference points on the income slider. Production would keep these with their sources in the datasets file.
        sliderNotches() {
            return [
                { id: 'median', label: 'Median', value: 40911,
                  tip: 'Half of full-time employees earn more than £40,911 a year and half earn less.',
                  source: 'ONS, median gross annual pay for full-time employees, April 2026 (provisional)' },
                { id: 'top1', label: 'Top 1%', value: 207000,
                  tip: 'The top 1% of UK taxpayers have total income above £207,000.',
                  source: 'HMRC Survey of Personal Incomes, 2023/24 (latest available). Total income, not just pay' }
            ].map(n => ({ ...n, pct: 100 * n.value / this.sliderMax, active: Math.abs(this.income - n.value) < 500 }));
        },
        // arrow keys move the marker along the chart; Shift moves in £10,000 steps.
        chartValueText() {
            const rate = this.chartType === 'effective' ? this.summary.effectiveRate : this.summary.marginalRate;
            const what = this.chartType === 'effective' ? 'effective tax rate' : 'marginal tax rate';
            return `${this.fmtMoney(this.income)}: ${what} ${this.fmtPct(rate)}, take-home ${this.fmtMoney(this.headlineTakeHome)}${this.summary.childcareCredit > 0 ? ' including childcare' : ''}`;
        },
        // the phone readout: the plotted values at the income under the finger
        chartReadout() {
            if (this.scrubGross === null || !this.curve) return null;
            const gross = this.curve.gross;
            let lo = 0, hi = gross.length - 1;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (gross[mid] <= this.scrubGross) lo = mid; else hi = mid;
            }
            const i = Math.abs(gross[hi] - this.scrubGross) < Math.abs(gross[lo] - this.scrubGross) ? hi : lo;
            const isRate = this.chartType !== 'net';
            const show = v => (isRate ? this.fmtPct(v) : this.fmtMoney(v));
            const curves = this.compareCurve ? [this.curve, this.compareCurve] : [this.curve];
            return {
                gross: this.fmtMoney(gross[i]),
                what: { marginal: 'marginal rate', effective: 'effective rate', net: 'take-home' }[this.chartType],
                values: curves.map(c => show(this.seriesFor(c)[i]))
            };
        },
        // the headline counts childcare support kept, as the chart's net line does
        headlineTakeHome() { return Math.round(this.summary.cashTakeHome) + Math.round(this.summary.childcareCredit || 0); },
        // everything the user has set, in words, for the exports
        exportSettings() {
            const h = this.household;
            const methods = { sacrifice: 'salary sacrifice', netpay: 'workplace pension (net pay)', sipp: 'relief at source (SIPP, personal pension, NEST and similar)' };
            const plan = this.loanPlans.find(p => p.id === h.studentLoanPlan);
            const pension = !this.pensionActive ? 'None'
                : (h.pensionBasis === 'percent' ? `${h.pensionContribution}% of pay` : this.fmtMoney(Number(h.pensionContribution)) + ' a year')
                  + ` by ${methods[h.pensionMethod] || h.pensionMethod} (gross ${this.fmtMoney(this.summary.pensionGross)})`;
            const yearly = v => (v > 0 ? this.fmtMoney(v) + ' a year' : 'None');
            const inv = this.summary.investments || { savings: 0, dividends: 0, gains: 0 };
            return [
                ['Tax year', '2026/27'],
                [this.incomeLabel, this.fmtMoney(this.income)],
                ['How you’re paid', h.employmentType],
                ['Where you live', this.scotland ? 'Scotland' : 'Rest of UK (England, Wales or Northern Ireland)'],
                ['Children on child benefit', h.children ? String(h.children) : 'None'],
                ['Marriage allowance received', h.includeMarriageAllowance ? 'Yes' : 'No'],
                ['Pension contributions', pension],
                ['Student loan', h.includeStudentLoan && plan ? plan.label : 'None'],
                ['Childcare support at risk above £100,000', h.childcareSubsidyAmount ? this.fmtMoney(h.childcareSubsidyAmount) + ' a year' : 'None'],
                ['Other salary sacrifice', yearly(this.summary.otherSacrifice)],
                ['Benefits in kind', yearly(this.summary.benefitsInKind)],
                ['Pension income on top', yearly(this.summary.pensionIncome)],
                ['Savings interest', yearly(inv.savings)],
                ['Dividends', yearly(inv.dividends)],
                ['Capital gains', yearly(inv.gains)],
                ['Rental income', yearly(Number(h.rentalIncome) || 0)],
                ['Rental expenses', yearly(Number(h.rentalExpenses) || 0)],
                ['Rental finance costs', yearly(Number(h.rentalFinanceCosts) || 0)],
                ['Compared with', this.compareDataset ? this.datasetLabel(this.compareDataset) : 'None']
            ];
        },
        exportResults() {
            const row = (label, pick, kind) => ({ label, cur: pick(this.summary), cmp: this.compareSummary ? pick(this.compareSummary) : null, kind });
            const rows = [
                row('Cash take-home', s => s.cashTakeHome, 'money'),
                row('Take-home a month', s => s.cashTakeHome / 12, 'money'),
                row('Marginal tax rate', s => s.marginalRate, 'pct'),
                row('Effective tax rate', s => s.effectiveRate, 'pct')
            ];
            if (this.summary.childBenefitCredit || this.compareSummary?.childBenefitCredit) rows.push(row('Child benefit kept', s => s.childBenefitCredit, 'money'));
            if (this.household.childcareSubsidyAmount) rows.push(row('Childcare support kept', s => s.childcareCredit, 'money'));
            if (this.household.childcareSubsidyAmount || this.household.children) rows.push(row('Net income including support', s => s.netIncome, 'money'));
            if (this.pensionActive) rows.push(row('Net cost of pension contribution', s => s.pensionNetCost, 'money'));
            return rows;
        },
        // warn only once the pay figure differs from the default. Other settings are usually exploration.
        personalised() { return this.income !== 60000; },
        // shown only when the user is in a trap that a pension contribution can take them out of
        wayOut() {
            const s = this.summary, h = this.household;
            if (this.wayOutDismissed || !this.activeData || !this.pensionEnabled || s.marginalRate < 50) return null;
            const ani = s.adjustedNetIncome;
            let target = null, trap = null;
            if (ani > 100000 && ani <= 125140) {
                target = 100000;
                trap = this.scotland ? 'You\'re in the personal allowance trap' : 'You\'re in the 60% trap';
                if (h.childcareSubsidyAmount > 0) trap += ' and over the childcare cliff';
            } else if (h.children > 0 && ani > 60000 && ani <= 80000) {
                target = 60000; trap = 'You\'re paying the high income child benefit charge';
            }
            if (!target) return null;
            const method = this.pensionActive ? h.pensionMethod : (this.workplacePension ? 'sacrifice' : 'sipp');
            // Smallest round £100 that actually gets the next £1 out of the trap, not just to its edge.
            let extra = Math.ceil((ani - target) / 100) * 100, trial, t;
            for (let tries = 0; tries < 20; tries++, extra += 100) {
                trial = { ...h, pensionBasis: 'amount', pensionContribution: Math.round((s.pensionGross || 0) + extra), pensionMethod: method };
                t = TaxEngine.summary(this.income, this.activeData, trial);
                if (t.marginalRate < 50) break;
            }
            if (t.marginalRate >= 50) return null;
            const how = { sacrifice: 'by salary sacrifice', netpay: 'through your workplace pension', sipp: 'into a personal pension' }[method];
            return { trap, extra, how, cost: s.netIncome - t.netIncome, more: this.pensionActive, settings: trial };
        },
        // how much more you can earn before the next trap, shown when it's close
        headroomNote() {
            const s = this.summary, h = this.household;
            if (!this.activeData || this.wayOut) return null;
            const ani = s.adjustedNetIncome;
            const traps = [];
            if (h.children > 0) traps.push({ at: this.activeData['HICBC start'], what: 'the child benefit charge starts' });
            traps.push({ at: this.activeData['allowance withdrawal threshold'], what: (this.scotland ? 'the personal allowance trap' : 'the 60% trap')
                + (h.childcareSubsidyAmount > 0 ? ' and childcare cliff start' : ' starts') });
            const next = traps.find(t => ani <= t.at);
            if (!next || next.at - ani > HEADROOM_WINDOW) return null;
            const room = TaxEngine.headroom(this.income, this.activeData, h, next.at, 2 * HEADROOM_WINDOW);
            if (room === null || room > HEADROOM_WINDOW) return null;
            return { what: next.what, room: Math.floor(room) };
        },
        sliderFill() { return { '--fill': (100 * Math.min(this.income, this.sliderMax) / this.sliderMax) + '%' }; },
        // short plan name for the student loan button
        loanShort() {
            const plan = this.loanPlans.find(p => p.id === this.household.studentLoanPlan);
            return plan ? plan.label.replace(' + postgraduate loan', ' + PG').replace(/ \(.*\)$/, '') : 'On';
        },

    },

    watch: {
        income() { this.syncIncomeDisplay(); this.refreshChart(); },
        summary() { this.queueAnnouncement(); },
        optionsWanted(wanted) { if (wanted) this.optionsOpen = true; },
        'household.employmentType'(type, previous) {
            const wasWorkplace = previous !== 'Pension income'
                && !TaxEngine.isSelfEmploymentType({ employmentType: previous });
            if (!this.workplacePension) this.household.pensionMethod = 'sipp';
            else if (!wasWorkplace) this.household.pensionMethod = 'sacrifice';
            if (!this.pensionEnabled) {
                this.household.pensionContribution = 0;
                this.pensionError = '';
                this.pensionText = '';
            }
        },
        scotland() {
            if (this.compareDataset === this.dataset) this.compareDataset = null;
            this.refreshChart();
        },
        compareDataset() { this.refreshChart(); },
        // switching view morphs the existing line into the new one rather than redrawing it
        chartType() { this.morphNext = true; this.refreshChart(); },
        household: { deep: true, handler() { this.refreshChart(); } }
    },

    async mounted() {
        // A failed or partial fetch must never render a working-looking calculator
        // full of zeroes: showing invented figures is worse than showing nothing.
        try {
            const res = await fetch('UK_marginal_tax_datasets.json', { signal: AbortSignal.timeout(15000) });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (!data || !data[this.dataset]) throw new Error('ruleset missing: ' + this.dataset);
            TaxEngine.validateDatasets(data);
            this.taxData = markRaw(data);
        } catch (err) {
            this.loadError = true;
            return;
        }
        this.ready = true;
        await this.$nextTick();
        this.chart = markRaw(echarts.init(this.$refs.chart, null, { renderer: 'canvas' }));
        this.chart.on('updateAxisPointer', (e) => {
            const x = e.axesInfo && e.axesInfo[0] && e.axesInfo[0].value;
            if (Number.isFinite(x)) this.scrubGross = x;
        });
        this.compactChart = this.isCompact();
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = markRaw(new ResizeObserver(() => this.onResize()));
            this.resizeObserver.observe(this.$refs.chart);
        }
        this.queueAnnouncement();
        window.addEventListener('resize', this.onResize);
        // Draw once the panel has settled, so the line animates into a stable box.
        requestAnimationFrame(() => this.refreshChart(true));
    },

    beforeUnmount() {
        window.removeEventListener('resize', this.onResize);
        this.resizeObserver?.disconnect();
        clearTimeout(this.announcementTimer);
        if (this.frame) cancelAnimationFrame(this.frame);
        if (this.chart) this.chart.dispose();
    },

    methods: {
        reload() { window.location.reload(); },
        emptySummary() {
            return {
                cashIncome: 0, totalIncome: 0, capitalGainsTax: 0, savingsTax: 0, dividendTax: 0, benefitsInKind: 0,
                pensionIncome: 0, otherSacrifice: 0, reliefViaReturn: 0, investments: { savings: 0, dividends: 0, gains: 0 },
                income: 0, netIncome: 0, cashTakeHome: 0, cashWithBenefits: 0, loanRepayments: 0, incomeTaxAmount: 0, taxRate: 0, pensionNetCost: 0, adjustedNetIncome: 0, totalTax: 0, effectiveRate: 0, marginalRate: 0,
                employerNi: 0, childBenefitCredit: 0, childcareCredit: 0,
                pensionGross: 0, pensionEmployeeOutlay: 0,
                annualAllowance: { allowance: 0, excess: 0, tapered: false },
                incomeTax: { total: 0, bands: [], adjustments: [] },
                ni: { total: 0, bands: [] },
                personalAllowance: 0
            };
        },

        /* ---------------- formatting ---------------- */

        fmtMoney(value, pence) {
            if (!Number.isFinite(value)) return '—';
            const digits = pence ? 2 : 0;
            // Math.round, as the results list uses, so a half pound rounds the same way everywhere. 
            // nasty gotcha to miss that
            const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
            const text = '£' + Math.abs(rounded).toLocaleString('en-GB',
                { minimumFractionDigits: digits, maximumFractionDigits: digits });
            return rounded < 0 ? '−' + text : text;
        },
        fmtPct(value) {
            if (!Number.isFinite(value)) return '—';
            const big = Math.abs(Number(value.toFixed(1))) >= 1000;
            const rounded = Number(value.toFixed(big ? 0 : 1));
            const text = big ? Math.abs(rounded).toLocaleString('en-GB') : Math.abs(rounded).toFixed(1);
            return (rounded < 0 ? '−' : '') + text + '%';
        },

        /** A signed breakdown amount, with no sign on a figure that rounds to £0. */
        fmtSigned(amount, credit) {
            return Math.round(Math.abs(amount)) === 0 ? '£0' : (credit ? '+' : '−') + this.fmtMoney(Math.abs(amount));
        },

        /**
         * Round `rows` to whole pounds so they sum to `total`. Rows marked `fixed`
         * are rounded normally; the others start from their floors and the largest
         * remainders take the spare pounds. No figure moves by more than £1, hopefully.
         */
        roundToTotal(rows, total) {
            const free = rows.filter(r => !r.fixed);
            let spare = total;
            for (const r of rows) {
                r.exact = r.amount;
                r.amount = r.fixed ? Math.round(r.amount) : Math.floor(r.amount);
                spare -= r.amount;
            }
            free.sort((a, b) => (b.exact - b.amount) - (a.exact - a.amount));
            for (let k = 0; spare > 0 && free.length; k = (k + 1) % free.length, spare--) free[k].amount += 1;
            for (let k = free.length - 1; spare < 0 && k >= 0; k--, spare++) free[k].amount -= 1;
            return rows;
        },

        /* ---------------- income input ---------------- */

        onIncomeFocus(e) { this.editing = true; e.target.select(); },

        parseEntry(text, maximum) { return parseMoney(text, maximum); },

        onIncomeInput(e) {
            this.incomeDisplay = e.target.value;
            const value = this.parseEntry(e.target.value, MAX_ENTRY);
            this.incomeError = value === null ? 'Enter an amount from £0 to £10,000,000, for example 50,000.00.' : '';
            if (value !== null) this.income = value;
        },

        commitIncome() {
            this.editing = false;
            if (!this.incomeError) this.syncIncomeDisplay();
        },

        syncIncomeDisplay() {
            if (this.editing || this.incomeError) return;
            const pence = Number(this.income) % 1 ? 2 : 0;
            this.incomeDisplay = this.income ? Number(this.income).toLocaleString('en-GB',
                { minimumFractionDigits: pence, maximumFractionDigits: 2 }) : '';
        },

        // where the next £1,000 of pay goes at a given income
        splitNext(gross, data, step = 1000) {
            const h = this.household, a = TaxEngine.summary(gross, data, h), b = TaxEngine.summary(gross + step, data, h);
            const claw = s => Math.abs((s.incomeTax.adjustments || []).filter(x => x.label === 'Child benefit clawback').reduce((t, x) => t + x.amount, 0));
            const dClaw = claw(b) - claw(a);
            const dTax = (b.incomeTaxAmount - a.incomeTaxAmount) - dClaw;
            // A lost £1 of allowance is taxed at the rate on the top slice, so split that part out.
            const dPA = Math.max(0, (a.personalAllowance || 0) - (b.personalAllowance || 0));
            const taper = dPA > 0 ? dTax * dPA / (step + dPA) : 0;
            const parts = [
                { key: 'tax', label: 'Income tax', amount: dTax - taper },
                { key: 'taper', label: 'Lost allowance', amount: taper },
                { key: 'ni', label: 'NI', amount: (b.ni.total + b.employerNi) - (a.ni.total + a.employerNi) },
                { key: 'loan', label: 'Student loan', amount: b.loanRepayments - a.loanRepayments },
                { key: 'cgt', label: 'Capital gains tax', amount: (b.capitalGainsTax || 0) - (a.capitalGainsTax || 0) },
                { key: 'cb', label: 'Child benefit charge', amount: dClaw },
                { key: 'cc', label: 'Childcare lost', amount: a.childcareCredit - b.childcareCredit },
                { key: 'pension', label: 'To your pension', amount: (b.pensionEmployeeOutlay || 0) - (a.pensionEmployeeOutlay || 0) }
            ];
            const kept = b.netIncome - a.netIncome;
            const residual = step - kept - parts.reduce((t, p) => t + p.amount, 0);
            parts[0].amount += residual;
            return { kept, parts: parts.filter(p => Math.abs(p.amount) >= 1) };
        },
        splitHtml(gross, data) {
            const { kept, parts } = this.splitNext(gross, data);
            const colours = { kept: '#2B52D8', tax: '#4f586c', taper: '#c98a12', ni: '#8e97ab', loan: '#bcc3d2', cgt: '#7d8496', cb: '#e0a83a', cc: '#f0cf85', pension: '#a9bbf2' };
            const segs = [...(kept > 0 ? [{ key: 'kept', amount: kept }] : []), ...parts.filter(p => p.amount > 0)];
            const total = segs.reduce((t, p) => t + p.amount, 0) || 1;
            const bar = segs.map(p => `<span style="flex:0 0 ${100 * p.amount / total}%;background:${colours[p.key]}"></span>`).join('');
            const head = kept >= 0 ? `you keep <b style="color:#2B52D8">${this.fmtMoney(kept)}</b>`
                : `you'd be <b style="color:#cf3a17">${this.fmtMoney(-kept)} worse off</b>`;
            // One row per item, amounts right-aligned, so nothing is clipped at the box edge
            const legend = parts.filter(p => p.amount >= 1).map(p => `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
                <i style="flex:none;width:7px;height:7px;border-radius:2px;background:${colours[p.key]}"></i>
                <span style="flex:1">${p.label}</span><span style="font-variant-numeric:tabular-nums;color:#16181d">${this.fmtMoney(p.amount)}</span></div>`).join('');
            return `<div style="margin-top:9px;padding-top:8px;border-top:1px solid #e3e7f0;min-width:210px;white-space:normal">
                <div style="font-size:11.5px;color:#4a5060">Of the next £1,000, ${head}</div>
                <div style="display:flex;gap:1.5px;height:7px;border-radius:4px;overflow:hidden;margin:6px 0 5px">${bar}</div>
                <div style="font-size:11px;color:#606879">${legend}</div></div>`;
        },
        applyWayOut() {
            const w = this.wayOut;
            if (!w) return;
            Object.assign(this.household, { pensionBasis: w.settings.pensionBasis, pensionContribution: w.settings.pensionContribution, pensionMethod: w.settings.pensionMethod });
            this.openPanel = 'pension';
        },
        nudgeIncome(dir, big) {
            const step = big ? 10000 : 1000;
            const next = dir > 0 ? Math.floor(this.income / step) * step + step : Math.ceil(this.income / step) * step - step;
            this.incomeError = '';
            this.income = Math.max(0, Math.min(this.chartMax, next));
        },
        onSlider(e) { this.incomeError = ''; this.income = Number(e.target.value); this.syncIncomeDisplay(); },

        setPensionBasis(basis) {
            if (this.household.pensionBasis === basis) return;
            this.household.pensionBasis = basis;
            // A £ figure and a % figure are not interchangeable, so start clean.
            this.household.pensionContribution = 0;
            this.pensionError = '';
            this.pensionText = '';
        },

        onPensionFocus(e) { this.pensionEditing = true; this.pensionText = this.pensionDisplay; e.target.select(); },
        onPensionBlur() { this.pensionEditing = false; },

        onPensionInput(e) {
            this.pensionText = e.target.value;
            const percent = this.household.pensionBasis === 'percent';
            const value = this.parseEntry(e.target.value, percent ? 100 : MAX_ENTRY);
            this.pensionError = value === null ? (percent ? 'Enter a percentage from 0 to 100.'
                : 'Enter an amount from £0 to £10,000,000.') : '';
            if (value !== null) this.household.pensionContribution = value;
        },

        queueAnnouncement() {
            clearTimeout(this.announcementTimer);
            this.announcementTimer = setTimeout(() => {
                this.announcement = `Cash take-home ${this.fmtMoney(this.headlineTakeHome)}${this.summary.childcareCredit > 0 ? ' including childcare' : ''} a year. `
                    + `Effective rate ${this.fmtPct(this.summary.effectiveRate)}. Marginal rate ${this.fmtPct(this.summary.marginalRate)}.`;
            }, 450);
        },

        downloadResults() {
            const cmpLabel = this.compareDataset ? this.datasetLabel(this.compareDataset) : null;
            const cols = cmpLabel ? [this.datasetLabel(this.dataset), cmpLabel, 'Difference'] : [this.datasetLabel(this.dataset)];
            const diff = (r) => (r.cur === null || r.cmp === null) ? '' : r.cmp - r.cur;
            const rows = [['UK Tax Calculator', '2026/27', 'Tax Policy Associates', 'taxpolicy.org.uk'], [],
                ['YOUR SETTINGS'], ...this.exportSettings, []];
            if (this.compareSummary) {
                const d = this.compareDelta;
                rows.push(['COMPARISON'], [`Under ${cmpLabel}, you would be ${Math.abs(d) < 0.5 ? 'no better or worse off' : this.fmtMoney(Math.abs(d)) + ' a year ' + (d > 0 ? 'better off' : 'worse off')} (net income including support).`], [this.comparisonNote], []);
            }
            rows.push([`YOUR RESULTS AT ${this.fmtMoney(this.income)}`, ...cols]);
            for (const r of this.exportResults) rows.push([r.label + (r.kind === 'pct' ? ' %' : ' GBP'), r.cur, ...(cmpLabel ? [r.cmp, diff(r)] : [])]);
            rows.push([]);
            rows.push(['HOW THE CALCULATION WORKS', ...cols]);
            for (const t of this.detailTables) {
                rows.push([t.title.toUpperCase()]);
                for (const r of t.rows) rows.push([r.label + ' GBP', r.cur === null ? '' : r.cur, ...(cmpLabel ? [r.cmp === null ? '' : r.cmp, diff(r)] : [])]);
            }
            rows.push([],
                ['NOTES'],
                ['Annual estimates for one person. Universal Credit isn’t included. Childcare support is a value, not cash pay; eligibility is not assessed.'],
                ['Income GBP is the main income. Benefits in kind, pension income, investments, rental income and other salary sacrifice are fixed amounts on top. Tax deducted at source on interest or dividends isn’t taken into account.'],
                ['Standard tax code. Marginal rates are for the next £1, with the personal allowance, child benefit charge and annual allowance tapers smoothed; pension saving is not tax.'],
                ['Statutory columns use the actual rules, rounding and steps. Plotted columns use the smoothed tapers drawn on the chart.'],
                ['Current regime date', this.activeData._meta.regimeDate], [],
                []);
            // one chart-data table per set of rules, each titled with what it shows
            const measure = { marginal: 'Marginal tax rate', effective: 'Effective tax rate', net: 'Net v gross income' }[this.chartType];
            const header = ['Income GBP', 'Cash take-home GBP', 'Income tax, NI, CGT and tax charges GBP', 'Student loans GBP',
                'Child benefit GBP', 'Childcare support GBP', 'Gross pension GBP', 'Net pension cost GBP',
                'Net income including support GBP', 'Effective rate %',
                'Marginal rate on next £1 %', 'Plotted net income GBP', 'Plotted effective rate %'];
            const table = (title, data, curve) => {
                rows.push([title], header);
                for (const income of curve.gross) {
                    const s = TaxEngine.summary(income, data, this.household);
                    const plotted = TaxEngine.totals(income, data, this.household, 'smooth');
                    rows.push([income, s.cashTakeHome, s.totalTax, s.loanRepayments, s.childBenefitCredit,
                        s.childcareCredit, s.pensionGross, s.pensionNetCost, s.netIncome, s.effectiveRate,
                        s.marginalRate, plotted.netIncome, plotted.totalIncome === 0 ? 0 : plotted.adjustedTax / plotted.totalIncome * 100]);
                }
                rows.push([]);
            };
            table(`${measure} under ${this.rulesName(this.dataset)}`, this.activeData, this.curve);
            if (this.compareData) table(`Comparison: ${measure.toLowerCase()} under ${this.rulesName(this.compareDataset)}`, this.compareData, this.compareCurve);
            const csv = rows.map(row => row.map(value => '"' + String(typeof value === 'number'
                ? value.toFixed(2) : value).replace(/"/g, '""') + '"').join(',')).join('\r\n');
            const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
            const link = document.createElement('a'); link.href = url; link.download = `uk-tax-calculator-${Math.round(this.income)}.csv`;
            document.body.appendChild(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        },

        /** The outcome rows for one set of rules, rounded as the results list is so they add up exactly. */
        roundedOutcome(s) {
            const cash = Math.round(s.cashTakeHome);
            const rows = [
                { label: 'Total income tax', amount: s.incomeTaxAmount },
                { label: 'Total national insurance', amount: s.ni.total + s.employerNi }
            ];
            if (this.household.includeStudentLoan) rows.push({ label: 'Student loan repayments', amount: s.loanRepayments });
            if (s.capitalGainsTax > 0) rows.push({ label: 'Capital gains tax', amount: s.capitalGainsTax });
            if (s.pensionEmployeeOutlay > 0) rows.push({ label: 'Your pension contributions', amount: s.pensionEmployeeOutlay, fixed: true });
            if (s.otherSacrifice > 0) rows.push({ label: 'Other salary sacrifice', amount: s.otherSacrifice, fixed: true });
            this.roundToTotal(rows, Math.round(s.cashIncome) - cash);
            rows.push({ label: 'Cash take-home', amount: cash, kind: 'total' });
            const support = [];
            if (s.childBenefitCredit) support.push({ label: 'Child benefit kept', amount: s.childBenefitCredit });
            if (this.household.childcareSubsidyAmount) support.push({ label: 'Childcare support kept', amount: s.childcareCredit });
            if (support.length) {
                const net = Math.round(s.netIncome);
                this.roundToTotal(support, net - cash);
                rows.push(...support, { label: 'Net income including support', amount: net, kind: 'total' });
            }
            // with pension income or investments, say what the deductions come out of
            if (Math.round(s.cashIncome) !== Math.round(s.income)) {
                rows.unshift({ label: 'Income received, including pensions, investments and rent', amount: Math.round(s.cashIncome), kind: 'total' });
            }
            return rows.map(({ label, amount, kind }) => ({ label, amount, kind }));
        },

        // a one-off privacy check before a download that carries the user's own figures
        requestExport(kind) {
            if (!this.personalised || this.exportAcknowledged) return this.runExport(kind);
            this.exportTrigger = document.activeElement;
            this.exportConfirm = kind;
            this.$nextTick(() => this.$refs.exportOk?.focus());
        },
        confirmExport() {
            const kind = this.exportConfirm;
            this.exportAcknowledged = true;
            this.exportConfirm = null;
            this.runExport(kind);
        },
        cancelExport() {
            this.exportConfirm = null;
            this.$nextTick(() => this.exportTrigger?.focus());
        },
        runExport(kind) { return kind === 'image' ? this.downloadChartImage() : this.downloadResults(); },

        async downloadChartImage() {
            if (!this.chart || this.exportingImage) return;
            this.exportingImage = true;
            this.downloadError = '';
            try {
                // Export the plot without the floating HTML controls, with a title
                // and legend so the image remains intelligible outside the page.
                const plot = new Image();
                plot.src = this.chart.getDataURL({ type: 'png', pixelRatio: Math.max(2, 1000 / this.chart.getWidth()), backgroundColor: '#fff' });
                await plot.decode();
                // a settings and results panel under the plot, so the image stands on its own
                const settings = this.exportSettings.filter(([, v]) => v !== 'None' && v !== 'No');
                const facts = [`At ${this.fmtMoney(this.income)}: take-home ${this.fmtMoney(this.headlineTakeHome)}${this.summary.childcareCredit > 0 ? ' including childcare' : ''}`,
                    `marginal tax rate ${this.fmtPct(this.summary.marginalRate)}`, `effective tax rate ${this.fmtPct(this.summary.effectiveRate)}`].join(' \u00b7 ');
                const verdict = this.compareSummary ? `Under ${this.datasetLabel(this.compareDataset)}: ${Math.abs(this.compareDelta) < 0.5 ? 'no better or worse off' : this.fmtMoney(Math.abs(this.compareDelta)) + ' a year ' + (this.compareDelta > 0 ? 'better off' : 'worse off')}` : '';
                const settingRows = Math.ceil(settings.length / 2);
                const panel = 40 + 36 + (verdict ? 36 : 0) + 20 + settingRows * 30 + 20;
                const canvas = document.createElement('canvas');
                canvas.width = plot.width;
                canvas.height = plot.height + 190 + panel;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = INK; ctx.font = '600 30px Poppins, sans-serif';
                ctx.fillText(this.chartTitle, 24, 44);
                ctx.font = '22px Poppins, sans-serif'; ctx.fillStyle = SERIES_1;
                ctx.fillText(this.datasetLabel(this.dataset), 24, 84);
                if (this.compareDataset) {
                    ctx.fillStyle = SERIES_2;
                    ctx.fillText(this.datasetLabel(this.compareDataset), 24, 118);
                }
                ctx.drawImage(plot, 0, 140);
                let y = 140 + plot.height + 40;
                ctx.fillStyle = '#e3e7f0'; ctx.fillRect(24, y - 22, canvas.width - 48, 1.5);
                ctx.fillStyle = INK; ctx.font = '600 22px Poppins, sans-serif'; ctx.fillText(facts, 24, y + 12); y += 36;
                if (verdict) { ctx.fillStyle = this.compareDelta >= 0 ? '#0f7a52' : '#cf3a17'; ctx.fillText(verdict, 24, y + 12); y += 36; }
                y += 20;
                const colW = (canvas.width - 48) / 2;
                settings.forEach(([k, v], i) => {
                    const x = 24 + (i % 2) * colW, yy = y + Math.floor(i / 2) * 30;
                    ctx.font = '17px Poppins, sans-serif'; ctx.fillStyle = INK_3; ctx.fillText(k, x, yy);
                    const kw = ctx.measureText(k + '  ').width;
                    ctx.font = '500 17px Poppins, sans-serif'; ctx.fillStyle = INK;
                    let text = v; while (ctx.measureText(text).width > colW - kw - 16 && text.length > 4) text = text.slice(0, -2);
                    ctx.fillText(text === v ? v : text + '\u2026', x + kw, yy);
                });
                // the logo bottom left; an image without it is better than no image
                const logo = new Image();
                logo.src = 'logo_standard.png';
                try {
                    await logo.decode();
                    const logoH = 44;
                    ctx.drawImage(logo, 24, canvas.height - 24 - logoH, logoH * logo.width / logo.height, logoH);
                } catch (error) { /* skip the logo */ }
                const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                if (!blob) throw new Error('Image export failed');
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a'); link.href = url;
                link.download = `uk-tax-calculator-${this.chartType}.png`;
                document.body.appendChild(link); link.click(); link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (error) {
                this.downloadError = 'The chart image could not be downloaded. Please try again.';
            } finally {
                this.exportingImage = false;
            }
        },

        toggleCompare() {
            this.compareOpen = !this.compareOpen;
            if (!this.compareOpen) this.compareDataset = null;
        },

        rulesName(name) {
            if (name === '2026-27 UK') return 'current rest of UK rules';
            if (name === '2026-27 Scotland') return 'current Scottish rules';
            return `${name} (a proposal)`;
        },

        datasetLabel(name) {
            if (!name) return '';
            if (name === '2026-27 UK') return 'Current rUK (2026/27)';
            if (name === '2026-27 Scotland') return 'Current Scotland (2026/27)';
            return name;
        },

        isCompact() { return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches; },
        onResize() {
            if (!this.chart) return;
            this.chart.resize({ animation: { duration: 0 } });
            const compact = this.isCompact();
            if (compact !== this.compactChart) {
                this.compactChart = compact;
                this.drawChart();
            }
        },

        /* ---------------- chart ---------------- */

        seriesFor(curve) {
            if (this.chartType === 'marginal') return curve.marginal;
            if (this.chartType === 'effective') return curve.effective;
            return curve.net;
        },

        /**
         * Marginal rates at cliff edges run to thousands/millions of percent, which would
         * make the curve unreadable. so we clamp the axis to the tapered range and let the
         * cliff read as the spike it is.
         */
        axisCeiling() {
            if (this.chartType === 'net') return null;
            const values = [this.seriesFor(this.curve)];
            if (this.compareCurve) values.push(this.seriesFor(this.compareCurve));
            const inRange = values.flat().filter(v => Number.isFinite(v) && v < 100);
            if (!inRange.length) return 100;
            const peak = Math.max(...inRange);
            return Math.min(100, Math.ceil((peak + 6) / 10) * 10);
        },

        /**
         * Rates normally start at 0%. Pension tax relief can make the marginal
         * rate negative, so the marginal axis drops below zero only then. 
         * bit of a judgment call, this one.
         */
        axisFloor() {
            if (this.chartType !== 'marginal' || !this.curve) return 0;
            const values = [this.curve.marginal, this.compareCurve?.marginal || []].flat()
                .filter(v => Number.isFinite(v) && v > -100);
            const low = Math.min(0, ...values, this.summary.marginalRate > -100 ? this.summary.marginalRate : 0);
            return low < 0 ? Math.floor(low / 10) * 10 : 0;
        },

        /** Coalesce bursts of updates (slider drags) into one paint per frame. */
        refreshChart(replay) {
            if (replay) this.pendingReplay = true;
            if (this.frame) return;
            this.frame = requestAnimationFrame(() => {
                this.frame = null;
                const r = this.pendingReplay;
                this.pendingReplay = false;
                this.drawChart(r);
            });
        },

        drawChart(replay) {
            if (!this.chart || !this.curve) return;

            const isRate = this.chartType !== 'net';
            const ceiling = this.axisCeiling();
            const floor = this.axisFloor();
            const primary = this.seriesFor(this.curve);
            const points = this.curve.gross.map((g, i) => [g, primary[i]]);
            const markerY = isRate
                ? (this.chartType === 'marginal' ? this.summary.marginalRate : this.summary.effectiveRate)
                : this.summary.netIncome;

            const morph = this.morphNext && this.hasAnimatedIn;
            this.morphNext = false;
            const series = [{
                id: 'primary',
                name: this.datasetLabel(this.dataset),
                type: 'line',
                data: points,
                clip: true,
                showSymbol: false,
                smooth: false,
                lineStyle: { width: 2, color: SERIES_1 },
                itemStyle: { color: SERIES_1 },
                areaStyle: this.compareCurve ? null : {
                    color: {
                        type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                        colorStops: [
                            { offset: 0, color: 'rgba(43, 82, 216, 0.16)' },
                            { offset: 1, color: 'rgba(43, 82, 216, 0.01)' }
                        ]
                    }
                },
                z: 3,
                markLine: this.chartType === 'marginal' && this.childcareCliff !== null ? {
                    symbol: 'none', silent: true,
                    label: { formatter: 'Childcare cliff', position: 'insideEndTop', color: INK_3 },
                    lineStyle: { color: INK_3, type: 'dashed' },
                    data: [{ xAxis: this.childcareCliff }]
                } : (morph ? { data: [] } : undefined),
                markPoint: {
                    silent: true,
                    symbol: 'circle',
                    symbolSize: 13,
                    // A 2px surface ring keeps the marker legible where it sits on the line.
                    itemStyle: { color: SERIES_1, borderColor: '#fff', borderWidth: 2.5 },
                    label: {
                        show: true,
                        position: 'top',
                        distance: 12,
                        formatter: () => (isRate ? this.fmtPct(markerY) : this.fmtMoney(markerY)),
                        color: INK,
                        fontFamily: 'Poppins',
                        fontSize: 12,
                        fontWeight: 600,
                        backgroundColor: '#fff',
                        borderColor: SERIES_1,
                        borderWidth: 1.5,
                        borderRadius: 6,
                        padding: [4, 8]
                    },
                    // A cliff rate can run to millions of percent: pin the marker to the
                    // top of the axis and let its label carry the true figure.
                    data: this.chartType === 'effective' && markerY < 0 ? []
                        : [{ coord: [this.income, ceiling === null ? markerY : Math.max(floor, Math.min(markerY, ceiling))] }]
                }
            }];

            if (this.compareCurve) {
                const cmp = this.seriesFor(this.compareCurve);
                series.push({
                    id: 'compare',
                    name: this.datasetLabel(this.compareDataset),
                    type: 'line',
                    data: this.compareCurve.gross.map((g, i) => [g, cmp[i]]),
                    clip: true,
                    showSymbol: false,
                    lineStyle: { width: 2, color: SERIES_2, type: 'dashed' },
                    itemStyle: { color: SERIES_2 },
                    z: 2
                });
            }

            const stillness = typeof window.matchMedia === 'function'
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

            this.chart.setOption({
                animation: !stillness,
                // The line draws itself in on first paint, as the site's chart plugin does.
                animationDuration: replay || !this.hasAnimatedIn ? 900 : 300,
                animationEasing: 'cubicOut',
                animationDurationUpdate: morph ? 650 : 300,
                animationEasingUpdate: morph ? 'cubicInOut' : 'cubicOut',
                textStyle: { fontFamily: 'Poppins, sans-serif' },
                grid: { left: 8, right: 18, top: 26, bottom: 8, containLabel: true },
                tooltip: {
                    trigger: 'axis',
                    showContent: !this.compactChart,
                    confine: true,
                    axisPointer: {
                        type: 'line',
                        lineStyle: { color: INK_3, width: 1, type: 'dashed' },
                        snap: true
                    },
                    backgroundColor: 'rgba(255,255,255,.97)',
                    borderColor: '#dfe4ef',
                    borderWidth: 1,
                    padding: [9, 12],
                    textStyle: { color: INK, fontSize: 12, fontFamily: 'Poppins' },
                    extraCssText: 'box-shadow:0 8px 26px -10px rgba(16,24,64,.3);border-radius:10px;',
                    formatter: (params) => {
                        if (!params.length) return '';
                        const gross = params[0].value[0];
                        const rows = params.map(p => {
                            const v = p.value[1];
                            const shown = isRate ? this.fmtPct(v) : this.fmtMoney(v);
                            return `<div style="display:flex;justify-content:space-between;gap:18px;margin-top:3px">
                                      <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${p.color};margin-right:6px"></span>${p.seriesName}</span>
                                      <strong>${shown}</strong></div>`;
                        }).join('');
                        return `<div style="font-weight:600;margin-bottom:2px">${this.fmtMoney(gross)}</div>${rows}`
                            + this.splitHtml(gross, this.activeData)
                            + `<div style="color:${INK_3};font-size:11px;margin-top:5px">Smoothed tapers</div>`;
                    }
                },
                xAxis: {
                    type: 'value',
                    min: 0,
                    max: this.chartMax,
                    axisLabel: {
                        color: INK_3, fontSize: 11,
                        formatter: (v) => {
                            if (v >= 1000000) return '£' + (v / 1000000) + 'm';
                            return v >= 1000 ? '£' + Math.round(v / 1000) + 'k' : '£' + v;
                        }
                    },
                    axisLine: { lineStyle: { color: '#d7dced' } },
                    axisTick: { show: false },
                    splitLine: { show: false }
                },
                yAxis: {
                    type: 'value',
                    min: this.chartType === 'net' ? 'dataMin' : floor,
                    max: ceiling,
                    axisLabel: {
                        color: INK_3, fontSize: 11,
                        formatter: v => (isRate ? v + '%' : (v >= 1000 ? '£' + Math.round(v / 1000) + 'k' : '£' + v))
                    },
                    axisLine: { show: false },
                    axisTick: { show: false },
                    splitLine: { lineStyle: { color: GRID_LINE } }
                },
                series
            }, morph ? { replaceMerge: ['series'] } : { notMerge: true });

            this.hasAnimatedIn = true;
        }
    }
};

if (framingAllowed()) {
    createApp(APP_OPTIONS).mount('#app');
} else {
    renderFrameBlock();
}
