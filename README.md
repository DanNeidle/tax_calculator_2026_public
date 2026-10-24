# UK tax calculator 2026/27

A calculator from [Tax Policy Associates](https://taxpolicy.org.uk), showing cash take-home,
marginal rates, pensions and support withdrawn as income rises. 

## Run locally

```sh
python3 -m http.server 8000
```

Open [the local calculator](http://localhost:8000). Calculations run in your browser.
Vue and ECharts are served locally. The page also requests Poppins from Google Fonts;
it falls back to system fonts if that request fails.

## Calculation model

[The engine](taxEngine.js) has no browser or framework dependency. [The datasets](UK_marginal_tax_datasets.json)
contain rates, source links, dates and explicit assumptions. 

## Licence

Copyright Tax Policy Associates Ltd, 2026. [MIT licence](LICENSE).
Third-party code retains its own licences.
