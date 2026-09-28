# Sudan UNDP GIS Monitoring Dashboard

## Sources

- `Data/Master_data_as_sep26.xlsx` is the authoritative record source. `Sheet1` is the data sheet; `Sheet2` is not used because it contains a partial header/value fragment.
- `Geo_Data/sdn_admbnda_adm1_cbs_nic_ssa_download.geojson` supplies the 19 state boundary geometries.
- `Geo_Data/M_E_masterdata_by_state.geojson` is the generated record-level output consumed by the dashboard.

## Refresh the master GeoJSON

Install the one build dependency in the selected Python environment:

```powershell
python -m pip install openpyxl
```

Then run from the project root:

```powershell
python scripts/build_master_geojson.py
```

The script reads every row in `Sheet1`, preserves the workbook headers and duplicate rows, and writes:

- `Geo_Data/M_E_masterdata_by_state.geojson`
- `Data/master_data_validation.json`

Geometry matching uses the complete source row against the legacy master GeoJSON first. Rows without an exact legacy match fall back to the administrative boundary layer after state-name normalization (`Gedarif`/`Gedaref` and `Kartoum`/`Khartoum`). Unmatched or null-state rows remain in the output with `geometry: null` and are listed in the validation report.

## Dashboard behavior

Open `UI_Assests/map-dashboard.html` through a local web server. The page loads the generated GeoJSON and the administrative boundary GeoJSON. Filters operate on individual workbook records. State totals are temporary visualization values only: multi-state records are split across their named states, while duplicate source rows remain separate for record counts and project context.

## Share the dashboard

The dashboard is a static website. Upload the entire project folder, keeping `Data/`, `Geo_Data/`, `UI_Assests/`, and `index.html` together. Do not upload only the HTML file, because the dashboard also fetches the GeoJSON files.

For a quick shareable link, use Netlify Drop:

1. Open <https://app.netlify.com/drop> and sign in.
2. Drag the project folder onto the upload area.
3. Share the generated `netlify.app` URL. The root URL opens the dashboard automatically.

For an organization-managed link, publish the same folder with GitHub Pages or another static web host. The dashboard requires internet access for the Leaflet library and map tiles.

### GitHub Pages CI/CD

The repository includes `.github/workflows/deploy-pages.yml`. To enable it:

1. Create a GitHub repository and push the project to the `main` branch.
2. In the repository, open **Settings > Pages**.
3. Under **Build and deployment**, choose **GitHub Actions** as the source.
4. Push a change or run **Deploy dashboard to GitHub Pages** from the **Actions** tab.

Every push to `main` validates the dashboard files and GeoJSON, then publishes the latest version. GitHub will show the public URL in the workflow run and under **Settings > Pages**.

For local testing from the project root, run:

```powershell
python -m http.server 8000
```

Then open <http://localhost:8000/>.

The dashboard uses the actual workbook fields for pillar, project, intervention, state, locality, targets, and actuals. Direct target and actual KPI totals are row-level sums of the corresponding `Total` fields; achievement is actual divided by target. Map coloring uses the selected beneficiary/period/group field and dynamically calculated classes.

## Beneficiary analysis

The `Beneficiary Analysis` tab uses a single map with an indicator switcher rather than presenting several unrelated maps:

- Absolute total, female, male, and youth indicators use proportional circles by state because circle size communicates reach without implying that a large state has a higher rate.
- Female share, male share, and youth share use a light-to-dark choropleth because these are normalized comparisons.
- Gender balance uses a diverging scale: negative values indicate male-dominant records, positive values indicate female-dominant records, and values near zero are balanced.

Values are aggregated dynamically from record-level rows after splitting a multi-state record equally across its named states. This does not rewrite the master data. Shares use the reported `Total` field as denominator. Youth is treated as a reported age category that may overlap with sex categories; the dashboard does not assume `Female + Male + Youth = Total`.

The inspected workbook contains 313 rows, 308 non-null state values, and no latitude/longitude fields. Female and male fields are populated much more consistently than youth fields; youth values occur in only a minority of records. Six rows have no usable geometry because five have null state values and one contains an embedded `State` header-like value. Those rows remain in the generated GeoJSON but cannot be mapped.

The current default direct-target view covers 19 mapped states, totals 12,535,744 beneficiaries, and identifies Kassala as the highest-reach state at 4,533,698. These are beneficiary counts, not coverage rates: population or needs denominators are not present, so lower counts must not be described as under-service.

## Validation expectations

A successful refresh should report `source_records == output_features`, preserve 21 properties for each feature, and clearly list any null geometry rows. Duplicates are reported but not removed because they are valid record-level source data unless the workbook owner confirms otherwise.
