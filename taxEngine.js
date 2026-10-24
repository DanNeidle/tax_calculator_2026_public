/*
(c) Tax Policy Associates Ltd, 2026, licensed under the MIT licence.
Permission is hereby granted, free of charge, to any person obtaining a copy of this software,
to use it however they wish provided they attribute it to Tax Policy Associates Ltd.

This is just the UK tax engine — none of that fancy UI stuff. It's a bit too long
and could do with some refactoring. But it's been extensively tested.

This is an update from our 2025 dashboard (code/2025_chart/app.js), where the same logic was
interleaved with Vue state and Plotly rendering. 

The engine is now more sophisticated and deals with more edge cases. Numerous minor corrections. 
Pensions added in.

Two calculation modes throughout:

  'actual' — the statutory step functions (HICBC in whole £200 steps, personal
             allowance withdrawn in whole £1 steps). Used for summary and CSV
             cash figures.

  'smooth' — the same tapers as continuous straight lines, for marginal rates
             and plotted curves. 
             This is absolutely not how the actual tax system works but a chart of the actual tax system is a mad staircase.
             Marginal rate is a differentiation, and you can't differentiate a step function. 
             So we cheat and create a smoothed tax system purely for the chart.

`marginalRate()` therefore uses 'smooth' on BOTH sides of the perturbation. 
Both sides must always use the same mode — mixing them was the cause
of a spurious 98.2% reading in the 2025 chart.
*/

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.TaxEngine = api;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const PERTURBATION = 1;
    const CHART_STEP = 100;
    // Comparisons against statutory limits ignore floating-point dust, so pay of
    // exactly £50,270 reached by grossing down an IR35 budget is still £50,270.
    const EPSILON = 1e-6;

    /**
     * Legacy fallback only. Student loan thresholds change every April, so each
     * ruleset should carry its own under a "student loan" key; these 2025-26
     * figures are used only when a ruleset does not specify them.
     */
    const STUDENT_LOAN_DEFAULTS = {
        plan1: { rate: 0.09, threshold: 26065 },
        plan2: { rate: 0.09, threshold: 28470 },
        plan4: { rate: 0.09, threshold: 32745 },
        plan5: { rate: 0.09, threshold: 25000 },
        plan3: { rate: 0.06, threshold: 21000 }
    };

    /** Resolve one plan's components against a ruleset, falling back to defaults. */
    function loanComponents(dataset, componentKeys) {
        const overrides = (dataset && dataset['student loan']) || {};
        return componentKeys.map(key => {
            const base = STUDENT_LOAN_DEFAULTS[key] || { rate: 0, threshold: Infinity };
            const override = overrides[key] || {};
            return {
                rate: override.rate !== undefined ? Number(override.rate) : base.rate,
                threshold: override.threshold !== undefined ? Number(override.threshold) : base.threshold
            };
        });
    }

    function buildStudentLoanPlan(id, label, componentKeys) {
        return { id, label, componentKeys };
    }

    const STUDENT_LOAN_PLANS = [
        buildStudentLoanPlan('plan1', 'Plan 1 (before Sept 2012)', ['plan1']),
        buildStudentLoanPlan('plan2', 'Plan 2 (Sept 2012 to July 2023)', ['plan2']),
        buildStudentLoanPlan('plan4', 'Plan 4 (Scotland)', ['plan4']),
        buildStudentLoanPlan('plan5', 'Plan 5 (after August 2023)', ['plan5']),
        buildStudentLoanPlan('plan3', 'Plan 3 (postgraduate loan only)', ['plan3']),
        buildStudentLoanPlan('plan1_pg', 'Plan 1 + postgraduate loan', ['plan1', 'plan3']),
        buildStudentLoanPlan('plan2_pg', 'Plan 2 + postgraduate loan', ['plan2', 'plan3']),
        buildStudentLoanPlan('plan4_pg', 'Plan 4 + postgraduate loan', ['plan4', 'plan3']),
        buildStudentLoanPlan('plan5_pg', 'Plan 5 + postgraduate loan', ['plan5', 'plan3'])
    ];

    const DEFAULT_HOUSEHOLD = {
        employmentType: 'Employed',
        children: 0,
        childcareSubsidyAmount: 0,
        includeStudentLoan: false,
        studentLoanPlan: 'plan2',
        includeMarriageAllowance: false,
        // Which kind of income the "next £1" is. The engine supports taxing the
        // marginal slice as dividends, savings or property income using the matching
        // band tables in the ruleset. The 2026 UI exposes no control for this, so it
        // is always 'primary' in the shipped app; it is kept because the capability
        // is complete and tested, and a future UI can switch it on without engine work.
        marginalIncomeType: 'primary',
        // Pension contributions. `pensionBasis` 'percent' scales with income, which
        // is how most people actually contribute; 'amount' is a flat £ figure, which
        // is how people think about escaping a specific trap.
        pensionContribution: 0,
        pensionBasis: 'amount',        // 'amount' | 'percent'
        pensionMethod: 'sacrifice'     // see RELIEF_AT_SOURCE_METHODS
    };

    function household(overrides) {
        return Object.assign({}, DEFAULT_HOUSEHOLD, overrides || {});
    }

    // --- Employment classification -----------------------------------------

    function isSelfEmploymentType(h) {
        return h.employmentType === 'Self-employed' || h.employmentType === 'Partnership/LLP';
    }

    function requiresEmployerNiGrossDown(h) {
        return h.employmentType === 'Within IR35';
    }

    function activeNiKey(h) {
        if (['Retired/State pension age', 'Working past State Pension age', 'Pension income'].includes(h.employmentType)) {
            return null;
        }
        return isSelfEmploymentType(h) ? 'NI class 4 (self-employed)' : 'NI class 1 (employees)';
    }

    function activeStudentLoanPlan(h, dataset) {
        if (!h.includeStudentLoan) {
            return null;
        }
        const plan = STUDENT_LOAN_PLANS.find(p => p.id === h.studentLoanPlan);
        if (!plan) {
            return null;
        }
        return {
            id: plan.id,
            label: plan.label,
            components: loanComponents(dataset, plan.componentKeys)
        };
    }

    // --- Pensions -----------------------------------------------------------

    /**
     * Resolve a household's pension contribution at a given income.
     *
     * `gross` is what lands in the pension. `employeeOutlay` is the reduction in
     * take-home cash caused by the contribution itself, before any tax effects:
     * under salary sacrifice the employee gives up that much gross salary, whereas
     * under relief at source they pay 80% and the provider reclaims the rest.
     *
     * Tax relief is limited to 100% of relevant earnings, so the contribution is
     * capped at income. Contributions above the annual allowance are permitted and
     * attract an annual allowance charge — see `annualAllowanceFor`.
     */
    // Relief at source gives a provider top-up and extends tax bands. Net pay
    // instead deducts the full contribution from taxable pay, but not NI pay.
    const RELIEF_AT_SOURCE_METHODS = ['relief_at_source', 'sipp'];

    /**
     * The pay a "% of gross pay" contribution is a percentage of. Under IR35 the
     * entered figure is a budget that also funds employer NI, so the percentage
     * applies to the deemed salary. With salary sacrifice that salary S satisfies
     * budget = S + employer NI on the unsacrificed (1 - p) S above the threshold.
     */
    function percentBase(grossIncome, dataset, h, method, fraction) {
        if (!requiresEmployerNiGrossDown(h)) return grossIncome;
        if (method !== 'sacrifice') return transformIncomeForEmployment(grossIncome, dataset, h).taxableIncome;
        const rate = employerNiRate(dataset, h);
        const threshold = employerSecondaryThreshold(dataset, h);
        const retained = 1 - Math.min(1, fraction);
        if (rate <= 0 || retained * grossIncome <= threshold) return grossIncome;
        return (grossIncome + rate * threshold) / (1 + rate * retained);
    }

    function pensionFor(grossIncome, h, dataset) {
        // Default to relief at source rather than sacrifice: an unrecognised value
        // should not silently grant NI relief it may not be entitled to.
        const employee = !isSelfEmploymentType(h) && h.employmentType !== 'Pension income';
        const method = employee && ['sacrifice', 'netpay'].includes(h.pensionMethod)
            ? h.pensionMethod : 'relief_at_source';
        const raw = Number(h.pensionContribution) || 0;
        if (!Number.isFinite(raw) || raw <= 0 || h.employmentType === 'Pension income') {
            return { gross: 0, employeeOutlay: 0, method, capped: false };
        }
        const income = grossIncome > 0 ? grossIncome : 0;
        const requested = h.pensionBasis === 'percent'
            ? percentBase(income, dataset, h, method, raw / 100) * (raw / 100) : raw;
        const earnings = method === 'sacrifice' ? income
            : transformIncomeForEmployment(income, dataset, h).taxableIncome;
        // Relief at source is available on up to £3,600 gross whatever the
        // earnings (FA 2004 s190); otherwise relief stops at relevant earnings.
        const basicAmount = method === 'relief_at_source' && dataset
            ? Number(dataset['pension relief at source basic amount']) || 0 : 0;
        const limit = Math.max(earnings, basicAmount);
        const contribution = Math.max(0, Math.min(requested, limit));
        const reliefRate = dataset && dataset['pension relief at source rate'] !== undefined
            ? dataset['pension relief at source rate'] : 0.20;
        return {
            gross: contribution,
            employeeOutlay: method === 'relief_at_source' ? contribution * (1 - reliefRate) : contribution,
            method,
            capped: requested > limit + EPSILON
        };
    }

    const AA_DEFAULTS = {
        allowance: 60000,
        thresholdIncomeLimit: 200000,
        adjustedIncomeLimit: 260000,
        taperRate: 0.5,
        minimum: 10000
    };

    /**
     * The annual allowance, and any contribution above it.
     *
     * The allowance is tapered by £1 for every £2 of adjusted income above
     * £260,000, down to a £10,000 floor — but only for those whose threshold
     * income also exceeds £200,000. Both tests must be met, which is what stops
     * the taper catching someone whose income is high only because of a large
     * employer contribution.
     *
     * Start with earnings after the IR35 employment-cost transformation. Employer
     * NI is not income. Add salary sacrifice back for adjusted and threshold
     * income; deduct personal contributions for threshold income only.
     *
     * Carry forward of unused allowance from the previous three years is NOT
     * modelled — it depends on contribution history this tool has no sight of. The
     * excess is returned so the UI can flag that carry forward may cover it.
     *
     * 'smooth' mode skips the £1 rounding, so the marginal rate doesn't saw.
     */
    function annualAllowanceFor(grossIncome, dataset, h, mode) {
        const cfg = dataset || {};
        const standard = cfg['pension annual allowance'] !== undefined
            ? cfg['pension annual allowance'] : AA_DEFAULTS.allowance;
        const thresholdLimit = cfg['pension AA threshold income limit'] !== undefined
            ? cfg['pension AA threshold income limit'] : AA_DEFAULTS.thresholdIncomeLimit;
        const adjustedLimit = cfg['pension AA adjusted income limit'] !== undefined
            ? cfg['pension AA adjusted income limit'] : AA_DEFAULTS.adjustedIncomeLimit;
        const taperRate = cfg['pension AA taper rate'] !== undefined
            ? cfg['pension AA taper rate'] : AA_DEFAULTS.taperRate;
        const minimum = cfg['pension AA minimum'] !== undefined
            ? cfg['pension AA minimum'] : AA_DEFAULTS.minimum;

        const pension = pensionFor(grossIncome, h, dataset);
        const sacrificing = pension.method === 'sacrifice';
        const earnings = transformIncomeForEmployment(
            grossIncome - (sacrificing ? pension.gross : 0), dataset, h).taxableIncome;
        const adjustedIncome = earnings + (sacrificing ? pension.gross : 0);
        const thresholdIncome = sacrificing ? adjustedIncome : Math.max(0, earnings - pension.gross);

        let allowance = standard;
        let tapered = false;
        if (thresholdIncome > thresholdLimit && adjustedIncome > adjustedLimit) {
            // The statutory reduction is rounded down to £1 (FA 2004 s228ZA(2)).
            let reduction = (adjustedIncome - adjustedLimit) * taperRate;
            if (mode !== 'smooth') reduction = Math.floor(reduction + EPSILON);
            allowance = Math.max(minimum, standard - reduction);
            tapered = true;
        }

        return {
            allowance,
            tapered,
            adjustedIncome,
            thresholdIncome,
            contribution: pension.gross,
            excess: Math.max(0, pension.gross - allowance)
        };
    }

    /**
     * Relief at source gives higher-rate relief by extending the basic rate limit
     * (and with it every threshold above), rather than by reducing taxable income.
     * Bands below basic — Scotland's starter rate — are unaffected.
     */
    function extendBands(bandRules, extension) {
        if (!Array.isArray(bandRules) || !extension) {
            return bandRules;
        }
        const basicIndex = bandRules.findIndex(band => band.name === 'basic');
        const from = basicIndex >= 0 ? basicIndex : 0;
        return bandRules.map((band, i) => (i >= from && band.threshold !== undefined)
            ? Object.assign({}, band, { threshold: band.threshold + extension })
            : band);
    }

    // --- Employer NI --------------------------------------------------------

    function employerNiConfig(dataset) {
        if (!dataset) {
            return null;
        }
        const config = dataset['employer NI'] !== undefined ? dataset['employer NI'] : dataset['employer_NI'];
        if (config && typeof config === 'object') {
            return config;
        }
        const fallback = {};
        const rate = dataset['employer nic rate'] !== undefined
            ? dataset['employer nic rate']
            : dataset['employer_nic_rate'];
        if (rate !== undefined) {
            fallback['employer nic rate'] = rate;
        }
        const threshold = dataset['employer nic secondary threshold'] !== undefined
            ? dataset['employer nic secondary threshold']
            : dataset['employer_nic_secondary_threshold'];
        if (threshold !== undefined) {
            fallback['employer nic secondary threshold'] = threshold;
        }
        return Object.keys(fallback).length > 0 ? fallback : null;
    }

    function employerNiRate(dataset, h) {
        if (!dataset || !requiresEmployerNiGrossDown(h)) {
            return 0;
        }
        const config = employerNiConfig(dataset);
        if (!config) {
            return 0;
        }
        const rawRate = config['employer nic rate'] ?? config['employer_nic_rate'];
        const rate = Number(rawRate);
        return Number.isFinite(rate) && rate > 0 ? rate : 0;
    }

    function employerSecondaryThreshold(dataset, h) {
        if (!dataset || !requiresEmployerNiGrossDown(h)) {
            return 0;
        }
        const config = employerNiConfig(dataset);
        if (!config) {
            return 0;
        }
        // Prefer an explicit annual figure. HMRC publishes both, and they do not
        // always reconcile: for 2025-26 the threshold is £96 a week but £5,000 a
        // year, so annualising the weekly figure would be £8 light.
        const annual = Number(config['employer nic secondary threshold annual'] !== undefined
            ? config['employer nic secondary threshold annual']
            : config['employer_nic_secondary_threshold_annual']);
        if (Number.isFinite(annual) && annual > 0) {
            return annual;
        }
        const weekly = Number(config['employer nic secondary threshold'] !== undefined
            ? config['employer nic secondary threshold']
            : config['employer_nic_secondary_threshold']);
        if (!Number.isFinite(weekly) || weekly <= 0) {
            return 0;
        }
        return weekly * 52;
    }

    /**
     * For IR35 cases the headline figure the user enters is the
     * total employment cost, so employer NI has to be grossed down out of it.
     */
    function transformIncomeForEmployment(grossIncome, dataset, h) {
        let originalIncome = Number(grossIncome);
        if (!Number.isFinite(originalIncome) || originalIncome < 0) {
            originalIncome = 0;
        }
        const rate = employerNiRate(dataset, h);
        if (rate <= 0) {
            return { taxableIncome: originalIncome, employerNi: 0 };
        }
        const annualSecondaryThreshold = employerSecondaryThreshold(dataset, h);
        if (annualSecondaryThreshold <= 0) {
            const taxableIncome = originalIncome / (1 + rate);
            return { taxableIncome, employerNi: originalIncome - taxableIncome };
        }
        if (originalIncome <= annualSecondaryThreshold) {
            return { taxableIncome: originalIncome, employerNi: 0 };
        }
        const taxableIncome = (originalIncome + rate * annualSecondaryThreshold) / (1 + rate);
        return { taxableIncome, employerNi: Math.max(0, originalIncome - taxableIncome) };
    }

    // --- Allowances, credits and charges ------------------------------------

    function personalAllowance(grossIncome, dataset, mode, baseAllowance) {
        let allowance = baseAllowance !== undefined && baseAllowance !== null
            ? baseAllowance
            : dataset['statutory personal allowance'];
        const threshold = dataset['allowance withdrawal threshold'];
        const withdrawalRate = dataset['allowance withdrawal rate'];

        if (grossIncome <= threshold || !withdrawalRate) {
            return allowance;
        }

        if (mode === 'actual') {
            let poundsPerReduction = withdrawalRate;
            if (poundsPerReduction < 1) {
                poundsPerReduction = 1 / poundsPerReduction;
            }
            const steps = Math.floor((grossIncome - threshold) / poundsPerReduction);
            return Math.max(0, allowance - steps);
        }

        let reductionPerPound = withdrawalRate;
        if (withdrawalRate >= 1) {
            reductionPerPound = 1 / withdrawalRate;
        }
        return Math.max(0, allowance - (grossIncome - threshold) * reductionPerPound);
    }

    function childBenefitAmount(dataset, h) {
        if (!dataset || h.children === 0) {
            return 0;
        }
        return 52 * (dataset['child benefit']['1st'] + dataset['child benefit']['subsequent'] * (h.children - 1));
    }

    function hicbcCharge(grossIncome, dataset, mode, h) {
        if (h.children === 0) {
            return 0;
        }
        const totalChildBenefit = childBenefitAmount(dataset, h);
        const hicbcStart = dataset['HICBC start'] || 0;
        let incomePerPercent = dataset['HICBC income per percent reduction'];
        let hicbcEnd = dataset['HICBC end'];

        if (!incomePerPercent && hicbcEnd) {
            incomePerPercent = (hicbcEnd - hicbcStart) / 100;
        }
        if (!incomePerPercent || incomePerPercent <= 0) {
            incomePerPercent = 100;
        }
        if (!hicbcEnd) {
            hicbcEnd = hicbcStart + incomePerPercent * 100;
        }
        if (grossIncome <= hicbcStart) {
            return 0;
        }

        if (mode === 'actual') {
            // 1% of child benefit for each *complete* £200 above the threshold,
            // so £60,199 gives 0% and £60,200 gives 1%.
            const steps = Math.floor((grossIncome - hicbcStart) / incomePerPercent);
            // Both the benefit total and the charge are rounded down to whole
            // pounds (ITEPA 2003 s681C(3)).
            return Math.floor(Math.floor(totalChildBenefit + EPSILON) * Math.min(steps, 100) / 100 + EPSILON);
        }

        const fraction = Math.min(1, Math.max(0,
            (grossIncome - hicbcStart) / Math.max(hicbcEnd - hicbcStart, incomePerPercent)));
        return totalChildBenefit * fraction;
    }

    // A user-specified household value at risk, not an eligibility assessment.
    // Neither the child-benefit count nor a minimum-earnings test applies here.
    function childcareSubsidy(aniIncome, dataset, h) {
        const support = Number(h.childcareSubsidyAmount);
        if (!dataset || !Number.isFinite(support) || support <= 0) return 0;
        return aniIncome > dataset['childcare max earnings'] + EPSILON ? 0 : Math.min(support, 20000);
    }

    function class2Contribution(grossIncome, class2Rules) {
        if (!class2Rules) {
            return 0;
        }
        const weeklyAmount = class2Rules['weekly amount'] !== undefined
            ? class2Rules['weekly amount']
            : class2Rules['weekly_amount'];
        let lowerLimit = class2Rules['lower profits limit'];
        if (lowerLimit === undefined) lowerLimit = class2Rules['lower_profits_limit'];
        if (lowerLimit === undefined) lowerLimit = class2Rules['small_profits_threshold'];
        if (lowerLimit === undefined) lowerLimit = 0;
        if (!weeklyAmount || grossIncome <= lowerLimit) {
            return 0;
        }
        return 52 * weeklyAmount;
    }

    // --- Band arithmetic ----------------------------------------------------

    function marginalBandKey(type) {
        if (type === 'savings') return 'income tax - savings';
        if (type === 'property') return 'income tax - property';
        if (type === 'dividend' || type === 'dividends') return 'income tax - dividends';
        return null;
    }

    function bandTax(amount, bandRules, consumedAmount) {
        if (!Array.isArray(bandRules) || amount <= 0) {
            return 0;
        }
        let remaining = amount;
        let tax = 0;
        let consumed = Math.max(0, consumedAmount || 0);

        for (let i = 0; i < bandRules.length && remaining > 0; i++) {
            const band = bandRules[i];
            const threshold = band.threshold !== undefined ? band.threshold : Number.POSITIVE_INFINITY;
            if (consumed >= threshold) {
                continue;
            }
            const available = threshold - consumed;
            const taxableInBand = threshold === Number.POSITIVE_INFINITY ? remaining : Math.min(remaining, available);
            tax += taxableInBand * band.rate;
            remaining -= taxableInBand;
            consumed = threshold;
        }

        if (remaining > 0) {
            const lastRate = bandRules.length ? bandRules[bandRules.length - 1].rate : 0;
            tax += remaining * lastRate;
        }

        return tax;
    }

    function niClassLabel(taxType) {
        const labels = {
            'NI class 1 (employees)': 'NI Class 1',
            'NI class 2 (self-employed)': 'NI Class 2',
            'NI class 4 (self-employed)': 'NI Class 4'
        };
        return labels[taxType] || 'NI';
    }

    function titleCase(input) {
        if (!input) return '';
        return input.replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
    }

    // --- Core ---------------------------------------------------------------

    /**
     * Income tax or a single NI class on `grossIncome`, under one ruleset.
     * Set `collectDetails` for the itemised breakdown used by the results panel.
     */
    function taxAndNi(grossIncome, dataset, taxType, h, options) {
        const opts = options || {};
        const collectDetails = Boolean(opts.collectDetails);
        const mode = opts.mode || 'smooth';
        const overrides = opts.overrides || {};

        if (!dataset || !taxType) {
            return collectDetails
                ? { total: 0, bands: [], adjustments: [], personalAllowance: null }
                : { total: 0, bands: [], adjustments: [], personalAllowance: null };
        }

        // Adjusted net income drives the personal allowance taper, HICBC and the
        // marriage allowance test. Relief at source reduces it without reducing the
        // income the bands and student loan operate on, so it is tracked separately.
        const aniIncome = opts.aniIncome !== undefined ? opts.aniIncome : grossIncome;
        const studentLoanIncome = opts.studentLoanIncome !== undefined ? opts.studentLoanIncome : grossIncome;
        const bandExtension = opts.bandExtension || 0;

        let totalTax = 0;
        let taxableNetIncome;
        const bandBreakdown = [];
        const adjustments = [];
        let personalAllowanceUsed = null;
        let modifiedPersonalAllowance;
        const isIncomeTax = taxType === 'income tax';
        const bandRules = extendBands(Array.isArray(dataset[taxType]) ? dataset[taxType] : [], bandExtension);
        const classLabel = isIncomeTax ? null : niClassLabel(taxType);
        const loanPlan = activeStudentLoanPlan(h, dataset);
        const incomeSplit = overrides.incomeSplit || null;
        const useIncomeSplit = Boolean(isIncomeTax && incomeSplit && incomeSplit.extraAmount > 0);

        if (isIncomeTax) {
            modifiedPersonalAllowance = overrides.forcePersonalAllowance !== undefined
                ? overrides.forcePersonalAllowance
                : personalAllowance(aniIncome, dataset, mode);
            personalAllowanceUsed = modifiedPersonalAllowance;
            taxableNetIncome = Math.max(0, grossIncome - modifiedPersonalAllowance);

            if (h.children > 0) {
                const charge = hicbcCharge(aniIncome, dataset, mode, h);
                totalTax += charge;
                if (collectDetails && charge > 0) {
                    adjustments.push({ label: 'Child benefit clawback', amount: -charge, type: 'debit' });
                }
            }

            if (loanPlan) {
                const loanCharge = (loanPlan.components || []).reduce((sum, component) => {
                    if (studentLoanIncome > component.threshold) {
                        return sum + (studentLoanIncome - component.threshold) * component.rate;
                    }
                    return sum;
                }, 0);
                if (loanCharge > 0) {
                    totalTax += loanCharge;
                    if (collectDetails) {
                        adjustments.push({ label: 'Student loan', amount: loanCharge, type: 'debit' });
                    }
                }
            }


        } else {
            taxableNetIncome = grossIncome;
        }

        if (useIncomeSplit) {
            const baseAmount = Math.max(0, Number(incomeSplit.baseAmount) || 0);
            const extraAmount = Math.max(0, Number(incomeSplit.extraAmount) || 0);
            const extraBandRules = incomeSplit.extraBandKey && Array.isArray(dataset[incomeSplit.extraBandKey])
                ? extendBands(dataset[incomeSplit.extraBandKey], bandExtension)
                : bandRules;

            const baseAfterAllowance = Math.max(0, baseAmount - (modifiedPersonalAllowance || 0));
            const allowanceRemaining = Math.max(0, (modifiedPersonalAllowance || 0) - baseAmount);
            const extraAfterAllowance = Math.max(0, extraAmount - allowanceRemaining);

            totalTax += bandTax(baseAfterAllowance, bandRules)
                + bandTax(extraAfterAllowance, extraBandRules, baseAfterAllowance);
            taxableNetIncome = baseAfterAllowance + extraAfterAllowance;
        } else {
            let lastThreshold = 0;
            for (const band of bandRules) {
                const threshold = band.threshold || 1e12;
                if (taxableNetIncome > lastThreshold) {
                    const incomeInBand = Math.min(taxableNetIncome, threshold) - lastThreshold;
                    const taxInBand = incomeInBand * band.rate;
                    totalTax += taxInBand;
                    if (collectDetails) {
                        let label;
                        if (band.name) {
                            label = titleCase(band.name);
                            if (!isIncomeTax && classLabel) {
                                label = classLabel + ' - ' + label;
                            }
                        } else {
                            label = isIncomeTax ? 'Income Tax band' : (classLabel || 'NI') + ' band';
                        }
                        bandBreakdown.push({ label, amount: taxInBand });
                    }
                }
                lastThreshold = threshold;
            }
        }

        // Marriage allowance reduces ordinary income tax, never loans or charges.
        if (isIncomeTax && h.includeMarriageAllowance
            && aniIncome <= dataset['marriage allowance max earnings'] + EPSILON) {
            const transfer = Math.ceil(dataset['statutory personal allowance']
                * dataset['marriage allowance'] / 10) * 10;
            const rate = dataset['marriage allowance relief rate'] ?? 0.20;
            const ordinaryTax = bandTax(taxableNetIncome, bandRules);
            const credit = Math.min(transfer * rate, ordinaryTax);
            totalTax -= credit;
            if (collectDetails && credit > 0) {
                adjustments.push({ label: 'Marriage allowance credit', amount: -credit, type: 'credit' });
            }
        }

        // Annual allowance charge: the excess contribution is added on top of
        // taxable income and taxed at the rates that then apply, which claws back
        // the relief just given. It is an income tax charge only — no NI.
        if (isIncomeTax && opts.annualAllowanceExcess > 0) {
            const excess = opts.annualAllowanceExcess;
            // The Scottish starter rate never applies to the charge: the basic rate
            // runs from nil (FA 2004 s227(4AA)).
            const aaRules = bandRules.filter(band => band.name !== 'starter');
            const aaCharge = bandTax(taxableNetIncome + excess, aaRules) - bandTax(taxableNetIncome, aaRules);
            if (aaCharge > 0) {
                totalTax += aaCharge;
                if (collectDetails) {
                    adjustments.push({ label: 'Annual allowance charge', amount: aaCharge, type: 'debit' });
                }
            }
        }

        if (!isIncomeTax && taxType === 'NI class 4 (self-employed)') {
            const class2 = class2Contribution(grossIncome, dataset['NI class 2 (self-employed)']);
            if (class2 > 0) {
                totalTax += class2;
                if (collectDetails) {
                    bandBreakdown.push({
                        label: niClassLabel('NI class 2 (self-employed)') + ' - Flat rate',
                        amount: class2
                    });
                }
            }
        }

        return {
            total: totalTax,
            bands: bandBreakdown,
            adjustments,
            personalAllowance: personalAllowanceUsed
        };
    }

    /**
     * Total tax and NI at one income, plus the same figure net of child benefit
     * and childcare credits (`adjustedTax`, the basis for the marginal rate).
     */
    /**
     * Resolve how a pension contribution reshapes one income into the several
     * different incomes the rules each care about.
     *
     * Salary sacrifice reduces gross pay outright, so income tax, employee NI,
     * employer NI, the student loan, the personal allowance taper and HICBC all
     * see the lower figure. Relief at source leaves NI and the student loan on
     * full pay, reduces adjusted net income for the taper and HICBC, and gives
     * higher-rate relief by extending the basic rate limit.
     */
    function pensionContext(grossIncome, dataset, h, mode) {
        const pension = pensionFor(grossIncome, h, dataset);
        const sacrificing = pension.method === 'sacrifice' && pension.gross > 0;
        const payAfterSacrifice = sacrificing ? grossIncome - pension.gross : grossIncome;
        const split = transformIncomeForEmployment(payAfterSacrifice, dataset, h);
        const usingRas = pension.method === 'relief_at_source' && pension.gross > 0;
        const netpay = pension.method === 'netpay';
        const taxablePay = Math.max(0, split.taxableIncome - (netpay ? pension.gross : 0));
        // Self Assessment loan income is reduced by relief at source contributions
        // (SI 2009/470 reg 29(4)(j)). Employees are modelled on payroll deductions,
        // which take no account of them.
        const loanIncome = usingRas && isSelfEmploymentType(h)
            ? Math.max(0, split.taxableIncome - pension.gross) : split.taxableIncome;
        const aa = annualAllowanceFor(grossIncome, dataset, h, mode);
        return {
            pension,
            payAfterSacrifice,
            taxableIncome: taxablePay,
            niIncome: split.taxableIncome,
            studentLoanIncome: loanIncome,
            employerNi: split.employerNi,
            aniIncome: usingRas ? Math.max(0, split.taxableIncome - pension.gross) : taxablePay,
            bandExtension: usingRas ? pension.gross : 0,
            // The provider's basic-rate top-up is tax relief paid into the pension.
            // It isn't cash, but rates must count it, or a SIPP looks dearer than
            // net pay for the same take-home and the same pension.
            reliefAtSource: usingRas ? pension.gross - pension.employeeOutlay : 0,
            annualAllowance: aa
        };
    }

    function totals(grossIncome, dataset, h, mode) {
        if (grossIncome < 0) grossIncome = 0;
        if (!dataset) {
            return { totalTax: 0, adjustedTax: 0, employerNi: 0, taxableIncome: 0 };
        }
        const calcMode = mode || 'actual';
        const ctx = pensionContext(grossIncome, dataset, h, calcMode);
        const cbCredit = childBenefitAmount(dataset, h);
        const ccCredit = childcareSubsidy(ctx.aniIncome, dataset, h);
        const niKey = activeNiKey(h);
        const taxOpts = {
            mode: calcMode,
            aniIncome: ctx.aniIncome,
            bandExtension: ctx.bandExtension,
            studentLoanIncome: ctx.studentLoanIncome,
            annualAllowanceExcess: ctx.annualAllowance.excess
        };
        const incomeTax = taxAndNi(ctx.taxableIncome, dataset, 'income tax', h, taxOpts).total;
        const ni = niKey ? taxAndNi(ctx.niIncome, dataset, niKey, h, { mode: calcMode }).total : 0;
        const totalTax = incomeTax + ni + ctx.employerNi;
        return {
            totalTax,
            adjustedTax: totalTax - cbCredit - ccCredit - ctx.reliefAtSource,
            employerNi: ctx.employerNi,
            taxableIncome: ctx.taxableIncome,
            pensionGross: ctx.pension.gross,
            employeeOutlay: ctx.pension.employeeOutlay,
            annualAllowance: ctx.annualAllowance,
            // Take-home cash. The pension pot is savings, not spendable income, so
            // it is reported separately rather than folded into net income.
            netIncome: grossIncome - ctx.pension.employeeOutlay - (totalTax - cbCredit - ccCredit)
        };
    }

    /** Totals at income + PERTURBATION (the next £1), with the extra slice taxed as `marginalIncomeType`. */
    function perturbedTotals(baseIncome, dataset, h, mode, step) {
        if (!dataset) {
            return { totalTax: 0, adjustedTax: 0 };
        }
        const calcMode = mode || 'actual';
        const extra = step || PERTURBATION;
        const type = h.marginalIncomeType;
        if (!type || type === 'primary') {
            return totals(baseIncome + extra, dataset, h, calcMode);
        }

        // The extra slice is unearned income, so it does not itself attract pension
        // contributions, but it does count towards adjusted net income.
        const ctx = pensionContext(baseIncome, dataset, h, calcMode);
        const totalTaxableIncome = ctx.taxableIncome + extra;
        const aniIncome = ctx.aniIncome + extra;
        const cbCredit = childBenefitAmount(dataset, h);
        const ccCredit = childcareSubsidy(aniIncome, dataset, h);
        const niKey = activeNiKey(h);

        const incomeTax = taxAndNi(totalTaxableIncome, dataset, 'income tax', h, {
            mode: calcMode,
            aniIncome,
            bandExtension: ctx.bandExtension,
            studentLoanIncome: ctx.studentLoanIncome + extra,
            annualAllowanceExcess: ctx.annualAllowance.excess,
            overrides: {
                incomeSplit: {
                    baseAmount: ctx.taxableIncome,
                    extraAmount: extra,
                    extraBandKey: marginalBandKey(type)
                }
            }
        }).total;

        const ni = niKey ? taxAndNi(ctx.niIncome, dataset, niKey, h, { mode: calcMode }).total : 0;
        const totalTax = incomeTax + ni + ctx.employerNi;
        return { totalTax, adjustedTax: totalTax - cbCredit - ccCredit - ctx.reliefAtSource };
    }

    /**
     * Marginal rate on the next £1, as a percentage. Smooth mode on both sides;
     * see file header. `step` exists for the legacy parity check, which compares
     * against the 2025 calculator's £100 window.
     */
    function marginalRate(income, dataset, h, step) {
        if (!income || !dataset) {
            return 0;
        }
        const extra = step || PERTURBATION;
        const base = totals(income, dataset, h, 'smooth');
        const perturbed = perturbedTotals(income, dataset, h, 'smooth', extra);
        return ((perturbed.adjustedTax - base.adjustedTax) / extra) * 100;
    }

    /** Everything the results panel needs at a single income, in statutory £. */
    function summary(income, dataset, h) {
        if (!dataset) return null;
        income = Math.max(0, Number(income) || 0);
        const ctx = pensionContext(income, dataset, h, 'actual');
        const cbCredit = childBenefitAmount(dataset, h);
        const ccCredit = childcareSubsidy(ctx.aniIncome, dataset, h);
        const niKey = activeNiKey(h);

        const incomeTaxDetails = taxAndNi(ctx.taxableIncome, dataset, 'income tax', h, {
            mode: 'actual',
            collectDetails: true,
            aniIncome: ctx.aniIncome,
            bandExtension: ctx.bandExtension,
            studentLoanIncome: ctx.studentLoanIncome,
            annualAllowanceExcess: ctx.annualAllowance.excess
        });
        const niDetails = niKey
            ? taxAndNi(ctx.niIncome, dataset, niKey, h, { mode: 'actual', collectDetails: true })
            : { total: 0, bands: [], adjustments: [], personalAllowance: null };

        const totalTax = incomeTaxDetails.total + niDetails.total + ctx.employerNi;
        const loanRepayments = incomeTaxDetails.adjustments
            .filter(a => a.label === 'Student loan').reduce((sum, a) => sum + a.amount, 0);
        const displayedTotalTax = totalTax - loanRepayments;
        const cashTakeHome = income - ctx.pension.employeeOutlay - totalTax;
        const pensionNetCost = ctx.pension.gross > 0
            ? totals(income, dataset, household(Object.assign({}, h, { pensionContribution: 0 }))).netIncome
                - (cashTakeHome + cbCredit + ccCredit)
            : 0;
        const adjustedTotalTax = totalTax - cbCredit - ccCredit - ctx.reliefAtSource;

        return {
            income,
            netIncome: cashTakeHome + cbCredit + ccCredit,
            cashTakeHome,
            cashWithBenefits: cashTakeHome + cbCredit,
            loanRepayments,
            incomeTaxAmount: incomeTaxDetails.total - loanRepayments,
            taxRate: income === 0 ? 0 : displayedTotalTax / income * 100,
            pensionNetCost,
            adjustedNetIncome: ctx.aniIncome,
            totalTax: displayedTotalTax,
            effectiveRate: income === 0 ? 0 : (adjustedTotalTax / income) * 100,
            marginalRate: marginalRate(income, dataset, h),
            employerNi: ctx.employerNi,
            childBenefitCredit: cbCredit,
            childcareCredit: ccCredit,
            pensionGross: ctx.pension.gross,
            pensionEmployeeOutlay: ctx.pension.employeeOutlay,
            pensionMethod: ctx.pension.method,
            pensionCapped: ctx.pension.capped,
            pensionReliefAtSource: ctx.reliefAtSource,
            annualAllowance: ctx.annualAllowance,
            incomeTax: incomeTaxDetails,
            ni: niDetails,
            personalAllowance: incomeTaxDetails.personalAllowance
        };
    }

    /** The highest income for which `within` still holds, or null if it always does. */
    function lastIncomeWhere(limit, within) {
        let low = 0, high = limit;
        if (within(high) || !within(low)) return null;
        for (let i = 0; i < 64; i++) {
            const mid = low + (high - low) / 2;
            if (within(mid)) low = mid;
            else high = mid;
        }
        return low;
    }

    function aniCliff(dataset, h, limit, threshold) {
        return lastIncomeWhere(limit, income => pensionContext(income, dataset, h).aniIncome <= threshold + EPSILON);
    }

    function childcareCliff(dataset, h, limit) {
        if (!(h.childcareSubsidyAmount > 0) || !dataset) return null;
        return aniCliff(dataset, h, limit, dataset['childcare max earnings']);
    }

    function marriageAllowanceCliff(dataset, h, limit) {
        if (!h.includeMarriageAllowance || !dataset) return null;
        return aniCliff(dataset, h, limit, dataset['marriage allowance max earnings']);
    }

    /**
     * Threshold income crossing £200,000 switches the annual allowance taper on
     * at once, when adjusted income is already over £260,000 (FA 2004 s228ZA).
     */
    function annualAllowanceCliff(dataset, h, limit) {
        if (!dataset || !(Number(h.pensionContribution) > 0)) return null;
        const thresholdLimit = dataset['pension AA threshold income limit'];
        const cliff = lastIncomeWhere(limit,
            income => annualAllowanceFor(income, dataset, h, 'smooth').thresholdIncome <= thresholdLimit + EPSILON);
        return cliff !== null && annualAllowanceFor(cliff + 0.01, dataset, h, 'smooth').tapered ? cliff : null;
    }

    /** Chart series across an income range. Marginal uses smooth mode throughout. */
    function curve(dataset, h, maxIncome, step) {
        const increment = step || CHART_STEP;
        const limit = maxIncome || 180000;
        const out = { gross: [], net: [], marginal: [], effective: [], pension: [] };
        if (!dataset) return out;

        const samples = new Set([0, limit]);
        for (let gross = 0; gross <= limit; gross += increment) samples.add(gross);
        // Cliffs are narrower than any grid, so sample both sides explicitly.
        for (const cliff of [childcareCliff(dataset, h, limit), marriageAllowanceCliff(dataset, h, limit),
            annualAllowanceCliff(dataset, h, limit)]) {
            if (cliff === null) continue;
            for (const offset of [-PERTURBATION, -0.01, 0, 0.01]) {
                const point = cliff + offset;
                if (point >= 0 && point <= limit) samples.add(point);
            }
        }
        for (const gross of [...samples].sort((a, b) => a - b)) {
            const t = totals(gross, dataset, h, 'smooth');
            out.gross.push(gross);
            out.net.push(t.netIncome);
            out.marginal.push(marginalRate(gross, dataset, h));
            out.effective.push(gross === 0 ? 0 : (t.adjustedTax / gross) * 100);
            out.pension.push(t.pensionGross);
        }
        return out;
    }

    /** Reject incomplete selectable rulesets before the UI can display results. */
    function validateDatasets(data) {
        if (!data || typeof data !== 'object' || !Object.keys(data).length) throw new Error('No tax rules');
        const required = ['statutory personal allowance', 'allowance withdrawal threshold',
            'allowance withdrawal rate', 'HICBC start', 'HICBC income per percent reduction',
            'childcare max earnings', 'marriage allowance', 'marriage allowance max earnings',
            'pension relief at source rate', 'marriage allowance relief rate',
            'pension relief at source basic amount',
            'pension annual allowance', 'pension AA threshold income limit',
            'pension AA adjusted income limit', 'pension AA taper rate', 'pension AA minimum'];
        const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
        for (const [name, ds] of Object.entries(data)) {
            const fail = key => { throw new Error(name + ': invalid ' + key); };
            if (!ds || typeof ds !== 'object') fail('ruleset');
            for (const key of required) if (!finite(ds[key])) fail(key);
            if (!(ds['HICBC income per percent reduction'] > 0)) fail('HICBC divisor');
            if (ds['pension AA minimum'] > ds['pension annual allowance']) fail('annual allowance minimum');
            const class2 = ds['NI class 2 (self-employed)'];
            if (class2 && (!finite(class2.weekly_amount) || !finite(class2.lower_profits_limit))) fail('NI class 2');
            for (const key of ['pension relief at source rate', 'marriage allowance relief rate',
                'allowance withdrawal rate', 'pension AA taper rate', 'marriage allowance']) {
                if (ds[key] > 1) fail(key);
            }
            for (const key of ['income tax', 'NI class 1 (employees)', 'NI class 4 (self-employed)']) {
                const bands = ds[key];
                if (!Array.isArray(bands) || !bands.length) fail(key);
                let previous = 0;
                bands.forEach((band, i) => {
                    if (!band || !finite(band.rate) || band.rate > 1) fail(key);
                    if (i === bands.length - 1) {
                        if (band.threshold !== undefined) fail(key + ' final band');
                    } else {
                        if (!finite(band.threshold) || band.threshold <= previous) fail(key + ' threshold');
                        previous = band.threshold;
                    }
                });
            }
            for (const key of ['1st', 'subsequent']) if (!finite(ds['child benefit']?.[key])) fail('child benefit');
            for (const plan of Object.keys(STUDENT_LOAN_DEFAULTS)) {
                const rule = ds['student loan']?.[plan];
                if (!rule || !finite(rule.rate) || rule.rate > 1 || !finite(rule.threshold)) fail(plan);
            }
            const employer = ds['employer NI'];
            if (!employer || !finite(employer['employer nic rate']) || employer['employer nic rate'] > 1
                || !finite(employer['employer nic secondary threshold annual'])) fail('employer NI');
            if (!ds._meta || !/^\d{4}-\d{2}-\d{2}$/.test(ds._meta.regimeDate)
                || !ds._meta.sources || !Object.keys(ds._meta.sources).length) fail('provenance');
        }
        return true;
    }

    return {
        PERTURBATION,
        STUDENT_LOAN_PLANS,
        RELIEF_AT_SOURCE_METHODS,
        household,
        // classification
        isSelfEmploymentType,
        requiresEmployerNiGrossDown,
        activeNiKey,
        activeStudentLoanPlan,
        loanComponents,
        // components
        transformIncomeForEmployment,
        pensionFor,
        pensionContext,
        annualAllowanceFor,
        extendBands,
        personalAllowance,
        childBenefitAmount,
        hicbcCharge,
        childcareSubsidy,
        class2Contribution,
        bandTax,
        marginalBandKey,
        // core
        taxAndNi,
        totals,
        perturbedTotals,
        marginalRate,
        summary,
        curve,
        childcareCliff,
        marriageAllowanceCliff,
        annualAllowanceCliff,
        validateDatasets
    };
}));
