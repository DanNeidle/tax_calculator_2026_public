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
        pensionMethod: 'sacrifice',    // see RELIEF_AT_SOURCE_METHODS
        // Fixed annual amounts alongside the main income. None of them moves along
        // the chart: the x-axis is always the main income.
        benefitCar: 0,                 // taxable benefits in kind (employees only)
        benefitMedical: 0,
        benefitOther: 0,
        statePension: 0,               // pension income on top of the main income
        privatePension: 0,
        savingsInterest: 0,            // investment income and gains
        dividendIncome: 0,
        capitalGains: 0,
        rentalIncome: 0,               // gross rent from property let personally
        rentalExpenses: 0,             // allowable running costs
        rentalFinanceCosts: 0,         // mortgage interest and other finance costs
        // 'auto' takes whichever of actual expenses or the £1,000 property allowance
        // leaves less tax; the other values force one route.
        propertyRoute: 'auto',         // 'auto' | 'expenses' | 'allowance'
        otherSacrifice: 0              // non-pension salary sacrifice (employees only)
    };

    function household(overrides) {
        return Object.assign({}, DEFAULT_HOUSEHOLD, overrides || {});
    }

    // --- Employment classification -----------------------------------------

    function isSelfEmploymentType(h) {
        return h.employmentType === 'Self-employed' || h.employmentType === 'Partnership/LLP';
    }

    function isEmployee(h) {
        return !isSelfEmploymentType(h) && h.employmentType !== 'Pension income';
    }

    // --- Other income -------------------------------------------------------

    function positive(value) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : 0;
    }

    /** Benefits in kind are taxed as pay, but bear no employee NI or student loan. */
    function benefitsInKind(h) {
        return isEmployee(h) ? positive(h.benefitCar) + positive(h.benefitMedical) + positive(h.benefitOther) : 0;
    }

    /** Pension income is taxed as non-savings income, with no NI. */
    function pensionIncomeOf(h) {
        return positive(h.statePension) + positive(h.privatePension);
    }

    function investmentsOf(h) {
        return { savings: positive(h.savingsInterest), dividends: positive(h.dividendIncome), gains: positive(h.capitalGains) };
    }

    function hasRentalIncome(h) {
        return positive(h.rentalIncome) > 0;
    }

    /**
     * Rental profit is non-savings income. Residential finance costs aren't
     * deductible: they give a basic rate tax credit instead (ITTOIA 2005 ss272A
     * and 274A). The £1,000 property allowance replaces all deductions, finance
     * costs included (ITTOIA 2005 Part 7A). A loss is treated as nil; it
     * isn't carried forward. `cash` is what actually comes in, whichever route.
     */
    function rentalOf(h, dataset) {
        const gross = positive(h.rentalIncome);
        const expenses = positive(h.rentalExpenses);
        const finance = positive(h.rentalFinanceCosts);
        if (!gross) return { profit: 0, financeCosts: 0, cash: 0 };
        const cash = gross - expenses - finance;
        const allowance = (dataset && dataset['property income'] && dataset['property income']['property allowance']) || 0;
        if (h.propertyRoute === 'allowance') return { profit: Math.max(0, gross - allowance), financeCosts: 0, cash };
        return { profit: Math.max(0, gross - expenses), financeCosts: finance, cash };
    }

    /** Non-pension salary sacrifice, capped at the pay left after any pension sacrifice. */
    function otherSacrificeFor(grossIncome, h, pension) {
        if (!isEmployee(h)) return 0;
        const fromPay = pension.method === 'sacrifice' || pension.method === 'netpay';
        const left = Math.max(0, grossIncome - (fromPay ? pension.gross : 0));
        return Math.min(positive(h.otherSacrifice), left);
    }

    function requiresEmployerNiGrossDown(h) {
        return h.employmentType === 'Within IR35';
    }

    function activeNiKey(h) {
        if (['Retired/State pension age', 'Working past State Pension age', 'Pension income'].includes(h.employmentType)) {
            return null;
        }
        if (isSelfEmploymentType(h)) {
            return 'NI class 4 (self-employed)';
        }
        // Someone receiving the state pension has reached State Pension age, so no employee NI.
        // Class 4 runs to the end of that tax year, so the self-employed keep it.
        return positive(h.statePension) > 0 ? null : 'NI class 1 (employees)';
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
        const method = isEmployee(h) &&['sacrifice', 'netpay'].includes(h.pensionMethod)
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
            grossIncome - (sacrificing ? pension.gross : 0) - otherSacrificeFor(grossIncome, h, pension),
            dataset, h).taxableIncome;
        // Both tests start from net income, so other taxable income counts too.
        const inv = investmentsOf(h);
        const other = benefitsInKind(h) + pensionIncomeOf(h) + inv.savings + inv.dividends + rentalOf(h, dataset).profit;
        const adjustedIncome = earnings + other + (sacrificing ? pension.gross : 0);
        const thresholdIncome = sacrificing ? adjustedIncome : Math.max(0, earnings + other - pension.gross);

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

    function bandLimit(bandRules, name) {
        const band = bandRules.find(b => b.name === name);
        return band && band.threshold !== undefined ? band.threshold : Number.POSITIVE_INFINITY;
    }

    /**
     * Tax on savings interest and dividends, and capital gains tax, stacked on top
     * of non-savings income in the statutory order (ITA 2007 s16): non-savings,
     * then savings, then dividends, with gains on top of all of it for CGT.
     *
     * Savings and dividend rates and bands are not devolved, so a Scottish taxpayer
     * uses the UK bands here, measured against total taxable income including the
     * Scottish-taxed slice. The same goes for the personal savings allowance test
     * and the CGT basic rate band. Nil-rate amounts (starting rate, personal savings
     * allowance, dividend allowance) still use up band space.
     *
     * Any tax deducted at source, UK or foreign, is ignored.
     */
    function investmentTax(nonSavingsIncome, allowance, inv, dataset, bandExtension) {
        const cfg = dataset['savings and dividend allowances'] || {};
        const ukBands = extendBands(dataset['income tax - savings'] || dataset['income tax'], bandExtension);
        const dividendBands = extendBands(dataset['income tax - dividends'] || ukBands, bandExtension);

        // The personal allowance goes against non-savings income first. Total
        // taxable income, the starting rate band and the personal savings allowance
        // don't depend on how the rest is split, so they can be settled first.
        const allowanceLeft = Math.max(0, allowance - nonSavingsIncome);
        const base = Math.max(0, nonSavingsIncome - allowance);
        const taxable = Math.max(0, nonSavingsIncome + inv.savings + inv.dividends - allowance);

        const basicLimit = bandLimit(ukBands, 'basic');
        const higherLimit = bandLimit(ukBands, 'higher');
        const savingsAllowance = taxable > higherLimit + EPSILON ? (cfg['personal savings allowance additional'] || 0)
            : taxable > basicLimit + EPSILON ? (cfg['personal savings allowance higher'] || 0)
            : (cfg['personal savings allowance basic'] || 0);
        // The starting rate band shrinks £1 for £1 with non-savings taxable income.
        const startingRoom = Math.max(0, (cfg['starting rate for savings band'] || 0) - base);

        // The rest of the allowance goes where it saves most tax (ITA 2007 s25(2)).
        // Savings rates are never below dividend rates, so it covers savings, but
        // only savings that would otherwise be taxed: the starting rate band and the
        // personal savings allowance cover the first slice anyway. Then dividends,
        // and anything still left goes back to savings.
        let toSavings = Math.min(allowanceLeft, Math.max(0, inv.savings - startingRoom - savingsAllowance));
        const toDividends = Math.min(allowanceLeft - toSavings, inv.dividends);
        toSavings += Math.min(allowanceLeft - toSavings - toDividends, inv.savings - toSavings);
        const savings = inv.savings - toSavings;
        const dividends = inv.dividends - toDividends;
        const savingsNil = Math.min(savings, startingRoom + savingsAllowance);
        const savingsTax = bandTax(savings - savingsNil, ukBands, base + savingsNil);
        const dividendNil = Math.min(dividends, cfg['dividend allowance'] || 0);
        const dividendTax = bandTax(dividends - dividendNil, dividendBands, base + savings + dividendNil);

        const cgt = dataset['capital gains tax'] || {};
        const gains = Math.max(0, inv.gains - (cgt['annual exempt amount'] || 0));
        const basicRoom = Math.max(0, basicLimit - taxable);
        const gainsTax = Math.min(gains, basicRoom) * (cgt['basic rate'] || 0)
            + Math.max(0, gains - basicRoom) * (cgt['higher rate'] || 0);

        return { savingsTax, dividendTax, gainsTax, taxable, savingsAllowance };
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

        // Savings, dividends and gains. Not combined with an income split, which
        // already puts its own slice on top of non-savings income.
        let investment = null;
        const inv = isIncomeTax && !useIncomeSplit ? opts.investments : null;
        if (inv && (inv.savings > 0 || inv.dividends > 0 || inv.gains > 0)) {
            investment = investmentTax(grossIncome, modifiedPersonalAllowance || 0, inv, dataset, bandExtension);
            totalTax += investment.savingsTax + investment.dividendTax;
            if (collectDetails) {
                if (investment.savingsTax > 0) adjustments.push({ label: 'Tax on savings interest', amount: investment.savingsTax, type: 'debit' });
                if (investment.dividendTax > 0) adjustments.push({ label: 'Tax on dividends', amount: investment.dividendTax, type: 'debit' });
            }
        }

        // Both tax reducers come off ordinary income tax, never loans or charges.
        const ordinaryTax = isIncomeTax ? bandTax(taxableNetIncome, bandRules)
            + (investment ? investment.savingsTax + investment.dividendTax : 0) : 0;
        let reduced = 0;

        // Finance costs on a let property: basic rate relief on the lowest of the
        // costs, the rental profit and non-savings income above the allowance.
        const rental = isIncomeTax && !useIncomeSplit ? opts.rental : null;
        if (rental && rental.financeCosts > 0) {
            const rate = (dataset['property income'] && dataset['property income']['finance cost relief rate']) || 0;
            const credit = Math.min(rate * Math.min(rental.financeCosts, rental.profit, taxableNetIncome), ordinaryTax);
            if (credit > 0) {
                totalTax -= credit;
                reduced += credit;
                if (collectDetails) adjustments.push({ label: 'Finance cost relief', amount: -credit, type: 'credit' });
            }
        }

        // Marriage allowance reduces ordinary income tax, never loans or charges.
        if (isIncomeTax && h.includeMarriageAllowance
            && aniIncome <= dataset['marriage allowance max earnings'] + EPSILON) {
            const transfer = Math.ceil(dataset['statutory personal allowance']
                * dataset['marriage allowance'] / 10) * 10;
            const rate = dataset['marriage allowance relief rate'] ?? 0.20;
            const credit = Math.min(transfer * rate, ordinaryTax - reduced);
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
            // The excess is the top slice of total income (FA 2004 s227(4)), so it sits above savings and dividends.
            const top = investment ? investment.taxable : taxableNetIncome;
            const aaCharge = bandTax(top + excess, aaRules) - bandTax(top, aaRules);
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
            personalAllowance: personalAllowanceUsed,
            // Capital gains tax isn't income tax, so it stays out of `total`.
            capitalGainsTax: investment ? investment.gainsTax : 0,
            savingsTax: investment ? investment.savingsTax : 0,
            dividendTax: investment ? investment.dividendTax : 0
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
        h = withPropertyRoute(grossIncome, dataset, h, mode);
        const pension = pensionFor(grossIncome, h, dataset);
        const sacrificing = pension.method === 'sacrifice' && pension.gross > 0;
        // Other salary sacrifice (a car, a bike) comes off pay for every purpose, as pension sacrifice does.
        const otherSacrifice = otherSacrificeFor(grossIncome, h, pension);
        const payAfterSacrifice = grossIncome - (sacrificing ? pension.gross : 0) - otherSacrifice;
        const split = transformIncomeForEmployment(payAfterSacrifice, dataset, h);
        const usingRas = pension.method === 'relief_at_source' && pension.gross > 0;
        const netpay = pension.method === 'netpay';
        const taxablePay = Math.max(0, split.taxableIncome - (netpay ? pension.gross : 0));
        // Benefits in kind and pension income are non-savings income: taxed, and in
        // adjusted net income, but outside NI and payroll student loan deductions.
        const benefits = benefitsInKind(h);
        const pensionIncome = pensionIncomeOf(h);
        const investments = investmentsOf(h);
        const rental = rentalOf(h, dataset);
        const nonSavings = taxablePay + benefits + pensionIncome + rental.profit;
        // Student loan income. Payroll deducts on earnings alone, before net pay
        // contributions. Self Assessment instead uses total income (SI 2009/470
        // reg 29(4)): pension income in full, benefits in kind excluded, unearned
        // income (interest, dividends, rent) in full only if it's over £2,000, and
        // relief at source contributions deducted. Gains aren't income. We assume a
        // return is filed by the self-employed, pensioners, and anyone whose
        // unearned income is over the threshold (CSLM16035); otherwise payroll.
        const unearned = investments.savings + investments.dividends + rental.profit;
        const unearnedThreshold = dataset && dataset['student loan unearned income threshold'] !== undefined
            ? dataset['student loan unearned income threshold'] : Infinity;
        const unearnedCounts = unearned > unearnedThreshold + EPSILON;
        const selfAssessment = isSelfEmploymentType(h) || h.employmentType === 'Pension income'
            || pensionIncome > 0 || unearnedCounts;
        const loanIncome = selfAssessment
            ? Math.max(0, taxablePay + pensionIncome + (unearnedCounts ? unearned : 0) - (usingRas ? pension.gross : 0))
            : split.taxableIncome;
        const aa = annualAllowanceFor(grossIncome, dataset, h, mode);
        return {
            pension,
            payAfterSacrifice,
            otherSacrifice,
            benefits,
            pensionIncome,
            investments,
            // Money received, before tax. Benefits in kind aren't cash.
            rental,
            cashIncome: grossIncome + pensionIncome + investments.savings + investments.dividends + investments.gains
                + rental.cash,
            taxableIncome: nonSavings,
            niIncome: split.taxableIncome,
            studentLoanIncome: loanIncome,
            selfAssessment,
            employerNi: split.employerNi,
            aniIncome: Math.max(0, nonSavings + investments.savings + investments.dividends
                - (usingRas ? pension.gross : 0)),
            bandExtension: usingRas ? pension.gross : 0,
            // The provider's basic-rate top-up is tax relief paid into the pension.
            // It isn't cash, but rates must count it, or a SIPP looks dearer than
            // net pay for the same take-home and the same pension.
            reliefAtSource: usingRas ? pension.gross - pension.employeeOutlay : 0,
            annualAllowance: aa
        };
    }

    /**
     * With rental income and the route left on 'auto', take whichever of actual
     * expenses and the property allowance leaves less tax at this income.
     */
    function withPropertyRoute(grossIncome, dataset, h, mode) {
        if (!dataset || !hasRentalIncome(h) || (h.propertyRoute && h.propertyRoute !== 'auto')) return h;
        const expenses = Object.assign({}, h, { propertyRoute: 'expenses' });
        const allowance = Object.assign({}, h, { propertyRoute: 'allowance' });
        return totals(grossIncome, dataset, allowance, mode).adjustedTax
            < totals(grossIncome, dataset, expenses, mode).adjustedTax - EPSILON ? allowance : expenses;
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
            annualAllowanceExcess: ctx.annualAllowance.excess,
            investments: ctx.investments,
            rental: ctx.rental
        };
        const income = taxAndNi(ctx.taxableIncome, dataset, 'income tax', h, taxOpts);
        const ni = niKey ? taxAndNi(ctx.niIncome, dataset, niKey, h, { mode: calcMode }).total : 0;
        const totalTax = income.total + ni + ctx.employerNi + income.capitalGainsTax;
        return {
            totalTax,
            adjustedTax: totalTax - cbCredit - ccCredit - ctx.reliefAtSource,
            employerNi: ctx.employerNi,
            taxableIncome: ctx.taxableIncome,
            pensionGross: ctx.pension.gross,
            employeeOutlay: ctx.pension.employeeOutlay,
            annualAllowance: ctx.annualAllowance,
            // Everything the effective rate is a share of, benefits in kind included.
            totalIncome: ctx.cashIncome + ctx.benefits,
            // Take-home cash. The pension pot is savings, not spendable income, so
            // it is reported separately rather than folded into net income.
            netIncome: ctx.cashIncome - ctx.pension.employeeOutlay - ctx.otherSacrifice
                - (totalTax - cbCredit - ccCredit)
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
        // Not used by the shipped UI, and it doesn't combine with the investments box.
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
            annualAllowanceExcess: ctx.annualAllowance.excess,
            investments: ctx.investments,
            rental: ctx.rental
        });
        const niDetails = niKey
            ? taxAndNi(ctx.niIncome, dataset, niKey, h, { mode: 'actual', collectDetails: true })
            : { total: 0, bands: [], adjustments: [], personalAllowance: null };

        const capitalGainsTax = incomeTaxDetails.capitalGainsTax;
        const totalTax = incomeTaxDetails.total + niDetails.total + ctx.employerNi + capitalGainsTax;
        const loanRepayments = incomeTaxDetails.adjustments
            .filter(a => a.label === 'Student loan').reduce((sum, a) => sum + a.amount, 0);
        const displayedTotalTax = totalTax - loanRepayments;
        const cashTakeHome = ctx.cashIncome - ctx.pension.employeeOutlay - ctx.otherSacrifice - totalTax;
        const totalIncome = ctx.cashIncome + ctx.benefits;
        const withoutPension = ctx.pension.gross > 0
            ? totals(income, dataset, household(Object.assign({}, h, { pensionContribution: 0 }))) : null;
        const pensionNetCost = withoutPension
            ? withoutPension.netIncome - (cashTakeHome + cbCredit + ccCredit) : 0;
        const adjustedTotalTax = totalTax - cbCredit - ccCredit - ctx.reliefAtSource;
        // An employee's payroll knows nothing of a personal pension, so relief beyond
        // the provider's basic-rate top-up arrives through Self Assessment or a tax code change.
        const reliefViaReturn = withoutPension && ctx.reliefAtSource > 0 && isEmployee(h)
            ? Math.max(0, withoutPension.totalTax - totalTax) : 0;

        return {
            income,
            cashIncome: ctx.cashIncome,
            totalIncome,
            netIncome: cashTakeHome + cbCredit + ccCredit,
            cashTakeHome,
            cashWithBenefits: cashTakeHome + cbCredit,
            loanRepayments,
            incomeTaxAmount: incomeTaxDetails.total - loanRepayments,
            savingsTax: incomeTaxDetails.savingsTax,
            dividendTax: incomeTaxDetails.dividendTax,
            capitalGainsTax,
            benefitsInKind: ctx.benefits,
            pensionIncome: ctx.pensionIncome,
            investments: ctx.investments,
            otherSacrifice: ctx.otherSacrifice,
            reliefViaReturn,
            taxRate: totalIncome === 0 ? 0 : displayedTotalTax / totalIncome * 100,
            pensionNetCost,
            adjustedNetIncome: ctx.aniIncome,
            totalTax: displayedTotalTax,
            effectiveRate: totalIncome === 0 ? 0 : (adjustedTotalTax / totalIncome) * 100,
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

    /**
     * How much more main income keeps adjusted net income at or below `threshold`,
     * searching up to `limit` more. Null if already over, or if `limit` isn't enough.
     */
    function headroom(income, dataset, h, threshold, limit) {
        if (!dataset) return null;
        return lastIncomeWhere(limit, extra => pensionContext(income + extra, dataset, h, 'actual').aniIncome <= threshold + EPSILON);
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
            out.effective.push(t.totalIncome === 0 ? 0 : (t.adjustedTax / t.totalIncome) * 100);
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
        isEmployee,
        requiresEmployerNiGrossDown,
        activeNiKey,
        activeStudentLoanPlan,
        loanComponents,
        // components
        transformIncomeForEmployment,
        benefitsInKind,
        pensionIncomeOf,
        investmentsOf,
        investmentTax,
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
        headroom,
        marriageAllowanceCliff,
        annualAllowanceCliff,
        validateDatasets
    };
}));
